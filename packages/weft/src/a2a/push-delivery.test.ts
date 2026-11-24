import { describe, expect, test } from 'bun:test';

import { Webhook } from 'standardwebhooks';

import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import type { ApplicationDeliveryCancellationResult } from '../core/outbox-contract.ts';
import { Outbox } from '../core/outbox.ts';
import {
  callContext,
  createConfiguration,
  createPushFixture,
  NAMESPACE,
  onCleanup,
  type PushFixture,
  SIGNING_SECRET,
  statusEvent,
  usePushFixtures,
} from './push-delivery.test-support.ts';
import { startPushDelivery } from './push-delivery.ts';

usePushFixtures();

const alice = () => callContext({ user: 'alice' });
const TEN_MINUTES_MS = 600_000;

/** Run `startPushDelivery` until the test ends, and return how to stop it early. */
function runDelivery(outbox: Outbox, intervalMs = 5) {
  const controller = new AbortController();
  const errors: unknown[] = [];
  const running = startPushDelivery({
    outbox,
    intervalMs,
    signal: controller.signal,
    onError: (error) => errors.push(error),
  });
  const stop = async (): Promise<void> => {
    controller.abort(new Error('The test stopped push delivery.'));
    await running;
  };
  onCleanup(stop);
  return { stop, errors };
}

/** Record what every cancellation request returned on `outbox`. */
function recordCancellations(outbox: Outbox): ApplicationDeliveryCancellationResult[] {
  const results: ApplicationDeliveryCancellationResult[] = [];
  const original = outbox.requestCancellation.bind(outbox);
  outbox.requestCancellation = async (options) => {
    const result = await original(options);
    results.push(result);
    return result;
  };
  return results;
}

async function onlyReceipt(fixture: PushFixture) {
  const receipts = await fixture.outbox.list();
  expect(receipts).toHaveLength(1);
  return receipts[0]!;
}

describe('push delivery retries', () => {
  test('an unknown attempt is retried with the same webhook-id', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    await fixture.sender.send(statusEvent(1), alice());
    fixture.receiver.hold();

    const first = fixture.outbox.deliverNext();
    await fixture.receiver.nextRequest(0);
    fixture.scheduler.fire();
    expect(await first).toMatchObject({ status: 'settled', receipt: { state: 'retry-scheduled' } });

    fixture.clock.advance(TEN_MINUTES_MS);
    expect(await fixture.outbox.deliverNext()).toMatchObject({
      status: 'settled',
      receipt: { state: 'acknowledged' },
    });
    const [original, retry] = [
      await fixture.receiver.nextRequest(0),
      await fixture.receiver.nextRequest(1),
    ];
    expect(retry.headers['webhook-id']).toBe(original.headers['webhook-id']);
    expect(retry.body).toBe(original.body);
    expect(() => new Webhook(SIGNING_SECRET).verify(retry.body, retry.headers)).not.toThrow();
  });

  test('a pending delivery is sent after a restart: a new outbox and loop over the same storage', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    fixture.receiver.reply(503);
    const before = runDelivery(fixture.outbox);

    await fixture.sender.send(statusEvent(1), alice());
    await fixture.receiver.nextRequest(0);
    await before.stop();
    fixture.outbox.dispose();

    const restarted = fixture.restart();
    fixture.clock.advance(TEN_MINUTES_MS);
    const after = runDelivery(restarted);
    const retry = await fixture.receiver.nextRequest(1);
    await after.stop();

    const original = await fixture.receiver.nextRequest(0);
    expect(retry.headers['webhook-id']).toBe(original.headers['webhook-id']);
    expect(after.errors).toEqual([]);
    expect(before.errors).toEqual([]);
  });
});

