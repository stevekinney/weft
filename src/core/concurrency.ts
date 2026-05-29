/**
 * Durable concurrency primitives — a counting semaphore and a mutex built on
 * top of the compare-and-swap state slots exposed by `ctx.state.*` and
 * `engine.state.*`.
 *
 * Workflows frequently need to serialize access to a shared resource: only one
 * workflow may charge a customer at a time, at most three may hit a
 * rate-limited API concurrently, and so on. The building block already exists —
 * {@link AtomicState} gives you a single CAS-backed state slot — but reusing it
 * correctly (with FIFO fairness and a lease that frees the lock if a holder
 * crashes) is fiddly. {@link DurableSemaphore} and {@link DurableMutex} package
 * that algorithm so you do not have to hand-roll it.
 *
 * The primitives store a single {@link LockRecord} in one CAS slot. Each
 * `acquire`/`release` is a CAS transaction over that record, so every mutation
 * is durable, replay-safe, and recovered automatically after a crash. The
 * primitive never reads the wall clock itself: callers pass a deterministic
 * `now` (captured durably, e.g. via a clock activity) so the lease arithmetic
 * replays identically. A holder whose lease has expired is reclaimed by the
 * next contender, which is what prevents a crashed holder from deadlocking the
 * lock forever.
 *
 * @module weft/core/concurrency
 */

import {
  reduceAcquire,
  reduceRelease,
  reduceRenew,
  type AcquireAttempt,
  type LockRecord,
} from './concurrency-lock-record.ts';

export {
  initialLockRecord,
  reduceAcquire,
  reduceRelease,
  reduceRenew,
} from './concurrency-lock-record.ts';
export type { AcquireAttempt, LockHolder, LockRecord } from './concurrency-lock-record.ts';

/**
 * Minimal CAS state-slot surface shared by the durable `ctx.state.*` handles
 * (whose methods are workflow operations) and the admin `engine.state.*`
 * handles (whose methods are promises). `RUpdate` is the result of `update`
 * and `RGet` the result of `get`; both are a `Promise` for {@link AtomicState}
 * and a workflow-operation generator for `ctx.state.*`. They are decoupled
 * because `get` may resolve to `T | undefined` while `update` resolves to `T`.
 * Both {@link AtomicState} and the durable `ctx.state.*` handles satisfy this
 * structurally, so the same primitive drives both flavours.
 *
 * @example
 * ```ts
 * import { AtomicState, type CasSlot, type LockRecord } from 'weft';
 * import { MemoryStorage } from 'weft/storage/memory';
 *
 * // AtomicState satisfies CasSlot structurally (its methods return promises).
 * const slot: CasSlot<LockRecord, Promise<LockRecord>, Promise<LockRecord | undefined>> =
 *   new AtomicState<LockRecord>(new MemoryStorage(), 'state:workflow-scope:default:lock');
 * void slot;
 * ```
 */
export interface CasSlot<T, RUpdate, RGet = RUpdate> {
  get(): RGet;
  update(updater: (current: T | undefined) => T): RUpdate;
}

/**
 * Validate that the configured permit count is a positive integer.
 */
function assertValidPermits(permits: number): void {
  if (!Number.isInteger(permits) || permits < 1) {
    throw new RangeError(
      `DurableSemaphore permits must be a positive integer, received ${permits}`,
    );
  }
}

/**
 * Validate that a lease duration is a positive finite number of milliseconds.
 */
function assertValidLease(leaseMs: number): void {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new RangeError(
      `DurableSemaphore lease must be a positive number of milliseconds, received ${leaseMs}`,
    );
  }
}

/**
 * Options for {@link DurableSemaphore} and {@link DurableMutex}.
 *
 * @example
 * ```ts
 * import { DurableSemaphore, type DurableSemaphoreOptions } from 'weft';
 *
 * const options: DurableSemaphoreOptions = { permits: 3, leaseMs: 60_000 };
 * const semaphore = new DurableSemaphore(options);
 * void semaphore;
 * ```
 */
export interface DurableSemaphoreOptions {
  /**
   * Number of permits. At most this many holders may hold the lock at once.
   * Defaults to `1` (a mutex).
   */
  permits?: number;
  /**
   * Default lease duration in milliseconds applied to an acquired permit when
   * an explicit `leaseMs` is not supplied to `acquire`. A permit whose lease
   * expires may be reclaimed by another contender, which is what frees the lock
   * when a holder crashes without releasing. Defaults to `30_000`.
   */
  leaseMs?: number;
}

const DEFAULT_LEASE_MS = 30_000;

