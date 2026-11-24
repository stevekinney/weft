import { describe, expect, test } from 'bun:test';

import { StreamResponse } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Webhook } from 'standardwebhooks';

import { canonicalJson } from "../embedded/backchannel/src/internals.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { Outbox } from '../core/outbox.ts';
import {
  callContext,
  contextWithHeaders,
  createConfiguration,
  createPushFixture,
  NAMESPACE,
  SIGNING_SECRET,
  statusEvent,
  usePushFixtures,
} from './push-delivery.test-support.ts';
import {
  A2A_PUSH_DELIVERY_KIND,
  createOutboxPushNotificationSender,
  pushDestinationRef,
  pushNotificationResolvers,
} from './push-notification-sender.ts';
import { pushConfigurationCreatePlannerOf } from './push-notification-store.ts';

usePushFixtures();

function digestOf(event: StreamResponse): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(StreamResponse.toJSON(event)))));
}

const alice = () => callContext({ user: 'alice' });

describe('createOutboxPushNotificationSender enqueueing', () => {
  test('stores no URL, token, or credential on the outbox record, and sends them on delivery', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);

    await fixture.sender.send(statusEvent(1), alice());

    const outboxRecords: string[] = [];
    for await (const [key, value] of fixture.storage.scan('')) {
      if (!key.startsWith('a2a:')) outboxRecords.push(new TextDecoder().decode(value));
    }
    expect(outboxRecords.length).toBeGreaterThan(0);
    for (const text of outboxRecords) {
      expect(text).not.toContain('credential-secret');
      expect(text).not.toContain('token-secret');
      expect(text).not.toContain(fixture.receiver.url());
    }

    expect(await fixture.outbox.deliverNext()).toMatchObject({ status: 'settled' });
    const request = await fixture.receiver.nextRequest(0);
    expect(request.headers['authorization']).toBe('Bearer credential-secret');
    expect(request.headers['x-a2a-notification-token']).toBe('token-secret');
    expect(request.headers['content-type']).toBe('application/a2a+json');
    expect(JSON.parse(request.body)).toEqual(StreamResponse.toJSON(statusEvent(1)) as object);
  });

  test('a configuration without a token sends no token header', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture, { token: '' });
    await fixture.sender.send(statusEvent(1), alice());
    await fixture.outbox.deliverNext();
    const request = await fixture.receiver.nextRequest(0);
    expect(request.headers['x-a2a-notification-token']).toBeUndefined();
    expect(request.headers['authorization']).toBe('Bearer credential-secret');
  });

  test('enqueues with retry-with-idempotency, eight attempts, and the event-digest idempotency key', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);

    await fixture.sender.send(statusEvent(1), alice());

    const [receipt] = await fixture.outbox.list();
    const idempotencyKey = `:user%3Aalice:config-1:task-1:${digestOf(statusEvent(1))}`;
    expect(receipt).toMatchObject({
      kind: A2A_PUSH_DELIVERY_KIND,
      payloadMediaType: 'application/a2a+json',
      unknownOutcomePolicy: 'retry-with-idempotency',
      maxAttempts: 8,
      idempotencyKey,
      externalIdempotencyKey: `msg_${bytesToHex(sha256(new TextEncoder().encode(idempotencyKey)))}`,
    });

    await fixture.outbox.deliverNext();
    const request = await fixture.receiver.nextRequest(0);
    expect(request.headers['webhook-id']).toBe(receipt!.externalIdempotencyKey);
    expect(() => new Webhook(SIGNING_SECRET).verify(request.body, request.headers)).not.toThrow();
  });

  test('the same event sent twice is one delivery; a different event is another', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);

    await fixture.sender.send(statusEvent(1), alice());
    await fixture.sender.send(statusEvent(1), alice());
    expect(await fixture.outbox.list()).toHaveLength(1);

    await fixture.sender.send(statusEvent(2), alice());
    expect(await fixture.outbox.list()).toHaveLength(2);
  });

  test('a keyed send deduplicates only a replay of the same event key', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);

    await fixture.sender.sendKeyed(statusEvent(1), alice(), 'cursor-1');
    await fixture.sender.sendKeyed(statusEvent(1), alice(), 'cursor-1');
    expect(await fixture.outbox.list()).toHaveLength(1);

    // An identical-looking event under another key is another delivery.
    await fixture.sender.sendKeyed(statusEvent(1), alice(), 'cursor-2');
    expect(await fixture.outbox.list()).toHaveLength(2);
  });

  test('a keyed replay whose payload drifted is still one delivery', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);

    await fixture.sender.sendKeyed(statusEvent(1), alice(), 'cursor-1');
    // The replay rebuilds the event from a task view that has moved on.
    await fixture.sender.sendKeyed(statusEvent(2), alice(), 'cursor-1');
    expect(await fixture.outbox.list()).toHaveLength(1);
  });

  test('the wrapped store checks a create through the underlying store', async () => {
    const fixture = await createPushFixture();
    const created = await createConfiguration(fixture);

    expect(await fixture.sender.pushStore.check('task-1', alice(), created)).toEqual(created);
  });

  test('names a configuration’s destination by its caller scope', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    await fixture.sender.send(statusEvent(1), alice());

    const [receipt] = await fixture.outbox.list();
    expect(receipt?.destinationRef).toBe(pushDestinationRef(alice(), 'task-1', 'config-1'));
  });

  test('one event is one delivery per push configuration', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture, { id: 'config-1' });
    await createConfiguration(fixture, { id: 'config-2', token: 'token-2' });

    await fixture.sender.send(statusEvent(1), alice());

    const receipts = await fixture.outbox.list();
    expect(new Set(receipts.map((receipt) => receipt.idempotencyKey?.split(':')[2]))).toEqual(
      new Set(['config-1', 'config-2']),
    );
  });

  test('stores the request traceparent on the delivery and sends it', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

    await fixture.sender.send(statusEvent(1), contextWithHeaders({ traceparent }));

    const [receipt] = await fixture.outbox.list();
    expect(receipt?.causation).toEqual({ traceparent });
    await fixture.outbox.deliverNext();
    expect(await fixture.receiver.nextRequest(0)).toMatchObject({
      headers: { traceparent: traceparent },
    });
  });

  test('ignores a malformed traceparent and a request without headers', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);

    await fixture.sender.send(statusEvent(1), contextWithHeaders({ traceparent: 'not-a-trace' }));
    await fixture.sender.send(statusEvent(2), alice());

    for (const receipt of await fixture.outbox.list()) expect(receipt.causation).toBeUndefined();
  });

  test('enqueues nothing for a task without configurations or an event outside any task', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);

    await fixture.sender.send(statusEvent(1, 'task-without-configurations'), alice());
    await fixture.sender.send(
      {
        payload: {
          $case: 'message',
          value: {
            messageId: 'message-1',
            contextId: '',
            taskId: '',
            role: 1,
            parts: [],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
        },
      },
      alice(),
    );
    await fixture.sender.send({ payload: undefined }, alice());
    // Another user's configurations are invisible to this caller.
    await fixture.sender.send(statusEvent(1), callContext({ user: 'mallory' }));

    expect(await fixture.outbox.list()).toHaveLength(0);
  });

  test('a task snapshot event is addressed by the task identifier', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    await fixture.sender.send(
      {
        payload: {
          $case: 'task',
          value: {
            id: 'task-1',
            contextId: 'context-1',
            status: { state: 2, message: undefined, timestamp: undefined },
            artifacts: [],
            history: [],
            metadata: undefined,
          },
        },
      },
      alice(),
    );
    expect(await fixture.outbox.list()).toHaveLength(1);
  });

  test('throws when the outbox backlog is full', async () => {
    const fixture = await createPushFixture({ maxBacklog: 1 });
    await createConfiguration(fixture, { id: 'config-1' });
    await createConfiguration(fixture, { id: 'config-2', token: 'token-2' });

    expect(await throwingRejectionOf(fixture.sender.send(statusEvent(1), alice()))).toThrow(
      /backlog is full/,
    );
  });

  test('callers whose task and configuration identifiers coincide get separate deliveries', async () => {
    const fixture = await createPushFixture();
    const callers = [
      callContext({ user: 'alice' }),
      callContext({ user: 'bob' }),
      callContext({ user: 'alice', tenant: 'tenant-2' }),
    ];
    for (const context of callers) await createConfiguration(fixture, { context });

    for (const context of callers) await fixture.sender.send(statusEvent(1), context);

    const receipts = await fixture.outbox.list();
    expect(receipts).toHaveLength(3);
    expect(new Set(receipts.map((receipt) => receipt.idempotencyKey)).size).toBe(3);
    expect(new Set(receipts.map((receipt) => receipt.externalIdempotencyKey)).size).toBe(3);
  });

  test('throws when the idempotency key is already bound to another delivery', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    await fixture.outbox.enqueue({
      destinationRef: 'another-destination',
      kind: A2A_PUSH_DELIVERY_KIND,
      payload: { form: 'inline', value: {} },
      idempotencyKey: `:user%3Aalice:config-1:task-1:${digestOf(statusEvent(1))}`,
    });

    expect(await throwingRejectionOf(fixture.sender.send(statusEvent(1), alice()))).toThrow(
      /bound to another delivery/,
    );
  });

  test('a configuration deleted between loading and enqueueing has its delivery cancelled and purged', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    const stale = await fixture.pushStore.load('task-1', alice());
    await fixture.pushStore.delete('task-1', alice(), 'config-1');
    const sender = createOutboxPushNotificationSender({
      outbox: fixture.outbox,
      pushStore: { ...fixture.pushStore, load: async () => stale },
    });

    await sender.send(statusEvent(1), alice());

    // Cancelled, then purged: no settled record of the gone configuration remains.
    expect(await fixture.outbox.list()).toEqual([]);
    expect(await fixture.outbox.deliverNext()).toMatchObject({ status: 'empty' });
    expect(fixture.receiver.requests).toHaveLength(0);
  });
});

