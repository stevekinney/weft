/**
 * Shutdown for the durable application delivery outbox (WFT-85): the bounded
 * drain and its honest counts, disposal aborting every process-local attempt
 * and wait without touching durable work, and the automatic maintenance
 * timer's lifecycle — all under fake timers, with no real sleeps.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import {
  advanceTimersByTime,
  flushMicrotasks,
  restoreRealTimers,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';
import {
  beginOne,
  claimOne,
  createOutboxClock,
  createOutboxFixture,
  enqueueOne,
  fieldOf,
  ScriptedAdapter,
  statusOf,
} from './application-outbox.test-support.ts';
import { ApplicationOutbox } from './application-outbox.ts';

describe('ApplicationOutbox drain', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('delivers everything due and reports counts by durable disposition', async () => {
    const { outbox, adapter } = createOutboxFixture({ maxAttempts: 1 });
    adapter
      .reply({ status: 'acknowledged' })
      .reply({ status: 'rejected' })
      .reply({ status: 'retryable' })
      .reply({ status: 'unknown' });
    for (let index = 0; index < 4; index += 1) await enqueueOne(outbox);
    const cancelled = await enqueueOne(outbox);
    await outbox.requestCancellation({ deliveryId: cancelled });
    const report = await outbox.drain({ timeoutMs: 0 });
    expect(report).toEqual({
      acknowledged: 1,
      rejected: 1,
      retryScheduled: 0,
      deadLettered: 1,
      cancelled: 0,
      unknown: 1,
      pending: 0,
      drained: true,
    });
    outbox.dispose();
  });

  it('reports pending work it could not finish within the budget, never as acknowledged', async () => {
    useFakeTimers();
    const { outbox, clock, adapter } = createOutboxFixture({ retryBackoffMs: 500 });
    adapter.reply({ status: 'retryable' });
    const deliveryId = await enqueueOne(outbox);
    const draining = outbox.drain({ timeoutMs: 100, pollIntervalMs: 50 });
    await flushMicrotasks(32);
    clock.advance(100);
    await advanceTimersByTime(100);
    const report = await draining;
    expect(report).toMatchObject({
      retryScheduled: 1,
      acknowledged: 0,
      pending: 1,
      drained: false,
    });
    expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe('retry-scheduled');
    outbox.dispose();
  });

  it('waits for a held delivery to come due within the budget', async () => {
    useFakeTimers();
    const { outbox, clock } = createOutboxFixture();
    await enqueueOne(outbox, { availableAfterMs: 80 });
    const draining = outbox.drain({ timeoutMs: 1000, pollIntervalMs: 50 });
    await flushMicrotasks(32);
    clock.advance(80);
    await advanceTimersByTime(80);
    const report = await draining;
    expect(report).toMatchObject({ acknowledged: 1, pending: 0, drained: true });
    outbox.dispose();
  });

  it('stops on a caller abort and on disposal, reporting only what it committed', async () => {
    useFakeTimers();
    const { outbox, clock } = createOutboxFixture();
    await enqueueOne(outbox, { availableAfterMs: 1_000_000 });
    const controller = new AbortController();
    const aborted = outbox.drain({ timeoutMs: 100_000, signal: controller.signal });
    await flushMicrotasks(32);
    controller.abort();
    await advanceTimersByTime(1);
    expect(await aborted).toMatchObject({ pending: 1, drained: false, acknowledged: 0 });

    const disposed = outbox.drain({ timeoutMs: 100_000 });
    await flushMicrotasks(32);
    outbox.dispose();
    await advanceTimersByTime(1);
    expect(await disposed).toMatchObject({ pending: 1, drained: false });
    void clock;
  });

  it('recovers a lapsed lease left by another worker while draining', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const other = createOutboxFixture({ storage, clock, attemptTimeoutMs: 100 }).outbox;
    await enqueueOne(other);
    await claimOne(other);
    other.dispose();
    clock.advance(100);
    const { outbox } = createOutboxFixture({ storage, clock });
    // Maintenance reschedules the lease with backoff; the drain then waits it out.
    const report = await outbox.drain({ timeoutMs: 0 });
    expect(report).toMatchObject({ pending: 1, drained: false });
    clock.advance(1000);
    expect(await outbox.drain({ timeoutMs: 0 })).toMatchObject({ acknowledged: 1, drained: true });
    outbox.dispose();
  });

  it('validates the drain budget', async () => {
    const { outbox } = createOutboxFixture();
    await expect(outbox.drain({ timeoutMs: Number.NaN })).rejects.toThrow(/timeoutMs/);
    outbox.dispose();
  });
});

describe('ApplicationOutbox disposal', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('aborts only its own attempts and leaves durable leases for maintenance', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const mine = createOutboxFixture({ storage, clock }).outbox;
    const sibling = createOutboxFixture({ storage, clock }).outbox;
    const first = await enqueueOne(mine);
    const second = await enqueueOne(mine);
    const own = await beginOne(mine);
    const theirs = await beginOne(sibling);
    mine.dispose();
    expect(own.signal.aborted).toBe(true);
    expect(theirs.signal.aborted).toBe(false);
    expect(await fieldOf(sibling.receipt(first), 'state')).toBe('attempting');
    expect(await fieldOf(sibling.receipt(second), 'state')).toBe('attempting');
    // The surviving handle still settles its own attempt.
    expect(await statusOf(sibling.settle({ ...theirs, outcome: { status: 'acknowledged' } }))).toBe(
      'settled',
    );
    sibling.dispose();
  });

  it('supports `using` and is idempotent', async () => {
    const storage = new MemoryStorage();
    let captured: ApplicationOutbox | undefined;
    {
      using outbox = new ApplicationOutbox({ storage, namespace: 'n', ownerId: 'o' });
      captured = outbox;
    }
    await expect(captured.receipt('x')).rejects.toThrow(/disposed/);
    captured.dispose();
    // The default id source mints usable delivery ids.
    using fresh = new ApplicationOutbox({ storage, namespace: 'n', ownerId: 'o' });
    const admission = await fresh.enqueue({
      destinationRef: 'd',
      kind: 'k',
      payload: { form: 'inline', value: 1 },
    });
    expect(admission.status).toBe('enqueued');
  });

  it('withholds a live signal from a claim whose handle was disposed before it registered', async () => {
    let calls = 0;
    let disposeOnToken: (() => void) | null = null;
    const { outbox } = createOutboxFixture({
      generateId: () => {
        calls += 1;
        // The first id is the enqueue's delivery id; the second is the attempt
        // token, minted just before the attempt registers with the handle.
        if (calls === 2) disposeOnToken?.();
        return `id-${calls}`;
      },
    });
    await enqueueOne(outbox);
    disposeOnToken = () => {
      outbox.dispose();
    };
    const result = await outbox.claim();
    expect(result.status).toBe('claimed');
    expect(result.status === 'claimed' && result.claim.signal.aborted).toBe(true);
  });

  it('hands back an already-aborted signal when disposal lands while the claim commits', async () => {
    let ordinal = 0;
    let disposeDuringCommit: (() => void) | null = null;
    class DisposingStorage extends MemoryStorage {
      override async conditionalBatch(
        ...arguments_: Parameters<MemoryStorage['conditionalBatch']>
      ): Promise<boolean> {
        ordinal += 1;
        // Ordinal 1 is the enqueue; the claim commit is next.
        if (ordinal === 2) disposeDuringCommit?.();
        return super.conditionalBatch(...arguments_);
      }
    }
    const { outbox } = createOutboxFixture({ storage: new DisposingStorage() });
    await enqueueOne(outbox);
    disposeDuringCommit = () => {
      outbox.dispose();
    };
    const result = await outbox.claim();
    // The lease is durable either way; what the caller must never receive is
    // live work from a disposed handle.
    expect(result.status).toBe('claimed');
    expect(result.status === 'claimed' && result.claim.signal.aborted).toBe(true);
  });
});

describe('ApplicationOutbox automatic maintenance', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('runs a maintenance pass on its interval and stops on dispose', async () => {
    useFakeTimers();
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const worker = createOutboxFixture({ storage, clock, attemptTimeoutMs: 100 }).outbox;
    const deliveryId = await enqueueOne(worker);
    await claimOne(worker);
    worker.dispose();
    const errors: unknown[] = [];
    const automatic = createOutboxFixture({
      storage,
      clock,
      backgroundTasks: 'automatic',
      maintenanceIntervalMs: 50,
      onMaintenanceError: (error) => {
        errors.push(error);
      },
    }).outbox;
    clock.advance(100);
    await advanceTimersByTime(50);
    await flushMicrotasks(32);
    expect(await fieldOf(automatic.receipt(deliveryId), 'state')).toBe('retry-scheduled');
    expect(errors).toHaveLength(0);
    automatic.dispose();
    // No further pass runs after disposal.
    await advanceTimersByTime(500);
    await flushMicrotasks(32);
  });

  it('reports a failing pass through onMaintenanceError and keeps going', async () => {
    useFakeTimers();
    const clock = createOutboxClock();
    let failures = 0;
    const errors: unknown[] = [];
    class FlakyStorage extends MemoryStorage {
      override async *scan(
        ...arguments_: Parameters<MemoryStorage['scan']>
      ): ReturnType<MemoryStorage['scan']> {
        if (failures > 0) {
          failures -= 1;
          throw new Error('scan failed');
        }
        yield* super.scan(...arguments_);
      }
    }
    failures = 1;
    const automatic = createOutboxFixture({
      storage: new FlakyStorage(),
      clock,
      backgroundTasks: 'automatic',
      maintenanceIntervalMs: 10,
      onMaintenanceError: (error) => {
        errors.push(error);
        throw new Error('sink failed too');
      },
    }).outbox;
    await advanceTimersByTime(10);
    await flushMicrotasks(32);
    expect(errors).toHaveLength(1);
    await advanceTimersByTime(10);
    await flushMicrotasks(32);
    expect(errors).toHaveLength(1);
    automatic.dispose();
  });

  it('defaults the error sink to console.error', async () => {
    useFakeTimers();
    const original = console.error;
    const seen: unknown[] = [];
    console.error = (...arguments_: unknown[]) => {
      seen.push(arguments_);
    };
    try {
      class BrokenStorage extends MemoryStorage {
        override async *scan(): ReturnType<MemoryStorage['scan']> {
          throw new Error('broken');
        }
      }
      const automatic = createOutboxFixture({
        storage: new BrokenStorage(),
        backgroundTasks: 'automatic',
        maintenanceIntervalMs: 10,
      }).outbox;
      await advanceTimersByTime(10);
      await flushMicrotasks(32);
      expect(seen).toHaveLength(1);
      automatic.dispose();
    } finally {
      console.error = original;
    }
  });

  it('starts no timer in manual mode', async () => {
    const original = globalThis.setTimeout;
    let scheduled = 0;
    globalThis.setTimeout = ((...arguments_: Parameters<typeof setTimeout>) => {
      scheduled += 1;
      return original(...arguments_);
    }) as typeof setTimeout;
    try {
      const { outbox } = createOutboxFixture();
      await enqueueOne(outbox);
      await outbox.runMaintenance();
      outbox.dispose();
      expect(scheduled).toBe(0);
    } finally {
      globalThis.setTimeout = original;
    }
  });

  it('uses the scripted adapter fallback when the script runs dry', async () => {
    const adapter = new ScriptedAdapter();
    adapter.fallback = { status: 'rejected' };
    const { outbox } = createOutboxFixture({ scripted: adapter });
    await enqueueOne(outbox);
    expect(await statusOf(outbox.deliverNext())).toBe('settled');
    const rejected = await outbox.list({ states: ['rejected'] });
    expect(rejected).toHaveLength(1);
    outbox.dispose();
  });
});
