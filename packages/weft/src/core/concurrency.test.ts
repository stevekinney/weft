import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import { AtomicState } from './atomic-state.ts';
import {
  DurableMutex,
  DurableSemaphore,
  initialLockRecord,
  reduceAcquire,
  reduceRelease,
  reduceRenew,
  type LockRecord,
} from './concurrency.ts';

function makeSlot(initial?: LockRecord): AtomicState<LockRecord> {
  return new AtomicState<LockRecord>(new MemoryStorage(), 'state:test:lock', {
    initial: initial ?? initialLockRecord(),
  });
}

async function holderIds(
  primitive: DurableSemaphore,
  slot: AtomicState<LockRecord>,
): Promise<string[]> {
  const record = await primitive.inspect(slot);
  return (record?.holders ?? []).map((holder) => holder.holderId);
}

function legacyRecord(): LockRecord {
  return {
    holders: [{ holderId: 'a', leaseExpiresAt: 6_000 }],
    waiters: ['x'],
  } as unknown as LockRecord;
}

function queueWithTwoWaiters(): LockRecord {
  return {
    holders: [{ holderId: 'a', leaseExpiresAt: 100_000 }],
    waiters: [
      { holderId: 'b', leaseExpiresAt: 5_000 },
      { holderId: 'c', leaseExpiresAt: 9_000 },
    ],
  };
}

