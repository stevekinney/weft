/**
 * Liveness for the durable application delivery outbox (WFT-85): the bounded
 * wait for due work, the bounded cleanup wait, heartbeat as liveness evidence
 * distinct from acknowledgement, and every budget and abort path — all under
 * fake timers, with no real sleeps.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';
import { WaitBudgetElapsedError } from './application-primitive-abort.ts';
import { ApplicationDeliveryValidationError } from './outbox-guards.ts';
import {
  beginOne,
  createOutboxFixture,
  enqueueOne,
  fieldOf,
  statusOf,
} from './outbox.test-support.ts';

/** Flush enough microtask turns for a chain of awaited storage reads to settle. */
async function flush(turns = 16): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

describe('Outbox waitForDue', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('checks once with no options and reports due work without claiming it', async () => {
    const { outbox, adapter } = createOutboxFixture();
    expect(await outbox.waitForDue()).toBe(false);
    const deliveryId = await enqueueOne(outbox);
    expect(await outbox.waitForDue()).toBe(true);
    expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe('queued');
    expect(adapter.requests).toHaveLength(0);
    outbox.dispose();
  });

  it('wakes when a delivery becomes due within the budget', async () => {
    useFakeTimers();
    const { outbox, clock } = createOutboxFixture();
    await enqueueOne(outbox, { availableAfterMs: 120 });
    expect(await outbox.waitForDue()).toBe(false);
    const waiting = outbox.waitForDue({ timeoutMs: 1000, pollIntervalMs: 50 });
    await flush();
    clock.advance(50);
    await advanceTimersByTime(50);
    await flush();
    clock.advance(50);
    await advanceTimersByTime(50);
    await flush();
    clock.advance(50);
    await advanceTimersByTime(50);
    expect(await waiting).toBe(true);
    outbox.dispose();
  });

  it('returns false when the budget elapses, the caller aborts, or the outbox is disposed', async () => {
    useFakeTimers();
    const { outbox, clock } = createOutboxFixture();
    await enqueueOne(outbox, { availableAfterMs: 1_000_000 });
    const timedOut = outbox.waitForDue({ timeoutMs: 100, pollIntervalMs: 40 });
    await flush();
    for (let step = 0; step < 3; step += 1) {
      clock.advance(40);
      await advanceTimersByTime(40);
      await flush();
    }
    expect(await timedOut).toBe(false);

    const controller = new AbortController();
    const aborted = outbox.waitForDue({ timeoutMs: 1000, signal: controller.signal });
    await flush();
    controller.abort();
    expect(await aborted).toBe(false);
    expect(await outbox.waitForDue({ signal: controller.signal, timeoutMs: 10 })).toBe(false);

    const disposed = outbox.waitForDue({ timeoutMs: 1000 });
    await flush();
    outbox.dispose();
    expect(await disposed).toBe(false);
  });

  it('validates the wait budget', async () => {
    const { outbox } = createOutboxFixture();
    await expect(outbox.waitForDue({ timeoutMs: -1 })).rejects.toThrow(
      ApplicationDeliveryValidationError,
    );
    await expect(outbox.waitForDue({ pollIntervalMs: 0 })).rejects.toThrow(
      ApplicationDeliveryValidationError,
    );
    outbox.dispose();
  });

  it('looks past a due entry whose record already moved on', async () => {
    const { outbox, storage } = createOutboxFixture();
    await enqueueOne(outbox);
    const { KEYS } = await import('../storage/interface.ts');
    const { encode } = await import('./codec.ts');
    await storage.put(
      KEYS.applicationDeliveryDue('bureau', 'agent-7', 0, 'ghost'),
      encode('ghost'),
    );
    expect(await outbox.waitForDue()).toBe(true);
    outbox.dispose();
  });
});