/**
 * A durable counting semaphore: at most `permits` holders may hold the lock at
 * once. Built entirely on a single compare-and-swap state slot, so it works
 * inside workflows (via `ctx.state.*`) and from admin code (via
 * `engine.state.*`).
 *
 * The semaphore is intentionally non-blocking at the slot level: `tryAcquire`
 * performs one CAS transaction and reports whether the permit was granted. The
 * caller decides how to wait between attempts — inside a workflow you
 * `yield* ctx.sleep(...)` between retries so the wait is durable and
 * replay-safe.
 *
 * Fairness is FIFO: a contender enqueues itself and only acquires once it
 * reaches the head of the waiter queue and a permit is free. Each granted
 * permit carries a lease; an expired lease is reclaimed by the next contender,
 * so a crashed holder cannot deadlock the lock forever.
 *
 * @example
 * ```ts
 * import { DurableSemaphore } from 'weft';
 * import { AtomicState } from 'weft';
 * import { MemoryStorage } from 'weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const slot = new AtomicState<import('weft').LockRecord>(
 *   storage,
 *   'state:workflow-scope:default:rate-limit:lock',
 *   { initial: { holders: [], waiters: [] } },
 * );
 * const semaphore = new DurableSemaphore({ permits: 3, leaseMs: 60_000 });
 * const attempt = await semaphore.tryAcquire(slot, { holderId: 'worker-1', now: Date.now() });
 * if (attempt.acquired) {
 *   try {
 *     // ...use the shared resource...
 *   } finally {
 *     await semaphore.release(slot, { holderId: 'worker-1', now: Date.now() });
 *   }
 * }
 * ```
 */
export class DurableSemaphore {
  readonly permits: number;
  readonly leaseMs: number;

  constructor(options: DurableSemaphoreOptions = {}) {
    const permits = options.permits ?? 1;
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    assertValidPermits(permits);
    assertValidLease(leaseMs);
    this.permits = permits;
    this.leaseMs = leaseMs;
  }

  /**
   * Attempt to acquire a permit with a single CAS transaction. Returns whether
   * the permit was granted and the caller's FIFO queue position when it was
   * not. The caller is registered in the waiter queue on a failed attempt so a
   * subsequent retry preserves FIFO order.
   *
   * `RUpdate` is the slot's `update` return type — a `Promise` for
   * {@link AtomicState} or a workflow-operation generator for `ctx.state.*`.
   */
  tryAcquire<RUpdate>(
    slot: CasSlot<LockRecord, RUpdate>,
    options: { holderId: string; now: number; leaseMs?: number },
  ): AcquireWithSlot<RUpdate> {
    const leaseMs = options.leaseMs ?? this.leaseMs;
    assertValidLease(leaseMs);
    let attempt: AcquireAttempt = { acquired: false, position: -1 };
    const update = slot.update((current) => {
      const reduced = reduceAcquire(current, {
        holderId: options.holderId,
        now: options.now,
        leaseMs,
        permits: this.permits,
      });
      attempt = reduced.attempt;
      return reduced.record;
    });
    return mapSlotResult(update, () => attempt);
  }

  /**
   * Release a held permit with a single CAS transaction. Idempotent: releasing
   * a permit the caller does not hold simply removes any stale waiter entry.
   */
  release<RUpdate>(
    slot: CasSlot<LockRecord, RUpdate>,
    options: { holderId: string; now: number },
  ): RUpdate {
    return slot.update((current) => reduceRelease(current, options));
  }

  /**
   * Extend the lease on a held permit. Long-running holders renew before their
   * lease expires so a contender does not reclaim a still-active permit.
   * Resolves/returns `false` when the caller is not currently a holder.
   */
  renew<RUpdate>(
    slot: CasSlot<LockRecord, RUpdate>,
    options: { holderId: string; now: number; leaseMs?: number },
  ): RenewWithSlot<RUpdate> {
    const leaseMs = options.leaseMs ?? this.leaseMs;
    assertValidLease(leaseMs);
    let renewed = false;
    const update = slot.update((current) => {
      const reduced = reduceRenew(current, {
        holderId: options.holderId,
        now: options.now,
        leaseMs,
      });
      renewed = reduced.renewed;
      return reduced.record;
    });
    return mapSlotResult(update, () => renewed);
  }

  /**
   * Read the current record without mutating it. `RGet` is the slot's `get`
   * return type — a `Promise<LockRecord | undefined>` for {@link AtomicState}
   * or a workflow-operation generator for `ctx.state.*`.
   */
  inspect<RGet>(slot: CasSlot<LockRecord, unknown, RGet>): RGet {
    return slot.get();
  }
}