describe('createOutboxPushNotificationSender store wrapper', () => {
  test('delegates every read and write to the push store', async () => {
    const fixture = await createPushFixture();
    const store = fixture.sender.pushStore;
    const created = await store.create('task-1', alice(), {
      tenant: '',
      id: 'config-1',
      taskId: 'task-1',
      url: fixture.receiver.url(),
      token: '',
      authentication: undefined,
    });
    const saved = {
      tenant: '',
      id: '',
      taskId: 'task-1',
      url: fixture.receiver.url('/second'),
      token: '',
      authentication: undefined,
    };
    await store.save('task-1', alice(), saved);

    expect(await store.get('task-1', 'config-1', alice())).toEqual(created);
    const loaded = await store.load('task-1', alice());
    expect(new Set(loaded.map((config) => config.id))).toEqual(new Set(['config-1', saved.id]));
    expect(await store.loadWithMetadata('task-1', alice())).toHaveLength(2);
    expect(await store.list({ taskId: 'task-1' }, alice())).toMatchObject({
      configs: [expect.anything(), expect.anything()],
    });
  });

  test("plans a workflow agent's inline create with the push store's own planner", async () => {
    const fixture = await createPushFixture();
    const planner = pushConfigurationCreatePlannerOf(fixture.pushStore);

    expect(planner).toBeFunction();
    expect(pushConfigurationCreatePlannerOf(fixture.sender.pushStore)).toBe(planner);
  });

  test('delete defaults the configuration identifier to the task identifier', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture, { id: 'task-1' });
    await fixture.sender.pushStore.delete('task-1', alice());
    expect(await fixture.pushStore.get('task-1', 'task-1', alice())).toBeUndefined();
  });
});

