import { afterEach, describe, expect, it } from 'bun:test';

import type { WorkflowEvent } from '../core/types.ts';
import { setPortableRuntimeTestOverridesForTesting } from '../runtime/portable.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import {
  openClientEventSubscription,
  type WorkflowEventStreamHost,
} from './open-event-subscription.ts';
import {
  parseServerSentEventChunk,
  SseWorkflowEventSubscription,
  workflowEventsSseUrl,
} from './sse-event-stream.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setPortableRuntimeTestOverridesForTesting();
});

function eventStreamResponse(body: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    },
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function controllableEventStreamResponse(): {
  readonly response: Response;
  enqueue(body: string): void;
  close(): void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    },
  );

  return {
    response,
    enqueue(body) {
      if (controller === null) throw new Error('SSE stream controller was not initialized');
      controller.enqueue(new TextEncoder().encode(body));
    },
    close() {
      controller?.close();
    },
  };
}

function envelopeFrame(cursor: string, kind = 'workflow:completed', workflowId = 'wf-sse'): string {
  return (
    `id: ${cursor}\n` +
    `event: ${kind}\n` +
    `data: {"kind":"${kind}","workflowId":"${workflowId}","selector":"events","sequence":${cursor},"cursor":"${cursor}","emittedAtMs":123,"payload":{"workflowId":"${workflowId}"}}\n\n`
  );
}

describe('workflowEventsSseUrl', () => {
  it('targets the workflow event SSE endpoint without rewriting the scheme', () => {
    expect(workflowEventsSseUrl('http://localhost:7233', 'a/b')).toBe(
      'http://localhost:7233/v1/workflows/a%2Fb/events/sse',
    );
    expect(workflowEventsSseUrl('/weft', 'wf-1')).toBe('/weft/v1/workflows/wf-1/events/sse');
  });
});

describe('parseServerSentEventChunk', () => {
  it('parses multiline data, comments, ids, and named events', () => {
    const parsed = parseServerSentEventChunk(
      ': ignored\nid: 7\nevent: workflow:started\ndata: first\ndata: second\n\n',
    );

    expect(parsed.frames).toEqual([
      {
        id: '7',
        event: 'workflow:started',
        data: 'first\nsecond',
      },
    ]);
    expect(parsed.remainder).toBe('');
  });
});