describe('deleting a push configuration', () => {
  test('cancels a queued retry, which never reaches the receiver again', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    await fixture.sender.send(statusEvent(1), alice());
    fixture.receiver.reply(503);
    await fixture.outbox.deliverNext();
    expect(await onlyReceipt(fixture)).toMatchObject({ state: 'retry-scheduled' });
    const cancellations = recordCancellations(fixture.outbox);

    await fixture.sender.pushStore.delete('task-1', alice(), 'config-1');

    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({ receipt: { state: 'cancelled' } });
    // The cancelled record is purged with the configuration it belonged to.
    expect(await fixture.outbox.list()).toEqual([]);
    fixture.clock.advance(TEN_MINUTES_MS);
    expect(await fixture.outbox.deliverNext()).toMatchObject({ status: 'empty' });
    expect(fixture.receiver.requests).toHaveLength(1);
    expect(await fixture.pushStore.get('task-1', 'config-1', alice())).toBeUndefined();
  });

  test('stops new enqueues for the configuration', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    await fixture.sender.pushStore.delete('task-1', alice(), 'config-1');
    await fixture.sender.send(statusEvent(1), alice());
    expect(await fixture.outbox.list()).toHaveLength(0);
  });

  test('aborts an attempt in flight, waits through cancellation-requested, and returns once it has settled', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    const cancellations = recordCancellations(fixture.outbox);
    fixture.receiver.hold();
    runDelivery(fixture.outbox);

    await fixture.sender.send(statusEvent(1), alice());
    await fixture.receiver.nextRequest(0);
    await fixture.sender.pushStore.delete('task-1', alice(), 'config-1');

    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({
      status: 'requested',
      receipt: { state: 'cancellation-requested' },
    });
    const cancelled = cancellations[0]!;
    if (cancelled.status === 'unknown') throw new Error('The cancellation named no delivery.');
    const deliveryId = cancelled.receipt.deliveryId;
    // Delete returned only once the aborted attempt settled, and then purged its record.
    expect(await fixture.outbox.list()).toEqual([]);
    expect(await fixture.outbox.receipt(deliveryId)).toBeNull();
    await fixture.receiver.nextAbandoned();

    fixture.clock.advance(TEN_MINUTES_MS);
    await fixture.outbox.drain({ timeoutMs: 0 });
    expect(fixture.receiver.requests).toHaveLength(1);
  });

  test("throws when an aborted attempt has not settled by the adapter's timeout plus one interval", async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture);
    await fixture.sender.send(statusEvent(1), alice());
    // A host-driven attempt that begins and never settles, as a process that died
    // mid-send would leave it.
    const claimed = await fixture.outbox.claim();
    if (claimed.status !== 'claimed') throw new Error('Expected a claim.');
    await fixture.outbox.beginAttempt({
      deliveryId: claimed.claim.receipt.deliveryId,
      attemptToken: claimed.claim.attemptToken,
    });
    const budgets: number[] = [];
    const awaitCleanup = fixture.outbox.awaitCleanup.bind(fixture.outbox);
    fixture.outbox.awaitCleanup = (options) => {
      const waiting = awaitCleanup(options);
      budgets.push(options.timeoutMs);
      fixture.clock.advance(options.timeoutMs);
      return waiting;
    };

    expect(
      await throwingRejectionOf(fixture.sender.pushStore.delete('task-1', alice(), 'config-1')),
    ).toThrow(/did not settle after cancellation/);
    expect(budgets).toEqual([fixture.adapter.timeoutMs + 1000]);
  });

  test('cancels only the deleted configuration’s open delivery and purges every deleted one’s record', async () => {
    const fixture = await createPushFixture();
    await createConfiguration(fixture, { id: 'config-1' });
    await createConfiguration(fixture, { id: 'config-2', token: 'token-2' });
    await fixture.sender.send(statusEvent(1), alice());
    await fixture.outbox.deliverNext();
    const cancellations = recordCancellations(fixture.outbox);

    await fixture.sender.pushStore.delete('task-1', alice(), 'config-1');
    await fixture.sender.pushStore.delete('task-1', alice(), 'config-2');

    expect(cancellations).toHaveLength(1);
    // Both configurations are deleted, so each one's settled or cancelled record is purged.
    expect(await fixture.outbox.list()).toEqual([]);
  });
});

describe('startPushDelivery', () => {
  test('rejects an outbox without the HTTP delivery adapter and a non-positive interval', async () => {
    const fixture = await createPushFixture();
    const other = new Outbox({
      storage: fixture.storage,
      namespace: NAMESPACE,
      ownerId: 'other',
      adapter: { send: async () => ({ status: 'acknowledged' }) },
    });
    onCleanup(() => other.dispose());
    const signal = new AbortController().signal;
    expect(await throwingRejectionOf(startPushDelivery({ outbox: other, signal }))).toThrow(
      TypeError,
    );
    // Above the timer maximum, setTimeout fires after about 1 ms: a busy loop.
    for (const intervalMs of [0, -1, 1.5, 2_147_483_648]) {
      expect(
        await throwingRejectionOf(
          startPushDelivery({ outbox: fixture.outbox, intervalMs, signal }),
        ),
      ).toThrow(RangeError);
    }
  });

  test('reports a failed drain and keeps running until aborted', async () => {
    const fixture = await createPushFixture();
    const controller = new AbortController();
    const failure = new Error('storage unavailable');
    let drains = 0;
    fixture.outbox.drain = async () => {
      drains += 1;
      if (drains === 2) controller.abort();
      throw failure;
    };
    const errors: unknown[] = [];
    await startPushDelivery({
      outbox: fixture.outbox,
      intervalMs: 1,
      signal: controller.signal,
      onError: (error) => errors.push(error),
    });
    expect(errors).toEqual([failure]);
    expect(drains).toBe(2);
  });

  test('keeps running when the error reporter throws', async () => {
    const fixture = await createPushFixture();
    const controller = new AbortController();
    let drains = 0;
    fixture.outbox.drain = async () => {
      drains += 1;
      if (drains === 3) controller.abort();
      throw new Error('storage unavailable');
    };
    let reports = 0;
    await startPushDelivery({
      outbox: fixture.outbox,
      intervalMs: 1,
      signal: controller.signal,
      onError: () => {
        reports += 1;
        throw new Error('The log backend is unavailable.');
      },
    });
    expect(reports).toBe(2);
    expect(drains).toBe(3);
  });

  test('reports to console.error by default', async () => {
    const fixture = await createPushFixture();
    const controller = new AbortController();
    const reported: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      reported.push(args);
      controller.abort();
    };
    fixture.outbox.drain = async () => {
      throw new Error('storage unavailable');
    };
    try {
      await startPushDelivery({ outbox: fixture.outbox, signal: controller.signal });
    } finally {
      console.error = original;
    }
    expect(reported).toHaveLength(1);
    expect(String(reported[0]![0])).toMatch(/push delivery drain failed/);
  });

  test('returns at once for an aborted signal', async () => {
    const fixture = await createPushFixture();
    await startPushDelivery({ outbox: fixture.outbox, signal: AbortSignal.abort() });
  });
});
