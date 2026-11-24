import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { Webhook } from 'standardwebhooks';

import type {
  ApplicationDeliveryReceipt,
  ApplicationDeliverySendRequest,
} from '../core/outbox-contract.ts';
import { createEgressPolicy, type EgressPolicy } from '../runtime/egress-policy.ts';
import { TestReceiver } from '../testing/webhook-receiver.test-support.ts';
import {
  createHttpDeliveryAdapter,
  createHttpDeliveryAdapterWithRuntime,
  type HttpDeliveryAdapterOptions,
  type HttpDeliveryCredential,
  isHttpDeliveryAdapter,
  parseRetryAfter,
} from './http-delivery-adapter.ts';

const SECRET_A = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const SECRET_B = 'whsec_c2Vjb25kLXNpZ25pbmctc2VjcmV0LWZvci1yb3RhdGlvbg==';

const receivers: TestReceiver[] = [];
const servers: Array<{ stop(force?: boolean): unknown }> = [];

afterEach(async () => {
  for (const receiver of receivers.splice(0)) await receiver.close();
  for (const server of servers.splice(0)) await server.stop(true);
});

async function startReceiver(): Promise<TestReceiver> {
  const receiver = new TestReceiver();
  receivers.push(receiver);
  return receiver;
}

function loopbackPolicy(...hosts: string[]): EgressPolicy {
  return createEgressPolicy({ allowInsecureHttp: true, allowlist: hosts, resolveHost: null });
}

function sendRequest(
  overrides: {
    readonly delivery?: Partial<ApplicationDeliveryReceipt>;
    readonly credentialRef?: string | undefined;
    readonly signal?: AbortSignal;
    readonly payload?: ApplicationDeliverySendRequest['payload'];
  } = {},
): ApplicationDeliverySendRequest {
  return {
    delivery: {
      deliveryId: 'delivery-1',
      destinationRef: 'destination-1',
      ...overrides.delivery,
    } as ApplicationDeliveryReceipt,
    payload: overrides.payload ?? {
      form: 'inline',
      value: { statusUpdate: { taskId: 'task-1', contextId: 'context-1' } },
      digest: 'digest',
      verified: true,
    },
    credentialRef: 'credentialRef' in overrides ? overrides.credentialRef : 'credential-1',
    attemptToken: 'attempt-1',
    signal: overrides.signal ?? new AbortController().signal,
  };
}

function adapterFor(
  receiver: TestReceiver,
  options: Partial<HttpDeliveryAdapterOptions> & {
    credential?: HttpDeliveryCredential | undefined;
  } = {},
) {
  return createHttpDeliveryAdapter({
    resolveDestination: () => receiver.url(),
    resolveCredential: () => options.credential ?? {},
    egressPolicy: loopbackPolicy(receiver.host),
    ...options,
  });
}

/** A scheduler whose timers fire only when the test says so. */
function manualScheduler() {
  const timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule(callback: () => void, delayMs: number) {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fire() {
      for (const timer of timers.filter((entry) => !entry.cancelled)) timer.callback();
    },
  };
}