describe('SseWorkflowEventSubscription', () => {
  it('streams events through fetch with auth headers and ignores ping frames', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: requestUrl(input), headers: new Headers(init?.headers) });
      return eventStreamResponse(
        'event: ping\ndata: {"emittedAtMs":1}\n\n' + envelopeFrame('0', 'workflow:completed'),
      );
    }) as typeof fetch;

    const received: WorkflowEvent[] = [];
    const subscription = new SseWorkflowEventSubscription(
      'http://localhost:7233/v1/workflows/wf-sse/events/sse',
      { Authorization: 'Bearer token' },
      'wf-sse',
      (event) => received.push(event),
      { bufferForIteration: true },
    );

    await subscription.whenConnected();
    const events: WorkflowEvent[] = [];
    for await (const event of subscription) {
      events.push(event);
    }

    expect(requests[0]?.url).toBe('http://localhost:7233/v1/workflows/wf-sse/events/sse');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer token');
    expect(requests[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(received.map((event) => event.type)).toEqual(['workflow:completed']);
    expect(events.map((event) => event.type)).toEqual(['workflow:completed']);
  });

  it('reconnects with Last-Event-ID after a non-terminal disconnect', async () => {
    const requestHeaders: Headers[] = [];
    let callCount = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders.push(new Headers(init?.headers));
      callCount += 1;
      if (callCount === 1) {
        return eventStreamResponse(envelopeFrame('2', 'workflow:started'));
      }
      return eventStreamResponse(envelopeFrame('3', 'workflow:completed'));
    }) as typeof fetch;

    const received: WorkflowEvent[] = [];
    const subscription = new SseWorkflowEventSubscription(
      'http://localhost:7233/v1/workflows/wf-sse/events/sse',
      {},
      'wf-sse',
      (event) => received.push(event),
      { reconnectBackoffMs: 0 },
    );

    await subscription.whenConnected();
    await waitForCondition(() => received.length >= 2, {
      label: 'SSE reconnect events delivered',
    });

    expect(requestHeaders[0]?.has('Last-Event-ID')).toBe(false);
    expect(requestHeaders[1]?.get('Last-Event-ID')).toBe('2');
    expect(received.map((event) => event.type)).toEqual(['workflow:started', 'workflow:completed']);
    subscription.close();
  });

  it('ignores malformed frames and events for another workflow without advancing reconnect cursors', async () => {
    const requestHeaders: Headers[] = [];
    let callCount = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders.push(new Headers(init?.headers));
      callCount += 1;
      if (callCount === 1) {
        return eventStreamResponse(
          'event: workflow:started\ndata: not-json\n\n' +
            envelopeFrame('5', 'workflow:started', 'wf-other') +
            envelopeFrame('6', 'workflow:started'),
        );
      }
      return eventStreamResponse(envelopeFrame('7', 'workflow:completed'));
    }) as typeof fetch;

    const received: WorkflowEvent[] = [];
    const subscription = new SseWorkflowEventSubscription(
      'http://localhost:7233/v1/workflows/wf-sse/events/sse',
      {},
      'wf-sse',
      (event) => received.push(event),
      { reconnectBackoffMs: 0 },
    );

    await subscription.whenConnected();
    await waitForCondition(() => received.length >= 2, {
      label: 'SSE filtered reconnect events delivered',
    });

    expect(requestHeaders[1]?.get('Last-Event-ID')).toBe('6');
    expect(received.map((event) => event.type)).toEqual(['workflow:started', 'workflow:completed']);
    subscription.close();
  });

  it('aborts the active fetch when closed', async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>(), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    }) as typeof fetch;

    const subscription = new SseWorkflowEventSubscription(
      'http://localhost:7233/v1/workflows/wf-sse/events/sse',
      {},
      'wf-sse',
      () => {},
    );

    await waitForCondition(() => capturedSignal !== undefined, {
      label: 'SSE fetch signal captured',
    });
    subscription.close();

    expect(capturedSignal?.aborted).toBe(true);
    expect(subscription.closeReason).toBe('client-closed');
  });

  it('resolves whenConnected once an idle SSE response is established', async () => {
    const stream = controllableEventStreamResponse();
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      stream.response) as typeof fetch;

    const subscription = new SseWorkflowEventSubscription(
      'http://localhost:7233/v1/workflows/wf-sse/events/sse',
      {},
      'wf-sse',
      () => {},
    );
    let connected = false;
    void subscription.whenConnected().then(() => {
      connected = true;
    });

    await waitForCondition(() => connected, {
      label: 'idle SSE connection established',
    });

    subscription.close();
    stream.close();
  });

  it('wakes an iterator that starts before the first SSE event arrives', async () => {
    const stream = controllableEventStreamResponse();
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      stream.response) as typeof fetch;

    const subscription = new SseWorkflowEventSubscription(
      'http://localhost:7233/v1/workflows/wf-sse/events/sse',
      {},
      'wf-sse',
      () => {},
      { bufferForIteration: true },
    );
    const iterator = subscription[Symbol.asyncIterator]();
    const nextEvent = iterator.next();

    await subscription.whenConnected();
    stream.enqueue(envelopeFrame('0', 'workflow:completed'));
    stream.close();

    const result = await nextEvent;
    expect(result.done).toBe(false);
    expect(result.value?.type).toBe('workflow:completed');
  });

  it('forced SSE transport opens the SSE endpoint directly', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      requests.push(requestUrl(input));
      return eventStreamResponse(envelopeFrame('0', 'workflow:completed'));
    }) as typeof fetch;
    const host: WorkflowEventStreamHost = {
      baseUrl: 'http://localhost:7233',
      headers: {},
      async getEvents() {
        throw new Error('SSE transport should not fetch WebSocket catch-up history');
      },
    };

    const subscription = openClientEventSubscription(
      host,
      { eventTransport: 'sse' },
      'wf-sse',
      () => {},
      true,
    );

    await subscription.whenConnected();

    expect(requests).toEqual(['http://localhost:7233/v1/workflows/wf-sse/events/sse']);
    subscription.close();
  });

  it('auto transport falls back to SSE when WebSocket construction fails', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      eventStreamResponse(envelopeFrame('0', 'workflow:completed'))) as typeof fetch;
    const received: WorkflowEvent[] = [];
    const host: WorkflowEventStreamHost = {
      baseUrl: 'http://localhost:7233',
      headers: { Authorization: 'Bearer token' },
      async getEvents() {
        return [];
      },
    };

    const subscription = openClientEventSubscription(
      host,
      {
        eventTransport: 'auto',
        webSocketFactory() {
          throw new Error('WebSocket headers unavailable');
        },
      },
      'wf-sse',
      (event) => received.push(event),
      true,
    );

    await subscription.whenConnected();
    await waitForCondition(() => received.length > 0, {
      label: 'SSE auto fallback event delivered',
    });

    expect(received.map((event) => event.type)).toEqual(['workflow:completed']);
    subscription.close();
  });

  it('auto transport prefers SSE on non-Bun runtimes when auth headers would be dropped', async () => {
    setPortableRuntimeTestOverridesForTesting({
      bun: undefined,
      process: undefined,
      window: {} as typeof globalThis.window,
      document: undefined,
    });
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: requestUrl(input), headers: new Headers(init?.headers) });
      return eventStreamResponse(envelopeFrame('0', 'workflow:completed'));
    }) as typeof fetch;
    const host: WorkflowEventStreamHost = {
      baseUrl: 'http://localhost:7233',
      headers: { Authorization: 'Bearer token' },
      async getEvents() {
        throw new Error('SSE fallback should not fetch WebSocket catch-up history');
      },
    };
    const received: WorkflowEvent[] = [];

    const subscription = openClientEventSubscription(
      host,
      { eventTransport: 'auto' },
      'wf-sse',
      (event) => received.push(event),
      true,
    );

    await subscription.whenConnected();
    await waitForCondition(() => received.length > 0, {
      label: 'non-Bun SSE auto fallback event delivered',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://localhost:7233/v1/workflows/wf-sse/events/sse');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer token');
    expect(received.map((event) => event.type)).toEqual(['workflow:completed']);
    subscription.close();
  });

  it('exhausts reconnects for repeated empty event-stream responses', async () => {
    let callCount = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      callCount += 1;
      return eventStreamResponse('');
    }) as typeof fetch;

    const subscription = new SseWorkflowEventSubscription(
      'http://localhost:7233/v1/workflows/wf-sse/events/sse',
      {},
      'wf-sse',
      () => {},
      { maxReconnectAttempts: 2, reconnectBackoffMs: 0 },
    );

    await waitForCondition(() => subscription.closeReason === 'reconnect-exhausted', {
      label: 'empty SSE reconnect attempts exhausted',
    });

    expect(callCount).toBe(3);
  });

  it('treats an SSE error frame as a terminal stream close', async () => {
    const signals: AbortSignal[] = [];
    let callCount = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      if (init?.signal instanceof AbortSignal) signals.push(init.signal);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: error\ndata: {"code":"InvalidParams","message":"bad"}\n\n',
              ),
            );
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        },
      );
    }) as typeof fetch;

    const received: WorkflowEvent[] = [];
    const subscription = new SseWorkflowEventSubscription(
      'http://localhost:7233/v1/workflows/wf-sse/events/sse',
      {},
      'wf-sse',
      (event) => received.push(event),
      { reconnectBackoffMs: 0 },
    );
    const iterator = subscription[Symbol.asyncIterator]();

    await waitForCondition(() => subscription.closeReason === 'server-error', {
      label: 'SSE error frame closed subscription',
    });

    const iteratorResult = await iterator.next();

    expect(callCount).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(iteratorResult.done).toBe(true);
    expect(received).toEqual([]);
  });

  it('auto transport rethrows unexpected WebSocket construction errors', () => {
    const host: WorkflowEventStreamHost = {
      baseUrl: 'http://localhost:7233',
      headers: {},
      async getEvents() {
        return [];
      },
    };

    expect(() =>
      openClientEventSubscription(
        host,
        {
          eventTransport: 'auto',
          webSocketFactory() {
            throw new Error('unexpected constructor bug');
          },
        },
        'wf-sse',
        () => {},
        true,
      ),
    ).toThrow('unexpected constructor bug');
  });
});
