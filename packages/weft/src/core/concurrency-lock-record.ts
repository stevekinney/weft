/**
 * The durable lock record and the pure reducers that mutate it. These are the
 * deterministic core of the {@link DurableSemaphore}/{@link DurableMutex}
 * primitives in `./concurrency.ts`: every acquire, release, and renew is one
 * pure function over a {@link LockRecord}, so the algorithm is trivially
 * replay-safe and unit-testable in isolation from any storage flavour.
 *
 * The waiter-lease design (expiring queue entries so a crashed head-of-queue
 * waiter cannot block the queue) is credited to goldcaddy77/weft commit
 * `e3f3316dc` (MIT license); this is an independent reimplementation.
 *
 * @module core/concurrency-lock-record
 */

/**
 * One permit currently held against a {@link DurableSemaphore}. `leaseExpiresAt`
 * is the deterministic timestamp (milliseconds since epoch) after which the
 * permit may be reclaimed by another contender, preventing a crashed holder
 * from deadlocking the lock.
 *
 * @example
 * ```ts
 * import type { LockHolder } from '@lostgradient/weft';
 *
 * const holder: LockHolder = { holderId: 'workflow-a', leaseExpiresAt: 1_717_000_030_000 };
 * void holder;
 * ```
 */
export interface LockHolder {
  /** Caller-chosen identifier for the holder (typically `ctx.workflowId`). */
  holderId: string;
  /** Timestamp (ms since epoch) after which this lease may be reclaimed. */
  leaseExpiresAt: number;
}

/**
 * One contender waiting in the FIFO queue. `leaseExpiresAt` bounds how long a
 * waiter may go without re-registering: every `tryAcquire` from a still-waiting
 * caller refreshes it to `now + leaseMs`, and a waiter whose lease is at or
 * before `now` is swept so a crashed head-of-queue waiter cannot block the
 * queue forever. A waiter must retry within `leaseMs` of its previous call, or
 * it is swept and re-queued at the tail on its next call (losing its position;
 * a waiter that always polls slower than its lease can be starved).
 *
 * Records persisted before this type existed may hold bare-string waiters
 * until their next reducer write; a legacy waiter normalizes to `{ holderId }`
 * with no `leaseExpiresAt` (never expiring) and only receives a lease when it
 * next re-registers through `tryAcquire`.
 *
 * @example
 * ```ts
 * import type { LockWaiter } from '@lostgradient/weft';
 *
 * const waiter: LockWaiter = { holderId: 'workflow-b', leaseExpiresAt: 1_717_000_030_000 };
 * void waiter;
 * ```
 */
export interface LockWaiter {
  /** Caller-chosen identifier for the waiter (typically `ctx.workflowId`). */
  holderId: string;
  /** Timestamp (ms since epoch) at or after which this queue entry may be reclaimed. */
  leaseExpiresAt?: number;
}

/**
 * The durable record persisted in a single CAS state slot. `holders` are the
 * permits currently granted (length never exceeds the semaphore's permit
 * count); `waiters` is the FIFO queue of {@link LockWaiter} entries waiting for
 * a permit.
 *
 * @example
 * ```ts
 * import type { LockRecord } from '@lostgradient/weft';
 *
 * const record: LockRecord = {
 *   holders: [{ holderId: 'workflow-a', leaseExpiresAt: 1_717_000_030_000 }],
 *   waiters: [{ holderId: 'workflow-b', leaseExpiresAt: 1_717_000_030_000 }],
 * };
 * void record;
 * ```
 */
export interface LockRecord {
  holders: LockHolder[];
  waiters: LockWaiter[];
}

/**
 * Outcome of a single non-blocking acquire attempt.
 *
 * @example
 * ```ts
 * import type { AcquireAttempt } from '@lostgradient/weft';
 *
 * const attempt: AcquireAttempt = { acquired: false, position: 0 };
 * if (!attempt.acquired) {
 *   // attempt.position is the caller's place in the FIFO queue.
 * }
 * ```
 */
export interface AcquireAttempt {
  /** Whether the caller now holds a permit. */
  acquired: boolean;
  /**
   * Zero-based position in the FIFO waiter queue when `acquired` is `false`.
   * `0` means the caller is next in line. `-1` when `acquired` is `true`.
   */
  position: number;
}

/**
 * A fresh empty {@link LockRecord}. Pass this as the `initial` option when
 * constructing the CAS state handle so the first reader sees an empty lock
 * rather than `undefined`.
 *
 * @example
 * ```ts
 * import { initialLockRecord, AtomicState } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/weft';
 *
 * const slot = new AtomicState(new MemoryStorage(), 'state:workflow-scope:default:lock', {
 *   initial: initialLockRecord(),
 * });
 * void slot;
 * ```
 */
export function initialLockRecord(): LockRecord {
  return { holders: [], waiters: [] };
}

/**
 * Normalize one persisted waiter entry. The record is untrusted and reducers
 * run inside a CAS updater, so this never throws: legacy bare strings become
 * `{ holderId }`, valid objects are rebuilt with only known keys, and anything
 * else is dropped (a live waiter re-registers on its next `tryAcquire`).
 */