describe('createHttpDeliveryAdapter requests', () => {
  test('POSTs the JSON payload as application/a2a+json with the Authorization header', async () => {
    const receiver = await startReceiver();
    const adapter = adapterFor(receiver, {
      credential: { scheme: 'Bearer', credentials: 'secret-token' },
    });

    const outcome = await adapter.send(sendRequest());

    expect(outcome).toEqual({ status: 'acknowledged', evidence: { status: 200 } });
    const request = await receiver.nextRequest(0);
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/hook');
    expect(request.headers['content-type']).toBe('application/a2a+json');
    expect(request.headers['authorization']).toBe('Bearer secret-token');
    expect(JSON.parse(request.body)).toEqual({
      statusUpdate: { taskId: 'task-1', contextId: 'context-1' },
    });
  });

  test('carries the configuration token as X-A2A-Notification-Token beside Authorization', async () => {
    const receiver = await startReceiver();
    const withToken = adapterFor(receiver, {
      signingSecrets: [SECRET_A],
      credential: {
        scheme: 'Bearer',
        credentials: 'secret-token',
        notificationToken: 'client-token',
      },
    });
    const withoutToken = adapterFor(receiver, {
      credential: { scheme: 'Bearer', credentials: 'secret-token' },
    });

    await withToken.send(sendRequest());
    await withoutToken.send(sendRequest());

    const [first, second] = [await receiver.nextRequest(0), await receiver.nextRequest(1)];
    expect(first.headers['x-a2a-notification-token']).toBe('client-token');
    expect(first.headers['authorization']).toBe('Bearer secret-token');
    expect(first.headers['webhook-signature']).toStartWith('v1,');
    expect(second.headers['x-a2a-notification-token']).toBeUndefined();
    expect(second.headers['authorization']).toBe('Bearer secret-token');
  });

  test('sends neither header when there is no credential reference or credential', async () => {
    const receiver = await startReceiver();
    const adapter = adapterFor(receiver, {
      resolveCredential: () => {
        throw new Error('A delivery without a credential reference resolves no credential.');
      },
    });
    await adapter.send(sendRequest({ credentialRef: undefined }));
    await adapterFor(receiver, { credential: { notificationToken: '' } }).send(sendRequest());
    for (const index of [0, 1]) {
      const request = await receiver.nextRequest(index);
      expect(request.headers['authorization']).toBeUndefined();
      expect(request.headers['x-a2a-notification-token']).toBeUndefined();
    }
  });

  test('sends the delivery traceparent', async () => {
    const receiver = await startReceiver();
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await adapterFor(receiver).send(sendRequest({ delivery: { causation: { traceparent } } }));
    expect(await receiver.nextRequest(0)).toMatchObject({ headers: { traceparent: traceparent } });
  });

  test('rejects a reference payload without a request', async () => {
    const receiver = await startReceiver();
    const outcome = await adapterFor(receiver).send(
      sendRequest({
        payload: { form: 'reference', reference: 'blob:1', digest: 'd', verified: false },
      }),
    );
    expect(outcome.status).toBe('rejected');
    expect(receiver.requests).toHaveLength(0);
  });

  test('rejects a credential that cannot be a header value without a request', async () => {
    const receiver = await startReceiver();
    const outcome = await adapterFor(receiver, {
      credential: { scheme: 'Bearer', credentials: 'line\nbreak' },
    }).send(sendRequest());
    expect(outcome.status).toBe('rejected');
    expect(receiver.requests).toHaveLength(0);
  });
});