describe('createOutboxPushNotificationSender delete purge', () => {
  test('a delete purges that configuration’s settled records and no other’s', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture, { id: 'config-1' });
    await fixture.sender.sendKeyed(statusEvent(1), alice(), 'event-1');
    expect(await fixture.outbox.deliverNext()).toMatchObject({ status: 'settled' });
    // Another configuration's settled record is not touched.
    await createConfiguration(fixture, { id: 'config-2' });
    await fixture.sender.sendKeyed(statusEvent(2), alice(), 'event-2');
    await fixture.outbox.drain({ timeoutMs: 0 });

    await fixture.sender.pushStore.delete('task-1', alice(), 'config-1');

    const remaining = await fixture.outbox.list();
    expect(
      remaining.every(
        (receipt) => receipt.destinationRef !== pushDestinationRef(alice(), 'task-1', 'config-1'),
      ),
    ).toBe(true);
    expect(remaining.length).toBeGreaterThan(0);
  });
});

describe('pushNotificationResolvers', () => {
  test('resolves a configuration in a tenant for a named user and for an anonymous caller', async () => {
    const fixture = await createPushFixture();
    const tenantContext = new ServerCallContext({ tenant: 'tenant-a' });
    await createConfiguration(fixture, { context: tenantContext, id: 'anonymous-config' });
    await createConfiguration(fixture, {
      context: callContext({ user: 'carol:with:colons', tenant: 'tenant-a' }),
      id: 'carol-config',
    });

    await fixture.sender.send(statusEvent(1), new ServerCallContext({ tenant: 'tenant-a' }));
    await fixture.sender.send(
      statusEvent(1),
      callContext({ user: 'carol:with:colons', tenant: 'tenant-a' }),
    );

    const receipts = await fixture.outbox.list();
    const resolvers = pushNotificationResolvers(fixture.pushStore);
    for (const receipt of receipts) {
      expect(await resolvers.resolveDestination(receipt.destinationRef)).toBe(
        fixture.receiver.url(),
      );
      expect(await resolvers.resolveCredential(receipt.destinationRef)).toEqual({
        scheme: 'Bearer',
        credentials: 'credential-secret',
        notificationToken: 'token-secret',
      });
    }
    expect(receipts).toHaveLength(2);
  });

  test('a deleted configuration, a foreign reference, or a malformed one resolves to nothing', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    await fixture.sender.send(statusEvent(1), alice());
    const [receipt] = await fixture.outbox.list();
    await fixture.pushStore.delete('task-1', alice(), 'config-1');
    const resolvers = pushNotificationResolvers(fixture.pushStore);

    expect(await resolvers.resolveDestination(receipt!.destinationRef)).toBeUndefined();
    expect(await resolvers.resolveCredential(receipt!.destinationRef)).toBeUndefined();
    expect(await resolvers.resolveDestination('webhook:orders')).toBeUndefined();
    expect(await resolvers.resolveDestination('a2a-push:a:b:c')).toBeUndefined();
    expect(
      await resolvers.resolveDestination('a2a-push:%E0%A4%A:anonymous:task-1:config-1'),
    ).toBeUndefined();
  });

  test('a configuration without authentication resolves no Authorization credential', async () => {
    const fixture = await createPushFixture();
    await fixture.pushStore.create('task-1', alice(), {
      tenant: '',
      id: 'config-1',
      taskId: 'task-1',
      url: fixture.receiver.url(),
      token: '',
      authentication: undefined,
    });
    await fixture.sender.send(statusEvent(1), alice());
    const [receipt] = await fixture.outbox.list();
    expect(
      await pushNotificationResolvers(fixture.pushStore).resolveCredential(receipt!.destinationRef),
    ).toEqual({
      scheme: undefined,
      credentials: undefined,
      notificationToken: undefined,
    });
  });
});