function normalizeWaiter(entry: unknown): LockWaiter | undefined {
  if (typeof entry === 'string') return { holderId: entry };
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { holderId, leaseExpiresAt } = entry as { holderId?: unknown; leaseExpiresAt?: unknown };
  if (typeof holderId !== 'string') return undefined;
  if (!('leaseExpiresAt' in entry)) return { holderId };
  if (typeof leaseExpiresAt !== 'number' || !Number.isFinite(leaseExpiresAt)) return undefined;
  return { holderId, leaseExpiresAt };
}

function normalizeRecord(record: LockRecord | undefined): LockRecord {
  if (record === undefined) return initialLockRecord();
  const waiters: LockWaiter[] = [];
  if (Array.isArray(record.waiters)) {
    for (const entry of record.waiters as unknown[]) {
      const waiter = normalizeWaiter(entry);
      if (waiter !== undefined) waiters.push(waiter);
    }
  }
  return {
    holders: Array.isArray(record.holders) ? record.holders : [],
    waiters,
  };
}

/**
 * Drop expired leases from `holders`. A lease is expired when its
 * `leaseExpiresAt` is at or before `now`; reclaiming it is what frees a lock
 * held by a crashed workflow.
 */
function dropExpiredHolders(holders: LockHolder[], now: number): LockHolder[] {
  return holders.filter((holder) => holder.leaseExpiresAt > now);
}

/**
 * Drop expired waiters from the queue. A waiter is expired when its
 * `leaseExpiresAt` is set and at or before `now`; a waiter with no lease
 * never expires. Survivor order is preserved.
 */
function dropExpiredWaiters(waiters: LockWaiter[], now: number): LockWaiter[] {
  return waiters.filter(
    (waiter) => waiter.leaseExpiresAt === undefined || waiter.leaseExpiresAt > now,
  );
}

/**
 * Pure reducer for one acquire attempt. Returns the next record alongside
 * whether the caller acquired a permit and its queue position. Deterministic
 * in its inputs so it replays identically.
 */
export function reduceAcquire(
  current: LockRecord | undefined,
  options: { holderId: string; now: number; leaseMs: number; permits: number },
): { record: LockRecord; attempt: AcquireAttempt } {
  const { holderId, now, leaseMs, permits } = options;
  const record = normalizeRecord(current);

  // Reclaim any leases that have expired before deciding anything else.
  const liveHolders = dropExpiredHolders(record.holders, now);
  const liveWaiters = dropExpiredWaiters(record.waiters, now);

  // Re-acquisition is idempotent: an existing holder renews its own lease.
  const existingIndex = liveHolders.findIndex((holder) => holder.holderId === holderId);
  if (existingIndex !== -1) {
    const renewed = liveHolders.map((holder, index) =>
      index === existingIndex ? { holderId, leaseExpiresAt: now + leaseMs } : holder,
    );
    return {
      record: {
        holders: renewed,
        waiters: liveWaiters.filter((waiter) => waiter.holderId !== holderId),
      },
      attempt: { acquired: true, position: -1 },
    };
  }

  // Ensure the caller is registered in the FIFO queue exactly once, refreshing
  // its waiter lease (keeping its position) on every attempt.
  const registered: LockWaiter = { holderId, leaseExpiresAt: now + leaseMs };
  const waiterIndex = liveWaiters.findIndex((waiter) => waiter.holderId === holderId);
  const waiters =
    waiterIndex === -1
      ? [...liveWaiters, registered]
      : liveWaiters.map((waiter, index) => (index === waiterIndex ? registered : waiter));

  const freePermits = permits - liveHolders.length;
  const isNextInLine = waiters[0]?.holderId === holderId;

  if (freePermits > 0 && isNextInLine) {
    return {
      record: {
        holders: [...liveHolders, { holderId, leaseExpiresAt: now + leaseMs }],
        waiters: waiters.slice(1),
      },
      attempt: { acquired: true, position: -1 },
    };
  }

  return {
    record: { holders: liveHolders, waiters },
    attempt: {
      acquired: false,
      position: waiters.findIndex((waiter) => waiter.holderId === holderId),
    },
  };
}

/**
 * Pure reducer for releasing a permit. Removes the holder (and any stale waiter
 * entry) and reclaims expired leases so the record stays clean.
 */
export function reduceRelease(
  current: LockRecord | undefined,
  options: { holderId: string; now: number },
): LockRecord {
  const { holderId, now } = options;
  const record = normalizeRecord(current);
  return {
    holders: dropExpiredHolders(record.holders, now).filter(
      (holder) => holder.holderId !== holderId,
    ),
    waiters: dropExpiredWaiters(record.waiters, now).filter(
      (waiter) => waiter.holderId !== holderId,
    ),
  };
}

/**
 * Pure reducer for renewing a held lease. Extends the holder's
 * `leaseExpiresAt`; a no-op if the caller is not currently a holder. It never
 * adds or refreshes waiters, though it sweeps expired ones like the other reducers.
 */
export function reduceRenew(
  current: LockRecord | undefined,
  options: { holderId: string; now: number; leaseMs: number },
): { record: LockRecord; renewed: boolean } {
  const { holderId, now, leaseMs } = options;
  const record = normalizeRecord(current);
  const liveHolders = dropExpiredHolders(record.holders, now);
  let renewed = false;
  const holders = liveHolders.map((holder) => {
    if (holder.holderId === holderId) {
      renewed = true;
      return { holderId, leaseExpiresAt: now + leaseMs };
    }
    return holder;
  });
  return { record: { holders, waiters: dropExpiredWaiters(record.waiters, now) }, renewed };
}