describe('createHttpDeliveryAdapter Standard Webhooks signatures', () => {
  test('signs with webhook-id, webhook-timestamp, and a v1 signature the official verifier accepts', async () => {
    const receiver = await startReceiver();
    const adapter = adapterFor(receiver, { signingSecrets: [SECRET_A] });

    await adapter.send(sendRequest({ delivery: { externalIdempotencyKey: 'msg_stable' } }));

    const request = await receiver.nextRequest(0);
    expect(request.headers['webhook-id']).toBe('msg_stable');
    expect(request.headers['webhook-timestamp']).toMatch(/^\d+$/);
    expect(request.headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(new Webhook(SECRET_A).verify(request.body, request.headers)).toEqual(
      JSON.parse(request.body),
    );
  });

  test('uses the delivery identifier as webhook-id when there is no external idempotency key', async () => {
    const receiver = await startReceiver();
    await adapterFor(receiver, { signingSecrets: [SECRET_A] }).send(sendRequest());
    const request = await receiver.nextRequest(0);
    expect(request.headers['webhook-id']).toBe('delivery-1');
    expect(() => new Webhook(SECRET_A).verify(request.body, request.headers)).not.toThrow();
  });

  test('with two secrets, a receiver holding either one verifies', async () => {
    const receiver = await startReceiver();
    await adapterFor(receiver, { signingSecrets: [SECRET_A, SECRET_B] }).send(sendRequest());
    const request = await receiver.nextRequest(0);
    expect(request.headers['webhook-signature']!.split(' ')).toHaveLength(2);
    expect(() => new Webhook(SECRET_A).verify(request.body, request.headers)).not.toThrow();
    expect(() => new Webhook(SECRET_B).verify(request.body, request.headers)).not.toThrow();
    expect(() =>
      new Webhook('whsec_dW5yZWxhdGVkLXNlY3JldA==').verify(request.body, request.headers),
    ).toThrow();
  });

  test('without signing secrets, sends webhook-id as idempotency evidence and no signature', async () => {
    const receiver = await startReceiver();
    const adapter = adapterFor(receiver);
    await adapter.send(sendRequest({ delivery: { externalIdempotencyKey: 'msg_stable' } }));
    await adapter.send(sendRequest());
    const [keyed, unkeyed] = [await receiver.nextRequest(0), await receiver.nextRequest(1)];
    expect(keyed.headers['webhook-id']).toBe('msg_stable');
    expect(unkeyed.headers['webhook-id']).toBe('delivery-1');
    for (const request of [keyed, unkeyed]) {
      expect(request.headers['webhook-timestamp']).toBeUndefined();
      expect(request.headers['webhook-signature']).toBeUndefined();
    }
  });

  test('stamps webhook-timestamp from its clock in seconds', async () => {
    const receiver = await startReceiver();
    const adapter = createHttpDeliveryAdapterWithRuntime(
      {
        resolveDestination: () => receiver.url(),
        resolveCredential: () => ({}),
        signingSecrets: [SECRET_A],
        egressPolicy: loopbackPolicy(receiver.host),
      },
      { schedule: manualScheduler().schedule, now: () => 1_700_000_000_999 },
    );
    await adapter.send(sendRequest());
    expect(await receiver.nextRequest(0)).toMatchObject({
      headers: { 'webhook-timestamp': '1700000000' },
    });
  });
});

describe('createHttpDeliveryAdapter egress', () => {
  test('rejects a blocked destination before any request', async () => {
    const receiver = await startReceiver();
    const adapter = adapterFor(receiver, {
      egressPolicy: createEgressPolicy({ allowInsecureHttp: true, resolveHost: null }),
    });
    const outcome = await adapter.send(sendRequest());
    expect(outcome).toMatchObject({
      status: 'rejected',
      message: expect.stringMatching(/loopback/),
    });
    expect(receiver.requests).toHaveLength(0);
  });

  test('delivers to an allowlisted loopback receiver', async () => {
    const receiver = await startReceiver();
    expect(await adapterFor(receiver).send(sendRequest())).toMatchObject({
      status: 'acknowledged',
    });
    expect(receiver.requests).toHaveLength(1);
  });

  test('a DNS failure before sending is retryable', async () => {
    const adapter = createHttpDeliveryAdapter({
      resolveDestination: () => 'https://hooks.example.com/hook',
      resolveCredential: () => ({}),
      egressPolicy: createEgressPolicy({
        resolveHost: async () => {
          throw new Error('getaddrinfo ENOTFOUND hooks.example.com');
        },
      }),
    });
    expect(await adapter.send(sendRequest())).toMatchObject({
      status: 'retryable',
      message: expect.stringMatching(/ENOTFOUND/),
    });
  });

  test('a destination that no longer exists is rejected without a request', async () => {
    const receiver = await startReceiver();
    const outcome = await adapterFor(receiver, { resolveDestination: () => undefined }).send(
      sendRequest(),
    );
    expect(outcome).toEqual({ status: 'rejected', message: 'The destination no longer exists.' });
    expect(receiver.requests).toHaveLength(0);
  });

  test('a named credential that no longer exists is rejected without a request', async () => {
    const receiver = await startReceiver();
    const outcome = await adapterFor(receiver, { resolveCredential: () => undefined }).send(
      sendRequest(),
    );
    expect(outcome).toEqual({ status: 'rejected', message: 'The credential no longer exists.' });
    expect(receiver.requests).toHaveLength(0);
  });

  test('a resolver that fails is retryable, because nothing was sent', async () => {
    const receiver = await startReceiver();
    const failingDestination = await adapterFor(receiver, {
      resolveDestination: async () => {
        throw new Error('store unavailable');
      },
    }).send(sendRequest());
    const failingCredential = await adapterFor(receiver, {
      resolveCredential: () => {
        throw 'vault sealed';
      },
    }).send(sendRequest());
    expect(failingDestination).toMatchObject({
      status: 'retryable',
      message: expect.stringMatching(/store unavailable/),
    });
    expect(failingCredential).toMatchObject({
      status: 'retryable',
      message: expect.stringMatching(/vault sealed/),
    });
    expect(receiver.requests).toHaveLength(0);
  });
});

describe('createHttpDeliveryAdapter classification', () => {
  test('2xx is acknowledged', async () => {
    const receiver = await startReceiver();
    receiver.reply(202).reply(204);
    const adapter = adapterFor(receiver);
    expect(await adapter.send(sendRequest())).toEqual({
      status: 'acknowledged',
      evidence: { status: 202 },
    });
    expect(await adapter.send(sendRequest())).toEqual({
      status: 'acknowledged',
      evidence: { status: 204 },
    });
  });

  test('a response is classified by its status even when discarding its body fails', async () => {
    const erroredBody = () =>
      new ReadableStream({
        start(controller) {
          controller.error(new Error('The body stream broke.'));
        },
      });
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(erroredBody(), { status: 200 }))
      .mockResolvedValueOnce(new Response(erroredBody(), { status: 404 }));
    try {
      const adapter = createHttpDeliveryAdapter({
        resolveDestination: () => 'https://hooks.example.com/hook',
        resolveCredential: () => ({}),
        egressPolicy: createEgressPolicy({ resolveHost: async () => ['93.184.216.34'] }),
      });
      expect(await adapter.send(sendRequest())).toEqual({
        status: 'acknowledged',
        evidence: { status: 200 },
      });
      expect(await adapter.send(sendRequest())).toEqual({
        status: 'rejected',
        message: 'The receiver answered 404.',
        details: { status: 404 },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test.each([
    ['a code on the error itself', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })],
    [
      'a code on its cause',
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
      }),
    ],
    [
      'a code two causes down',
      new TypeError('fetch failed', {
        cause: new Error('wrapped', { cause: { code: 'ConnectionRefused' } }),
      }),
    ],
  ])('a connection that never opened (%s) is retryable', async (_label, error) => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValueOnce(error);
    try {
      const adapter = createHttpDeliveryAdapter({
        resolveDestination: () => 'https://hooks.example.com/hook',
        resolveCredential: () => ({}),
        egressPolicy: createEgressPolicy({ resolveHost: async () => ['93.184.216.34'] }),
      });
      expect(await adapter.send(sendRequest())).toMatchObject({
        status: 'retryable',
        message: expect.stringMatching(/^The connection was not opened/),
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test.each([
    [
      'no code anywhere in the cause chain',
      new TypeError('fetch failed', { cause: new Error('x') }),
    ],
    ['a cause that is not an object', new TypeError('fetch failed', { cause: 'ECONNREFUSED' })],
    [
      'a code that does not mean the connection never opened',
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    ],
  ])(
    'a request that failed with %s is unknown, because it may have been sent',
    async (_label, error) => {
      const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValueOnce(error);
      try {
        const adapter = createHttpDeliveryAdapter({
          resolveDestination: () => 'https://hooks.example.com/hook',
          resolveCredential: () => ({}),
          egressPolicy: createEgressPolicy({ resolveHost: async () => ['93.184.216.34'] }),
        });
        expect(await adapter.send(sendRequest())).toMatchObject({
          status: 'unknown',
          message: expect.stringMatching(/^The request failed after it began/),
        });
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  test('a 3xx is rejected and the redirect is not followed', async () => {
    const receiver = await startReceiver();
    const target = await startReceiver();
    receiver.reply(307, { location: target.url('/elsewhere') });
    const adapter = adapterFor(receiver, {
      egressPolicy: loopbackPolicy(receiver.host, target.host),
    });
    expect(await adapter.send(sendRequest())).toMatchObject({
      status: 'rejected',
      details: { status: 307 },
    });
    expect(target.requests).toHaveLength(0);
  });

  for (const status of [408, 429, 500, 503]) {
    test(`${status} is retryable`, async () => {
      const receiver = await startReceiver();
      receiver.reply(status);
      expect(await adapterFor(receiver).send(sendRequest())).toEqual({
        status: 'retryable',
        message: `The receiver answered ${status}.`,
        details: { status },
        retryAfterMs: undefined,
      });
    });
  }

  test('a Retry-After in delta-seconds is honored', async () => {
    const receiver = await startReceiver();
    receiver.reply(503, { 'retry-after': '120' });
    expect(await adapterFor(receiver).send(sendRequest())).toMatchObject({
      status: 'retryable',
      retryAfterMs: 120_000,
    });
  });

  test('a Retry-After HTTP-date is honored against the adapter clock', async () => {
    const receiver = await startReceiver();
    const now = Date.parse('2026-10-17T12:00:00Z');
    receiver.reply(429, { 'retry-after': 'Sat, 17 Oct 2026 12:05:00 GMT' });
    const adapter = createHttpDeliveryAdapterWithRuntime(
      {
        resolveDestination: () => receiver.url(),
        resolveCredential: () => ({}),
        egressPolicy: loopbackPolicy(receiver.host),
      },
      { schedule: manualScheduler().schedule, now: () => now },
    );
    expect(await adapter.send(sendRequest())).toMatchObject({
      status: 'retryable',
      retryAfterMs: 300_000,
    });
  });

  test('Retry-After is capped at 3600 seconds', async () => {
    const receiver = await startReceiver();
    receiver.reply(503, { 'retry-after': '86400' });
    expect(await adapterFor(receiver).send(sendRequest())).toMatchObject({
      retryAfterMs: 3_600_000,
    });
  });

  for (const status of [400, 401, 404, 410]) {
    test(`${status} is rejected`, async () => {
      const receiver = await startReceiver();
      receiver.reply(status);
      expect(await adapterFor(receiver).send(sendRequest())).toEqual({
        status: 'rejected',
        message: `The receiver answered ${status}.`,
        details: { status },
      });
    });
  }

  test('connection refused is retryable', async () => {
    const closed = new TestReceiver();
    const { host } = closed;
    const url = closed.url();
    await closed.close();
    const adapter = createHttpDeliveryAdapter({
      resolveDestination: () => url,
      resolveCredential: () => ({}),
      egressPolicy: loopbackPolicy(host),
    });
    expect(await adapter.send(sendRequest())).toMatchObject({
      status: 'retryable',
      message: expect.stringMatching(/not opened/),
    });
  });

  test('a connection reset after the request was sent is unknown', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket) {
          socket.terminate();
        },
      },
    });
    servers.push(listener);
    const host = `127.0.0.1:${listener.port}`;
    const adapter = createHttpDeliveryAdapter({
      resolveDestination: () => `http://${host}/hook`,
      resolveCredential: () => ({}),
      egressPolicy: loopbackPolicy(host),
    });
    expect(await adapter.send(sendRequest())).toMatchObject({
      status: 'unknown',
      message: expect.stringMatching(/after it began/),
    });
  });

  test('a timeout after the request was sent is unknown', async () => {
    const receiver = await startReceiver();
    receiver.hold();
    const scheduler = manualScheduler();
    const adapter = createHttpDeliveryAdapterWithRuntime(
      {
        resolveDestination: () => receiver.url(),
        resolveCredential: () => ({}),
        egressPolicy: loopbackPolicy(receiver.host),
        timeoutMs: 15_000,
      },
      { schedule: scheduler.schedule, now: () => Date.now() },
    );
    const sending = adapter.send(sendRequest());
    await receiver.nextRequest(0);
    expect(scheduler.timers.map((timer) => timer.delayMs)).toEqual([15_000]);
    scheduler.fire();
    expect(await sending).toEqual({ status: 'unknown', message: 'The request timed out.' });
    await receiver.nextAbandoned();
  });

  test('an abort from the outbox after the request was sent is unknown', async () => {
    const receiver = await startReceiver();
    receiver.hold();
    const controller = new AbortController();
    const sending = adapterFor(receiver).send(sendRequest({ signal: controller.signal }));
    await receiver.nextRequest(0);
    controller.abort(new Error('cancelled'));
    expect(await sending).toEqual({ status: 'unknown', message: 'The request was aborted.' });
  });

  test('cancels its timer once the request settles', async () => {
    const receiver = await startReceiver();
    const scheduler = manualScheduler();
    const adapter = createHttpDeliveryAdapterWithRuntime(
      {
        resolveDestination: () => receiver.url(),
        resolveCredential: () => ({}),
        egressPolicy: loopbackPolicy(receiver.host),
      },
      { schedule: scheduler.schedule, now: () => Date.now() },
    );
    await adapter.send(sendRequest());
    expect(scheduler.timers.map((timer) => timer.cancelled)).toEqual([true]);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');

  test('reads delta-seconds and HTTP-dates, clamps the past to zero, and caps at an hour', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter(' 5 ', now)).toBe(5000);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('Sat, 17 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('Sun, 18 Oct 2026 12:00:00 GMT', now)).toBe(3_600_000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
  });
});

describe('createHttpDeliveryAdapter construction', () => {
  const base: HttpDeliveryAdapterOptions = {
    resolveDestination: () => 'https://hooks.example.com/',
    resolveCredential: () => ({}),
    egressPolicy: createEgressPolicy(),
  };

  test('timeoutMs defaults to 10000 and accepts 10000 through 30000', () => {
    expect(createHttpDeliveryAdapter(base).timeoutMs).toBe(10_000);
    expect(createHttpDeliveryAdapter({ ...base, timeoutMs: 30_000 }).timeoutMs).toBe(30_000);
  });

  test('timeoutMs outside 10000–30000 throws', () => {
    for (const timeoutMs of [9_999, 30_001, 0, -1, 12_000.5, Number.NaN]) {
      expect(() => createHttpDeliveryAdapter({ ...base, timeoutMs })).toThrow(RangeError);
    }
  });

  test('signingSecrets must be a non-empty list of whsec_ base64 secrets', () => {
    expect(() => createHttpDeliveryAdapter({ ...base, signingSecrets: [] })).toThrow(/non-empty/);
    expect(() =>
      createHttpDeliveryAdapter({ ...base, signingSecrets: ['MfKQ9r8GKYqrTwjU'] }),
    ).toThrow(/whsec_/);
    expect(() => createHttpDeliveryAdapter({ ...base, signingSecrets: ['whsec_***'] })).toThrow(
      /base64/,
    );
    expect(() => createHttpDeliveryAdapter({ ...base, signingSecrets: ['whsec_'] })).toThrow(
      /empty/,
    );
  });

  test('egressPolicy is required', () => {
    expect(() =>
      createHttpDeliveryAdapter({ ...base, egressPolicy: undefined as unknown as EgressPolicy }),
    ).toThrow(/egressPolicy/);
  });

  test('brands what it creates and nothing else', () => {
    expect(isHttpDeliveryAdapter(createHttpDeliveryAdapter(base))).toBe(true);
    expect(
      isHttpDeliveryAdapter({ timeoutMs: 10_000, send: async () => ({ status: 'acknowledged' }) }),
    ).toBe(false);
    expect(isHttpDeliveryAdapter(undefined)).toBe(false);
  });
});