describe('lock-record reducers', () => {
  describe('reduceAcquire', () => {
    it('grants a permit to the sole contender and records a lease', () => {
      const { record, attempt } = reduceAcquire(undefined, {
        holderId: 'a',
        now: 1_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(attempt).toEqual({ acquired: true, position: -1 });
      expect(record.holders).toEqual([{ holderId: 'a', leaseExpiresAt: 6_000 }]);
      expect(record.waiters).toEqual([]);
    });

    it('queues the second contender behind the holder in FIFO order', () => {
      const held: LockRecord = { holders: [{ holderId: 'a', leaseExpiresAt: 6_000 }], waiters: [] };
      const first = reduceAcquire(held, { holderId: 'b', now: 1_000, leaseMs: 5_000, permits: 1 });
      expect(first.attempt).toEqual({ acquired: false, position: 0 });
      expect(first.record.waiters).toEqual([{ holderId: 'b', leaseExpiresAt: 6_000 }]);

      const second = reduceAcquire(first.record, {
        holderId: 'c',
        now: 1_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(second.attempt).toEqual({ acquired: false, position: 1 });
      expect(second.record.waiters).toEqual([
        { holderId: 'b', leaseExpiresAt: 6_000 },
        { holderId: 'c', leaseExpiresAt: 6_000 },
      ]);
    });

    it('does not double-enqueue a waiter that retries', () => {
      const held: LockRecord = {
        holders: [{ holderId: 'a', leaseExpiresAt: 6_000 }],
        waiters: [{ holderId: 'b', leaseExpiresAt: 4_000 }],
      };
      const retry = reduceAcquire(held, { holderId: 'b', now: 2_000, leaseMs: 5_000, permits: 1 });
      expect(retry.attempt).toEqual({ acquired: false, position: 0 });
      expect(retry.record.waiters).toEqual([{ holderId: 'b', leaseExpiresAt: 7_000 }]);
    });

    it('grants the permit to the head of the queue once it is free', () => {
      const queued: LockRecord = { holders: [], waiters: [{ holderId: 'b' }, { holderId: 'c' }] };
      const granted = reduceAcquire(queued, {
        holderId: 'b',
        now: 3_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(granted.attempt).toEqual({ acquired: true, position: -1 });
      expect(granted.record.holders).toEqual([{ holderId: 'b', leaseExpiresAt: 8_000 }]);
      expect(granted.record.waiters).toEqual([{ holderId: 'c' }]);
    });

    it('does not let a non-head waiter jump the queue even when a permit is free', () => {
      const queued: LockRecord = { holders: [], waiters: [{ holderId: 'b' }, { holderId: 'c' }] };
      const blocked = reduceAcquire(queued, {
        holderId: 'c',
        now: 3_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(blocked.attempt).toEqual({ acquired: false, position: 1 });
      expect(blocked.record.holders).toEqual([]);
    });

    it('reclaims an expired lease so a crashed holder cannot deadlock', () => {
      const stale: LockRecord = {
        holders: [{ holderId: 'a', leaseExpiresAt: 1_000 }],
        waiters: [],
      };
      const reclaimed = reduceAcquire(stale, {
        holderId: 'b',
        now: 2_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(reclaimed.attempt).toEqual({ acquired: true, position: -1 });
      expect(reclaimed.record.holders).toEqual([{ holderId: 'b', leaseExpiresAt: 7_000 }]);
    });

    it('keeps a lease that has not yet expired (boundary: leaseExpiresAt <= now is expired)', () => {
      const held: LockRecord = { holders: [{ holderId: 'a', leaseExpiresAt: 2_000 }], waiters: [] };
      const blocked = reduceAcquire(held, {
        holderId: 'b',
        now: 2_000,
        leaseMs: 5_000,
        permits: 1,
      });
      // leaseExpiresAt === now means the lease has expired (inclusive boundary), so it IS reclaimed.
      expect(blocked.attempt.acquired).toBe(true);

      const stillHeld = reduceAcquire(
        { holders: [{ holderId: 'a', leaseExpiresAt: 2_001 }], waiters: [] },
        { holderId: 'b', now: 2_000, leaseMs: 5_000, permits: 1 },
      );
      expect(stillHeld.attempt.acquired).toBe(false);
    });

    it('treats re-acquisition by an existing holder as an idempotent lease renewal', () => {
      const held: LockRecord = {
        holders: [{ holderId: 'a', leaseExpiresAt: 6_000 }],
        waiters: [{ holderId: 'b' }],
      };
      const renewed = reduceAcquire(held, {
        holderId: 'a',
        now: 4_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(renewed.attempt).toEqual({ acquired: true, position: -1 });
      expect(renewed.record.holders).toEqual([{ holderId: 'a', leaseExpiresAt: 9_000 }]);
      expect(renewed.record.waiters).toEqual([{ holderId: 'b' }]);
    });

    it('allows up to `permits` concurrent holders for a counting semaphore', () => {
      let record: LockRecord = initialLockRecord();
      const grants: boolean[] = [];
      for (const holderId of ['a', 'b', 'c', 'd']) {
        const reduced = reduceAcquire(record, {
          holderId,
          now: 1_000,
          leaseMs: 5_000,
          permits: 3,
        });
        record = reduced.record;
        grants.push(reduced.attempt.acquired);
      }
      expect(grants).toEqual([true, true, true, false]);
      expect(record.holders).toHaveLength(3);
      expect(record.waiters).toEqual([{ holderId: 'd', leaseExpiresAt: 6_000 }]);
    });

    it('normalizes a corrupt record into an empty lock', () => {
      const corrupt = { holders: undefined, waiters: 'nope' } as unknown as LockRecord;
      const reduced = reduceAcquire(corrupt, {
        holderId: 'a',
        now: 1_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(reduced.attempt.acquired).toBe(true);
      expect(reduced.record.holders).toEqual([{ holderId: 'a', leaseExpiresAt: 6_000 }]);
    });

    it('normalizes a legacy bare-string waiter and registers the caller with a lease', () => {
      const legacy = {
        holders: [{ holderId: 'a', leaseExpiresAt: 6_000 }],
        waiters: ['x'],
      } as unknown as LockRecord;
      const reduced = reduceAcquire(legacy, {
        holderId: 'b',
        now: 1_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(reduced.attempt).toStrictEqual({ acquired: false, position: 1 });
      expect(reduced.record.waiters).toStrictEqual([
        { holderId: 'x' },
        { holderId: 'b', leaseExpiresAt: 6_000 },
      ]);
    });

    it('drops malformed waiter entries and keeps valid ones in order', () => {
      const malformed = {
        holders: [{ holderId: 'a', leaseExpiresAt: 100_000 }],
        waiters: [
          null,
          7,
          {},
          { holderId: 5 },
          { holderId: 'm', leaseExpiresAt: Number.NaN },
          { holderId: 'n', leaseExpiresAt: 'x' },
          { holderId: 'p', leaseExpiresAt: 9_000 },
          'q',
          { holderId: 'r' },
        ],
      } as unknown as LockRecord;
      const reduced = reduceAcquire(malformed, {
        holderId: 'b',
        now: 1_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(reduced.record.waiters).toStrictEqual([
        { holderId: 'p', leaseExpiresAt: 9_000 },
        { holderId: 'q' },
        { holderId: 'r' },
        { holderId: 'b', leaseExpiresAt: 6_000 },
      ]);
      expect(reduced.attempt.position).toBe(3);
    });

    it('reclaims an expired waiter at the inclusive boundary', () => {
      const queued: LockRecord = {
        holders: [],
        waiters: [{ holderId: 'b', leaseExpiresAt: 5_000 }],
      };
      const before = reduceAcquire(queued, {
        holderId: 'c',
        now: 4_999,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(before.attempt.acquired).toBe(false);
      const at = reduceAcquire(queued, { holderId: 'c', now: 5_000, leaseMs: 5_000, permits: 1 });
      expect(at.attempt.acquired).toBe(true);
    });

    it('refreshes an existing waiter lease in place, keeping its position', () => {
      const reduced = reduceAcquire(queueWithTwoWaiters(), {
        holderId: 'b',
        now: 3_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(reduced.record.waiters).toStrictEqual([
        { holderId: 'b', leaseExpiresAt: 8_000 },
        { holderId: 'c', leaseExpiresAt: 9_000 },
      ]);
      expect(reduced.attempt.position).toBe(0);
    });

    it('re-queues a caller whose own waiter entry expired at the tail', () => {
      const reduced = reduceAcquire(queueWithTwoWaiters(), {
        holderId: 'b',
        now: 6_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(reduced.record.waiters).toStrictEqual([
        { holderId: 'c', leaseExpiresAt: 9_000 },
        { holderId: 'b', leaseExpiresAt: 11_000 },
      ]);
      expect(reduced.attempt.position).toBe(1);
    });

    it('preserves survivor order when a non-head waiter expires', () => {
      const record: LockRecord = {
        holders: [{ holderId: 'a', leaseExpiresAt: 100_000 }],
        waiters: [
          { holderId: 'b', leaseExpiresAt: 20_000 },
          { holderId: 'c', leaseExpiresAt: 5_000 },
          { holderId: 'd', leaseExpiresAt: 20_000 },
        ],
      };
      const reduced = reduceAcquire(record, {
        holderId: 'd',
        now: 6_000,
        leaseMs: 5_000,
        permits: 1,
      });
      expect(reduced.record.waiters).toStrictEqual([
        { holderId: 'b', leaseExpiresAt: 20_000 },
        { holderId: 'd', leaseExpiresAt: 11_000 },
      ]);
      expect(reduced.attempt.position).toBe(1);
    });
  });

  describe('reduceRelease', () => {
    it('removes the holder and any stale waiter entry', () => {
      const held: LockRecord = {
        holders: [{ holderId: 'a', leaseExpiresAt: 6_000 }],
        waiters: [{ holderId: 'a' }, { holderId: 'b' }],
      };
      const released = reduceRelease(held, { holderId: 'a', now: 2_000 });
      expect(released.holders).toEqual([]);
      expect(released.waiters).toEqual([{ holderId: 'b' }]);
    });

    it('is a no-op for a holder that does not hold the lock', () => {
      const held: LockRecord = { holders: [{ holderId: 'a', leaseExpiresAt: 6_000 }], waiters: [] };
      const released = reduceRelease(held, { holderId: 'z', now: 2_000 });
      expect(released.holders).toEqual([{ holderId: 'a', leaseExpiresAt: 6_000 }]);
    });

    it('normalizes a legacy bare-string waiter without giving it a lease', () => {
      const released = reduceRelease(legacyRecord(), { holderId: 'a', now: 2_000 });
      expect(released.holders).toStrictEqual([]);
      expect(released.waiters).toStrictEqual([{ holderId: 'x' }]);
    });

    it('sweeps expired waiters', () => {
      const record: LockRecord = {
        holders: [{ holderId: 'a', leaseExpiresAt: 100_000 }],
        waiters: [
          { holderId: 'x', leaseExpiresAt: 2_000 },
          { holderId: 'y', leaseExpiresAt: 9_000 },
          { holderId: 'z' },
        ],
      };
      const released = reduceRelease(record, { holderId: 'a', now: 3_000 });
      expect(released.holders).toStrictEqual([]);
      expect(released.waiters).toStrictEqual([
        { holderId: 'y', leaseExpiresAt: 9_000 },
        { holderId: 'z' },
      ]);
    });
  });

  describe('reduceRenew', () => {
    it('extends the lease of a current holder', () => {
      const held: LockRecord = { holders: [{ holderId: 'a', leaseExpiresAt: 6_000 }], waiters: [] };
      const { record, renewed } = reduceRenew(held, { holderId: 'a', now: 4_000, leaseMs: 5_000 });
      expect(renewed).toBe(true);
      expect(record.holders).toEqual([{ holderId: 'a', leaseExpiresAt: 9_000 }]);
    });

    it('reports no renewal when the caller is not a holder', () => {
      const held: LockRecord = { holders: [{ holderId: 'a', leaseExpiresAt: 6_000 }], waiters: [] };
      const { renewed } = reduceRenew(held, { holderId: 'z', now: 4_000, leaseMs: 5_000 });
      expect(renewed).toBe(false);
    });

    it('normalizes a legacy bare-string waiter without giving it a lease', () => {
      const { record, renewed } = reduceRenew(legacyRecord(), {
        holderId: 'a',
        now: 2_000,
        leaseMs: 5_000,
      });
      expect(renewed).toBe(true);
      expect(record.waiters).toStrictEqual([{ holderId: 'x' }]);
    });

    it('sweeps expired waiters, never refreshes survivors, and never registers the caller', () => {
      const held: LockRecord = {
        holders: [{ holderId: 'a', leaseExpiresAt: 6_000 }],
        waiters: [
          { holderId: 'b', leaseExpiresAt: 2_000 },
          { holderId: 'c', leaseExpiresAt: 8_000 },
          { holderId: 'd' },
        ],
      };
      const byHolder = reduceRenew(held, { holderId: 'a', now: 4_000, leaseMs: 5_000 });
      expect(byHolder.renewed).toBe(true);
      expect(byHolder.record.holders).toStrictEqual([{ holderId: 'a', leaseExpiresAt: 9_000 }]);
      expect(byHolder.record.waiters).toStrictEqual([
        { holderId: 'c', leaseExpiresAt: 8_000 },
        { holderId: 'd' },
      ]);

      const byOutsider = reduceRenew(held, { holderId: 'z', now: 4_000, leaseMs: 5_000 });
      expect(byOutsider.renewed).toBe(false);
      expect(byOutsider.record.waiters).toStrictEqual([
        { holderId: 'c', leaseExpiresAt: 8_000 },
        { holderId: 'd' },
      ]);
    });
  });
});

describe('DurableSemaphore (promise-flavoured AtomicState slot)', () => {
  it('rejects non-positive-integer permit counts', () => {
    expect(() => new DurableSemaphore({ permits: 0 })).toThrow(RangeError);
    expect(() => new DurableSemaphore({ permits: 1.5 })).toThrow(RangeError);
  });

  it('rejects non-positive lease durations', () => {
    expect(() => new DurableSemaphore({ leaseMs: 0 })).toThrow(RangeError);
    expect(() => new DurableSemaphore({ leaseMs: -1 })).toThrow(RangeError);
  });

  it('serializes a mutex across two contenders and releases in FIFO order', async () => {
    const slot = makeSlot();
    const mutex = new DurableMutex({ leaseMs: 60_000 });

    const first = await mutex.tryAcquire(slot, { holderId: 'a', now: 1_000 });
    expect(first.acquired).toBe(true);

    const second = await mutex.tryAcquire(slot, { holderId: 'b', now: 1_000 });
    expect(second).toEqual({ acquired: false, position: 0 });

    // b cannot acquire while a holds the lease.
    const blocked = await mutex.tryAcquire(slot, { holderId: 'b', now: 2_000 });
    expect(blocked.acquired).toBe(false);

    await mutex.release(slot, { holderId: 'a', now: 3_000 });

    const promoted = await mutex.tryAcquire(slot, { holderId: 'b', now: 3_000 });
    expect(promoted.acquired).toBe(true);

    expect(await holderIds(mutex, slot)).toEqual(['b']);
  });

  it('limits concurrency to N permits', async () => {
    const slot = makeSlot();
    const semaphore = new DurableSemaphore({ permits: 2, leaseMs: 60_000 });

    const a = await semaphore.tryAcquire(slot, { holderId: 'a', now: 1_000 });
    const b = await semaphore.tryAcquire(slot, { holderId: 'b', now: 1_000 });
    const c = await semaphore.tryAcquire(slot, { holderId: 'c', now: 1_000 });
    expect([a.acquired, b.acquired, c.acquired]).toEqual([true, true, false]);

    expect(await holderIds(semaphore, slot)).toHaveLength(2);
  });

  it('frees a permit when a holder lease expires without a release', async () => {
    const slot = makeSlot();
    const mutex = new DurableMutex({ leaseMs: 5_000 });

    const held = await mutex.tryAcquire(slot, { holderId: 'a', now: 1_000 });
    expect(held.acquired).toBe(true);
    // b waits while a's lease is live.
    const waiting = await mutex.tryAcquire(slot, { holderId: 'b', now: 2_000 });
    expect(waiting.acquired).toBe(false);
    // a "crashes" and never releases. Once its lease (1_000 + 5_000 = 6_000)
    // elapses, b reclaims the lock.
    const reclaimed = await mutex.tryAcquire(slot, { holderId: 'b', now: 7_000 });
    expect(reclaimed.acquired).toBe(true);

    expect(await holderIds(mutex, slot)).toEqual(['b']);
  });

  it('reclaims a crashed head-of-queue waiter so a mutex does not deadlock', async () => {
    const slot = makeSlot();
    const mutex = new DurableMutex({ leaseMs: 5_000 });

    expect(await mutex.tryAcquire(slot, { holderId: 'a', now: 1_000 })).toMatchObject({
      acquired: true,
    });
    // b queues once and "crashes": it never calls again.
    expect(await mutex.tryAcquire(slot, { holderId: 'b', now: 1_000 })).toStrictEqual({
      acquired: false,
      position: 0,
    });
    await mutex.release(slot, { holderId: 'a', now: 2_000 });

    expect(await mutex.tryAcquire(slot, { holderId: 'c', now: 3_000 })).toStrictEqual({
      acquired: false,
      position: 1,
    });
    // b's waiter lease is 1_000 + 5_000 = 6_000.
    expect(await mutex.tryAcquire(slot, { holderId: 'c', now: 5_999 })).toMatchObject({
      acquired: false,
    });
    expect(await mutex.tryAcquire(slot, { holderId: 'c', now: 6_000 })).toMatchObject({
      acquired: true,
    });

    expect(await holderIds(mutex, slot)).toStrictEqual(['c']);
  });

  it('reclaims a crashed head-of-queue waiter even when semaphore permits are free', async () => {
    const slot = makeSlot();
    const semaphore = new DurableSemaphore({ permits: 2, leaseMs: 5_000 });

    await semaphore.tryAcquire(slot, { holderId: 'a', now: 1_000, leaseMs: 60_000 });
    await semaphore.tryAcquire(slot, { holderId: 'z', now: 1_000, leaseMs: 60_000 });
    expect(await semaphore.tryAcquire(slot, { holderId: 'b', now: 1_000 })).toStrictEqual({
      acquired: false,
      position: 0,
    });
    await semaphore.release(slot, { holderId: 'a', now: 2_000 });

    // A permit is free, but the dead waiter b still heads the queue.
    expect(await semaphore.tryAcquire(slot, { holderId: 'c', now: 3_000 })).toStrictEqual({
      acquired: false,
      position: 1,
    });
    expect(await semaphore.tryAcquire(slot, { holderId: 'c', now: 5_999 })).toMatchObject({
      acquired: false,
    });
    expect(await semaphore.tryAcquire(slot, { holderId: 'c', now: 6_000 })).toMatchObject({
      acquired: true,
    });

    expect(await holderIds(semaphore, slot)).toStrictEqual(['z', 'c']);
  });

  it('renews a held lease and reports failure for a non-holder', async () => {
    const slot = makeSlot();
    const mutex = new DurableMutex({ leaseMs: 5_000 });
    await mutex.tryAcquire(slot, { holderId: 'a', now: 1_000 });

    expect(await mutex.renew(slot, { holderId: 'a', now: 2_000 })).toBe(true);
    const record = await mutex.inspect(slot);
    expect(record?.holders).toEqual([{ holderId: 'a', leaseExpiresAt: 7_000 }]);

    expect(await mutex.renew(slot, { holderId: 'b', now: 2_000 })).toBe(false);
  });

  it('rejects a per-call lease that is not positive', () => {
    const slot = makeSlot();
    const mutex = new DurableMutex();
    // Lease validation runs synchronously before any CAS transaction starts.
    expect(() => mutex.tryAcquire(slot, { holderId: 'a', now: 1_000, leaseMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => mutex.renew(slot, { holderId: 'a', now: 1_000, leaseMs: -5 })).toThrow(RangeError);
  });
});

describe('DurableSemaphore (generator-flavoured ctx.state slot)', () => {
  // A minimal generator-flavoured slot mirroring the durable `ctx.state.*`
  // handle: methods return generators that the engine would drive. Backed by an
  // in-memory record so we can assert behaviour without a running engine.
  function makeGeneratorSlot() {
    let current: LockRecord | undefined = initialLockRecord();
    return {
      record: () => current,
      *get(): Generator<unknown, LockRecord | undefined, unknown> {
        return current;
      },
      *update(
        updater: (value: LockRecord | undefined) => LockRecord,
      ): Generator<unknown, LockRecord, unknown> {
        current = updater(current);
        return current;
      },
    };
  }

  function drive<T>(generator: Generator<unknown, T, unknown>): T {
    let step = generator.next();
    while (!step.done) step = generator.next();
    return step.value;
  }

  it('drives tryAcquire, renew, release, and inspect through the generator branch', () => {
    const slot = makeGeneratorSlot();
    const mutex = new DurableMutex({ leaseMs: 5_000 });

    const acquired = drive(mutex.tryAcquire(slot, { holderId: 'a', now: 1_000 }));
    expect(acquired).toEqual({ acquired: true, position: -1 });

    const renewed = drive(mutex.renew(slot, { holderId: 'a', now: 2_000 }));
    expect(renewed).toBe(true);

    const inspected = drive(mutex.inspect(slot));
    expect(inspected?.holders).toEqual([{ holderId: 'a', leaseExpiresAt: 7_000 }]);

    drive(mutex.release(slot, { holderId: 'a', now: 3_000 }));
    expect(slot.record()?.holders).toEqual([]);
  });

  it('throws when a slot returns neither a promise nor a generator', () => {
    const brokenSlot = {
      get: () => 'nope',
      update: () => 'nope',
    };
    const mutex = new DurableMutex();
    // The slot's update returns a bare string — neither a promise nor a
    // generator — so the slot-result mapper rejects it at runtime.
    expect(() => mutex.tryAcquire(brokenSlot, { holderId: 'a', now: 1_000 })).toThrow(TypeError);
  });
});