describe('Outbox awaitCleanup', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('resolves settled once the cancelled attempt reports, and pending when the budget ends', async () => {
    useFakeTimers();
    const { outbox, clock } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    await outbox.requestCancellation({ deliveryId });
    const pending = outbox.awaitCleanup({ deliveryId, timeoutMs: 100, pollIntervalMs: 50 });
    await flush();
    clock.advance(50);
    await advanceTimersByTime(50);
    await flush();
    clock.advance(50);
    await advanceTimersByTime(50);
    const stopped = await pending;
    expect(stopped.status).toBe('pending');

    const settling = outbox.awaitCleanup({ deliveryId, timeoutMs: 1000, pollIntervalMs: 50 });
    await flush();
    await outbox.settle({ ...claim, outcome: { status: 'rejected' } });
    clock.advance(50);
    await advanceTimersByTime(50);
    const settled = await settling;
    expect(settled.status).toBe('settled');
    expect(settled.status === 'settled' && settled.receipt.state).toBe('cancelled');
    outbox.dispose();
  });

  it('returns a parked receipt at once: an abandoned attempt never settles', async () => {
    const { outbox, clock } = createOutboxFixture({ attemptTimeoutMs: 10 });
    const deliveryId = await enqueueOne(outbox);
    await beginOne(outbox);
    clock.advance(10);
    await outbox.runMaintenance();
    const result = await outbox.awaitCleanup({ deliveryId, timeoutMs: 1_000_000 });
    expect(result.status).toBe('pending');
    expect(result.status === 'pending' && result.receipt.cleanupPending).toBe(true);
    outbox.dispose();
  });

  it('reports unknown ids, rejects on caller abort, and surfaces a spent first-read budget', async () => {
    useFakeTimers();
    const { outbox } = createOutboxFixture();
    expect(await statusOf(outbox.awaitCleanup({ deliveryId: 'missing', timeoutMs: 0 }))).toBe(
      'unknown',
    );
    const deliveryId = await enqueueOne(outbox);
    await beginOne(outbox);
    await outbox.requestCancellation({ deliveryId });
    const controller = new AbortController();
    const aborted = outbox.awaitCleanup({ deliveryId, timeoutMs: 1000, signal: controller.signal });
    await flush();
    controller.abort(new Error('caller gave up'));
    await expect(aborted).rejects.toThrow('caller gave up');

    // A first read that never returns within the budget has nothing to report.
    const stalled = createOutboxFixture({
      storage: new Proxy(outbox.storage, {
        get(target, property, receiver) {
          if (property === 'get') return () => new Promise(() => undefined);
          return Reflect.get(target, property, receiver);
        },
      }),
    }).outbox;
    const spent = stalled.awaitCleanup({ deliveryId, timeoutMs: 10 });
    await flush();
    await advanceTimersByTime(10);
    await expect(spent).rejects.toThrow(WaitBudgetElapsedError);
    stalled.dispose();
    outbox.dispose();
  });

  it('keeps the last observation when the outbox is disposed mid-wait', async () => {
    useFakeTimers();
    const { outbox } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    await beginOne(outbox);
    await outbox.requestCancellation({ deliveryId });
    const waiting = outbox.awaitCleanup({ deliveryId, timeoutMs: 1000, pollIntervalMs: 50 });
    await flush();
    outbox.dispose();
    await advanceTimersByTime(50);
    expect(await statusOf(waiting)).toBe('pending');
  });
});

describe('Outbox heartbeat liveness', () => {
  it('records transport activity separately from acknowledgement and never moves the deadline', async () => {
    const { outbox, clock } = createOutboxFixture({
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 300,
    });
    const deliveryId = await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    const deadline = clock.now() + 300;
    for (const bytesWritten of [10, 20, 30]) {
      clock.advance(80);
      const beat = await outbox.heartbeat({ ...claim, transportActivity: { bytesWritten } });
      expect(beat.status).toBe('renewed');
      if (beat.status !== 'renewed') return;
      expect(beat.attemptDeadlineAt).toBe(deadline);
      expect(beat.visibilityExpiresAt).toBe(Math.min(clock.now() + 100, deadline));
      expect(beat.receipt.lastActivityAt).toBe(clock.now());
      expect(beat.receipt.transportActivity).toEqual({ bytesWritten });
      expect(beat.receipt.state).toBe('attempting');
      expect(beat.receipt.terminalAt).toBeUndefined();
    }
    expect(await fieldOf(outbox.receipt(deliveryId), 'evidence')).toBeUndefined();
    outbox.dispose();
  });
});