/**
 * A durable mutual-exclusion lock: a {@link DurableSemaphore} with exactly one
 * permit, so at most one holder at a time. Acquire it with `tryAcquire` and
 * `yield* ctx.sleep(...)` between retries to wait durably for release.
 *
 * @example
 * ```ts
 * import { DurableMutex } from 'weft';
 * import { workflow, type WorkflowContext, type LockRecord } from 'weft';
 *
 * const transfer = workflow({ name: 'transfer' }).execute(async function* (ctx: WorkflowContext) {
 *   const slot = ctx.state.workflow<LockRecord>('account-42:lock', {
 *     initial: { holders: [], waiters: [] },
 *   });
 *   const mutex = new DurableMutex({ leaseMs: 60_000 });
 *   const now = yield* ctx.run(() => Date.now());
 *   yield* mutex.tryAcquire(slot, { holderId: ctx.workflowId, now });
 *   try {
 *     // ...critical section...
 *   } finally {
 *     const releaseNow = yield* ctx.run(() => Date.now());
 *     yield* mutex.release(slot, { holderId: ctx.workflowId, now: releaseNow });
 *   }
 * });
 * void transfer;
 * ```
 */
export class DurableMutex extends DurableSemaphore {
  constructor(options: Omit<DurableSemaphoreOptions, 'permits'> = {}) {
    super({ ...options, permits: 1 });
  }
}

// ---------------------------------------------------------------------------
// Slot-result mapping
//
// A CAS slot's `update`/`get` returns either a Promise (admin AtomicState) or a
// workflow-operation generator (ctx.state.*). The primitives need to surface a
// derived value (the AcquireAttempt / renewed flag) once the slot mutation
// settles, without the caller caring which flavour they passed.
// ---------------------------------------------------------------------------

/**
 * Result of {@link DurableSemaphore.tryAcquire}, mirroring the slot's flavour:
 * a `Promise<AcquireAttempt>` when the slot's `update` returns a promise (an
 * {@link AtomicState}), or a workflow-operation generator otherwise.
 *
 * @example
 * ```ts
 * import type { AcquireAttempt, AcquireWithSlot } from 'weft';
 *
 * type PromiseResult = AcquireWithSlot<Promise<unknown>>; // Promise<AcquireAttempt>
 * const result: PromiseResult = Promise.resolve<AcquireAttempt>({ acquired: true, position: -1 });
 * void result;
 * ```
 */
export type AcquireWithSlot<R> =
  R extends Promise<unknown>
    ? Promise<AcquireAttempt>
    : Generator<unknown, AcquireAttempt, unknown>;

/**
 * Result of {@link DurableSemaphore.renew}, mirroring the slot's flavour: a
 * `Promise<boolean>` for an {@link AtomicState} slot, or a workflow-operation
 * generator that yields to a `boolean` for a `ctx.state.*` slot.
 *
 * @example
 * ```ts
 * import type { RenewWithSlot } from 'weft';
 *
 * type PromiseResult = RenewWithSlot<Promise<unknown>>; // Promise<boolean>
 * const result: PromiseResult = Promise.resolve(true);
 * void result;
 * ```
 */
export type RenewWithSlot<R> =
  R extends Promise<unknown> ? Promise<boolean> : Generator<unknown, boolean, unknown>;

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  );
}

function isGenerator(value: unknown): value is Generator<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'next' in value &&
    typeof (value as { next: unknown }).next === 'function'
  );
}

/**
 * Drive a slot's `update` result (Promise or generator) to completion, then
 * surface a derived value computed by `derive`. The return type follows the
 * slot's flavour so workflow callers can `yield*` and admin callers can
 * `await`.
 */
function mapSlotResult<R, V>(
  result: R,
  derive: () => V,
): R extends Promise<unknown> ? Promise<V> : Generator<unknown, V, unknown> {
  if (isPromise(result)) {
    const mapped = result.then(() => derive());
    // `result` is a Promise, so the conditional return type resolves to
    // `Promise<V>` — the assertion narrows the union the compiler cannot.
    return mapped as R extends Promise<unknown> ? Promise<V> : Generator<unknown, V, unknown>;
  }
  if (isGenerator(result)) {
    const generator = result;
    const mapped = (function* (): Generator<unknown, V, unknown> {
      yield* generator;
      return derive();
    })();
    // `result` is a generator, so the conditional return type resolves to the
    // generator branch — the assertion narrows the union the compiler cannot.
    return mapped as R extends Promise<unknown> ? Promise<V> : Generator<unknown, V, unknown>;
  }
  throw new TypeError('CAS slot update must return a Promise or a workflow-operation generator');
}