describe('push delivery construction', () => {
  test('rejects an outbox whose adapter is not createHttpDeliveryAdapter, or that has none', async () => {
    const fixture = await createPushFixture();
    const other = new Outbox({
      storage: fixture.storage,
      namespace: NAMESPACE,
      ownerId: 'other',
      adapter: { send: async () => ({ status: 'acknowledged' }) },
    });
    const none = new Outbox({ storage: fixture.storage, namespace: NAMESPACE, ownerId: 'none' });
    try {
      for (const outbox of [other, none]) {
        expect(() =>
          createOutboxPushNotificationSender({ outbox, pushStore: fixture.pushStore }),
        ).toThrow(TypeError);
      }
    } finally {
      other.dispose();
      none.dispose();
    }
  });

  test("rejects an adapter whose timeout is not below the outbox's attemptTimeoutMs", async () => {
    const fixture = await createPushFixture();
    const outbox = new Outbox({
      storage: fixture.storage,
      namespace: NAMESPACE,
      ownerId: 'short',
      adapter: fixture.adapter,
      attemptTimeoutMs: fixture.adapter.timeoutMs,
    });
    try {
      expect(() =>
        createOutboxPushNotificationSender({ outbox, pushStore: fixture.pushStore }),
      ).toThrow(RangeError);
    } finally {
      outbox.dispose();
    }
  });
});
