/**
 * The durable lock record and the pure reducers that mutate it. These are the
 * deterministic core of the {@link DurableSemaphore}/{@link DurableMutex}
 * primitives in `./concurrency.ts`: every acquire, release, and renew is one
 * pure function over a {@link LockRecord}, so the algorithm is trivially
 * replay-safe and unit-testable in isolation from any storage flavour.
 *
 * @module weft/core/concurrency-lock-record
 */

/**
 * One permit currently held against a {@link DurableSemaphore}. `leaseExpiresAt`
 * is the deterministic timestamp (milliseconds since epoch) after which the
 * permit may be reclaimed by another contender, preventing a crashed holder
 * from deadlocking the lock.
 *
 * @example
 * ```ts
 * import type { LockHolder } from 'weft';
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
 * The durable record persisted in a single CAS state slot. `holders` are the
 * permits currently granted (length never exceeds the semaphore's permit
 * count); `waiters` is the FIFO queue of holder ids waiting for a permit.
 *
 * @example
 * ```ts
 * import type { LockRecord } from 'weft';
 *
 * const record: LockRecord = {
 *   holders: [{ holderId: 'workflow-a', leaseExpiresAt: 1_717_000_030_000 }],
 *   waiters: ['workflow-b'],
 * };
 * void record;
 * ```
 */
export interface LockRecord {
  holders: LockHolder[];
  waiters: string[];
}

/**
 * Outcome of a single non-blocking acquire attempt.
 *
 * @example
 * ```ts
 * import type { AcquireAttempt } from 'weft';
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
 * import { initialLockRecord, AtomicState } from 'weft';
 * import { MemoryStorage } from 'weft/storage/memory';
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

function normalizeRecord(record: LockRecord | undefined): LockRecord {
  if (record === undefined) return initialLockRecord();
  return {
    holders: Array.isArray(record.holders) ? record.holders : [],
    waiters: Array.isArray(record.waiters) ? record.waiters : [],
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

  // Re-acquisition is idempotent: an existing holder renews its own lease.
  const existingIndex = liveHolders.findIndex((holder) => holder.holderId === holderId);
  if (existingIndex !== -1) {
    const renewed = liveHolders.map((holder, index) =>
      index === existingIndex ? { holderId, leaseExpiresAt: now + leaseMs } : holder,
    );
    return {
      record: { holders: renewed, waiters: record.waiters.filter((id) => id !== holderId) },
      attempt: { acquired: true, position: -1 },
    };
  }

  // Ensure the caller is registered in the FIFO queue exactly once.
  const waiters = record.waiters.includes(holderId)
    ? [...record.waiters]
    : [...record.waiters, holderId];

  const freePermits = permits - liveHolders.length;
  const isNextInLine = waiters[0] === holderId;

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
    attempt: { acquired: false, position: waiters.indexOf(holderId) },
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
    waiters: record.waiters.filter((id) => id !== holderId),
  };
}

/**
 * Pure reducer for renewing a held lease. Extends the holder's
 * `leaseExpiresAt`; a no-op if the caller is not currently a holder.
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
  return { record: { holders, waiters: record.waiters }, renewed };
}
