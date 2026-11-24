import {
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
  storageConditionalBatch,
} from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { resolveNonEmptyPrefixRangeEnd } from '../../storage/non-empty-prefix-range-end.ts';
import { decode } from '../codec.ts';
import type { TimerEntry } from '../types.ts';
import { DEFAULT_POLL_INTERVAL_MS } from '../types/constants.ts';
import { buildTimerBatchOperations } from './timer-batch.ts';
import type { ScannedTimerEntry, TimerSource } from './timer-sources.ts';
import {
  advanceTimerSource,
  readNextScannedTimerEntry,
  readNextTeardownTimerEntry,
  readNextTerminalCleanupTimerEntry,
  selectNextTimerSource,
  shouldDeleteTimerIndexWithoutLookup,
} from './timer-sources.ts';

/**
 * What a timer callback resolves. `'retain'` keeps the entry in storage, without a log, for the
 * next scan to deliver again: the callback stood aside for another process that is still going,
 * and nothing it left behind would wake the timer's owner if that process died (COR-1925).
 */
export type TimerFiredOutcome = void | 'retain';

export interface SchedulerOptions {
  storage: Storage;
  onTimerFired: (entry: TimerEntry) => TimerFiredOutcome | Promise<TimerFiredOutcome>;
  pollIntervalMs?: number;
  getNow?: () => number;
  /**
   * Commit the batch that deletes a fired timer's keys after its callback
   * returns. Defaults to an unfenced `storage.batch`. The engine supplies a
   * lease-fenced commit (#563) so the fired-timer delete and the callback's own
   * follow-up writes share the same ownership fence — under deposition both are
   * rejected and the timer survives for the successor to re-drive. With no lease
   * held this commits exactly as the unfenced default would.
   */
  commitTimerCleanup?: (operations: BatchOperation[]) => Promise<void>;
}

type TimerScanIterators = {
  deadline: AsyncIterable<[string, Uint8Array]>;
  delayedStart: AsyncIterable<[string, Uint8Array]>;
  schedule: AsyncIterable<[string, Uint8Array]>;
  terminalCleanup: AsyncIterable<[string, Uint8Array]>;
  teardown: AsyncIterable<[string, Uint8Array]>;
};

/**
 * `skipped`: another delivery of the same timer owner is still in flight in this process, so
 * this one was not delivered and nothing about its entry was touched.
 */
type TimerProcessingResult = 'processed' | 'retry' | 'skipped';

/**
 * Who a timer delivery is on behalf of, for the in-flight guard. A schedule's callback is a tick
 * that can run for as long as a backfilled run's turn, and it re-arms the schedule's next entry
 * under another key while it is still going, so every entry of one schedule has one owner: the
 * schedule. Every other timer kind is its own owner, by its entry key.
 */
function timerOwnerOf(timer: ScannedTimerEntry): string {
  return timer.entry.kind === 'schedule'
    ? `schedule:${timer.entry.workflowId}`
    : `entry:${timer.key}`;
}

/**
 * Maximum expired timers read per timer source on one scheduler tick.
 * A larger backlog stays durable and is drained by later ticks, bounding
 * per-tick memory and callback work while preserving retry semantics.
 */
const EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE = 1_000;

/**
 * Scheduler manages durable timers and polls for expired deadlines.
 *
 * @example
 * ```ts
 * import { Scheduler } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * const storage = new MemoryStorage();
 * const scheduler = new Scheduler({
 *   storage,
 *   onTimerFired: (entry) => {
 *     console.log('timer fired:', entry.id, entry.kind);
 *   },
 *   pollIntervalMs: 500,
 * });
 *
 * scheduler.start();
 * // ... use scheduler ...
 * await scheduler.stop();
 * ```
 */
export class Scheduler implements Disposable {
  readonly #storage: Storage;
  readonly #onTimerFired: (entry: TimerEntry) => TimerFiredOutcome | Promise<TimerFiredOutcome>;
  #pollIntervalMs: number;
  readonly #getNow: () => number;
  readonly #commitTimerCleanup: (operations: BatchOperation[]) => Promise<void>;
  #intervalHandle: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  /**
   * The scans in flight (a tick or a flush), each as a promise that settles when the scan does and
   * never rejects, so {@link Scheduler.stop} can wait on them without taking a failure over from
   * the caller that owns the scan.
   */
  readonly #scansInFlight = new Set<Promise<void>>();
  /**
   * The owners whose timers this process is delivering, or has delivered and not yet cleaned up
   * (COR-1482). A scan reads an expired entry again on every poll until the scan that delivered
   * it has run its callback and committed its cleanup, so without this an overlapping scan hands
   * the same entry to a second callback. Process-local, like the serialization it stands in for.
   */
  readonly #ownersInFlight = new Map<string, symbol>();

  constructor(options: SchedulerOptions) {
    this.#storage = options.storage;
    this.#onTimerFired = options.onTimerFired;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#getNow = options.getNow ?? Date.now;
    this.#commitTimerCleanup =
      options.commitTimerCleanup ?? ((operations) => this.#storage.batch(operations));
  }

  /** Start the polling loop. */
  start(): void {
    if (this.#intervalHandle !== null) return;
    this.#stopped = false;
    this.#armPollInterval();
  }

  /**
   * Change the poll interval. A running poller is cleared and re-armed, so the next poll lands
   * one new interval from now; a poller that was never started, or was stopped, only remembers
   * the interval for its next {@link Scheduler.start}. Setting the interval it already has
   * leaves a running poller exactly as it is, so its phase is not reset.
   *
   * @throws {RangeError} When `pollIntervalMs` is not a positive safe integer.
   */
  setPollInterval(pollIntervalMs: number): void {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new RangeError('pollIntervalMs must be a positive safe integer');
    }
    if (pollIntervalMs === this.#pollIntervalMs) return;
    this.#pollIntervalMs = pollIntervalMs;
    if (this.#intervalHandle === null) return;
    clearInterval(this.#intervalHandle);
    this.#armPollInterval();
  }

  #armPollInterval(): void {
    this.#intervalHandle = setInterval(() => {
      void this.tick();
    }, this.#pollIntervalMs);
  }

  /**
   * Stop the polling loop, then wait for the scans already in flight to settle. No tick starts
   * after this call, and a tick in flight delivers no further timer; once the returned promise
   * resolves the scheduler makes no more storage calls, so a host can close its storage next. A
   * scan that fails reports its failure to the caller of that scan, never here: this promise
   * resolves either way. Concurrent calls wait for the same scans. It has no deadline of its own,
   * so a scan that never settles keeps it pending.
   *
   * Do not await it from inside a timer callback: the callback belongs to the scan being waited
   * for.
   */
  stop(): Promise<void> {
    this.#halt();
    return this.#settleScansInFlight();
  }

  /** Clear the poller and refuse further ticks, without waiting for anything. */
  #halt(): void {
    this.#stopped = true;
    if (this.#intervalHandle !== null) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
  }

  async #settleScansInFlight(): Promise<void> {
    while (this.#scansInFlight.size > 0) {
      await Promise.all(this.#scansInFlight);
    }
  }

  /** Run one scan and register it for {@link Scheduler.stop} to wait on until it settles. */
  #trackScan(scan: Promise<void>): Promise<void> {
    const tracked = scan.then(
      () => undefined,
      () => undefined,
    );
    this.#scansInFlight.add(tracked);
    void tracked.then(() => this.#scansInFlight.delete(tracked));
    return scan;
  }

  /** Schedule a durable timer (writes to storage). */
  async schedule(entry: TimerEntry): Promise<void> {
    await this.#storage.batch(buildTimerBatchOperations(entry));
  }

  /**
   * Cancel a timer (removes from storage). With `conditions`, the removal is one conditional
   * batch that also requires the timer index to still hold the value read here, so a timer
   * re-scheduled under the same id by a same-id replacement is never removed by a stale caller.
   */
  async cancel(
    id: string,
    _workflowId: string,
    conditions?: ConditionalBatchCondition[],
  ): Promise<void> {
    const indexKey = `timer-idx:${id}`;
    const indexValue = await this.#storage.get(indexKey);

    if (indexValue === null) return;

    const decoded = decode(indexValue);
    if (typeof decoded !== 'string') {
      console.error(`Corrupted timer index for ${id}: expected string, got ${typeof decoded}`);
      // Delete the corrupted index key so it does not cause permanent log spam.
      await this.#storage.delete(indexKey);
      return;
    }
    const deadlineKey = decoded;

    const deletes: BatchOperation[] = [
      { type: 'delete', key: deadlineKey },
      { type: 'delete', key: indexKey },
    ];
    if (conditions === undefined) {
      await this.#storage.batch(deletes);
      return;
    }
    await storageConditionalBatch(
      this.#storage,
      [...conditions, { key: indexKey, expectedValue: indexValue }],
      deletes,
    );
  }

  /** Force an immediate scan for expired timers (for tests). */
  async tick(now?: number): Promise<void> {
    if (this.#stopped) return;
    await this.#trackScan(this.#processExpiredTimers(now, { respectStopped: true }));
  }

  /** Process all expired timers then stop.
   *  Works even after stop() has been called — the intent is to drain remaining
   *  timers before final shutdown. Bypasses the #stopped guard so a
   *  stop()-then-flush() sequence works without re-enabling suspended interval
   *  ticks that might race with this drain.
   */
  async flush(now?: number): Promise<void> {
    await this.#trackScan(this.#processExpiredTimers(now, { respectStopped: false }));
    this.#halt();
  }

  /** Scan storage for expired timers, fire callbacks, and clean up keys.
   *  When `respectStopped` is true, an in-flight scan terminates early if
   *  stop() is called concurrently. flush() passes false so it can drain
   *  timers even after stop().
   */
  async #processExpiredTimers(
    now: number | undefined,
    { respectStopped }: { respectStopped: boolean },
  ): Promise<void> {
    const currentTime = now ?? this.#getNow();
    const timerSources = this.#createTimerSources(this.#scanExpiredTimers(currentTime));
    const cleanupOperations: BatchOperation[] = [];
    // What this scan claimed, released only once its cleanup has been committed: an entry whose
    // callback has returned is still in storage until then. Its own claims never block it: it
    // delivers its entries one after another.
    const claim = { token: Symbol('timer scan'), owners: [] as string[] };
    try {
      await this.#deliverExpiredTimers(timerSources, cleanupOperations, claim, respectStopped);
      await this.#deleteProcessedTimerKeys(cleanupOperations);
    } finally {
      for (const owner of claim.owners) this.#ownersInFlight.delete(owner);
    }
  }

  async #deliverExpiredTimers(
    timerSources: TimerSource[],
    cleanupOperations: BatchOperation[],
    claim: { token: symbol; owners: string[] },
    respectStopped: boolean,
  ): Promise<void> {
    for (const timerSource of timerSources) {
      await advanceTimerSource(timerSource, this.#storage);
    }

    while (true) {
      const selectedSource = selectNextTimerSource(timerSources);
      const nextEntry = selectedSource?.next;
      if (!nextEntry || !selectedSource) {
        break;
      }

      // Re-check #stopped before each callback so an interval-dispatched tick
      // terminates early when stop() or dispose is called concurrently. flush()
      // skips this check because its purpose is to drain remaining timers.
      if (respectStopped && this.#stopped) break;

      await this.#processSelectedTimer(nextEntry, cleanupOperations, claim);
      await advanceTimerSource(selectedSource, this.#storage);
    }
  }

  #scanExpiredTimers(currentTime: number): TimerScanIterators {
    return {
      deadline: this.#storage.scan('wf-deadline:', {
        lt: resolveNonEmptyPrefixRangeEnd(KEYS.deadline(currentTime, '')),
        limit: EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE,
      }),
      delayedStart: this.#storage.scan('wf-delayed:', {
        lt: resolveNonEmptyPrefixRangeEnd(KEYS.delayedStart(currentTime, '')),
        limit: EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE,
      }),
      schedule: this.#storage.scan('schedule-due:', {
        lt: resolveNonEmptyPrefixRangeEnd(KEYS.scheduleTick(currentTime, '')),
        limit: EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE,
      }),
      terminalCleanup: this.#storage.scan('wf-cleanup:', {
        lt: resolveNonEmptyPrefixRangeEnd(KEYS.terminalCleanup(currentTime, '')),
        limit: EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE,
      }),
      teardown: this.#storage.scan('wf-teardown:', {
        lt: resolveNonEmptyPrefixRangeEnd(KEYS.teardownTimer(currentTime, '')),
        limit: EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE,
      }),
    };
  }

  #createTimerSources(iterators: TimerScanIterators): TimerSource[] {
    return [
      {
        iterator: iterators.deadline[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextScannedTimerEntry,
      },
      {
        iterator: iterators.delayedStart[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextScannedTimerEntry,
      },
      {
        iterator: iterators.schedule[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextScannedTimerEntry,
      },
      {
        iterator: iterators.terminalCleanup[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextTerminalCleanupTimerEntry,
      },
      {
        iterator: iterators.teardown[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextTeardownTimerEntry,
      },
    ] satisfies TimerSource[];
  }

  async #processSelectedTimer(
    nextEntry: ScannedTimerEntry,
    cleanupOperations: BatchOperation[],
    claim: { token: symbol; owners: string[] },
  ): Promise<TimerProcessingResult> {
    // A delivery whose owner is in flight is skipped, and its entry is left exactly as it is: no
    // callback, no cleanup, no log. Cleaning it up would delete a timer the delivery in flight
    // has re-armed under the same key, and failing it would log on every poll. The scan after the
    // one in flight sees whatever that scan left.
    const owner = timerOwnerOf(nextEntry);
    const holder = this.#ownersInFlight.get(owner);
    if (holder !== undefined && holder !== claim.token) return 'skipped';
    if (holder === undefined) {
      this.#ownersInFlight.set(owner, claim.token);
      claim.owners.push(owner);
    }
    try {
      const outcome = await this.#onTimerFired(nextEntry.entry);
      if (outcome === 'retain') return 'retry';
    } catch (error) {
      // Callback failed — leave the timer in storage so it retries on the
      // next tick. Do not fall through to the delete below.
      console.error(`Timer callback failed for timer ${nextEntry.entry.id}:`, error);
      return 'retry';
    }

    await this.#appendTimerCleanupOperationsAfterCallback(nextEntry, cleanupOperations);
    return 'processed';
  }

  async #appendTimerCleanupOperationsAfterCallback(
    nextEntry: ScannedTimerEntry,
    cleanupOperations: BatchOperation[],
  ): Promise<void> {
    try {
      cleanupOperations.push(...(await this.#buildTimerCleanupOperations(nextEntry)));
    } catch (deleteError) {
      console.error(`Failed to delete timer keys for ${nextEntry.entry.id}:`, deleteError);
    }
  }

  async #deleteProcessedTimerKeys(cleanupOperations: BatchOperation[]): Promise<void> {
    if (cleanupOperations.length === 0) return;

    try {
      // Routed through the (engine-supplied, lease-fenced) cleanup commit so a
      // deposed engine cannot drop a fired timer while its fenced follow-up
      // write was rejected (#563). A rejected fenced commit throws here and is
      // logged-and-swallowed exactly like an unfenced batch failure: the timer
      // stays in storage and the successor re-drives it.
      await this.#commitTimerCleanup(cleanupOperations);
    } catch (deleteError) {
      console.error('Failed to delete timer keys for processed scheduler tick:', deleteError);
    }
  }

  async #buildTimerCleanupOperations(nextEntry: ScannedTimerEntry): Promise<BatchOperation[]> {
    const cleanupOperations: BatchOperation[] = [{ type: 'delete', key: nextEntry.key }];
    const indexDeleteOperation = await this.#buildTimerIndexDeleteOperation(nextEntry);
    if (indexDeleteOperation) {
      cleanupOperations.push(indexDeleteOperation);
    }

    return cleanupOperations;
  }

  async #buildTimerIndexDeleteOperation(
    nextEntry: ScannedTimerEntry,
  ): Promise<BatchOperation | null> {
    const indexKey = `timer-idx:${nextEntry.entry.id}`;
    // `sleep`/`wait-condition` (ADR 0002's claim-requiring wake kinds — see
    // `sleep-timer-acknowledgements.ts`) and `schedule` all reuse a
    // deterministic id that a REPLACEMENT run can re-arm at a different
    // deadline (`onTerminalConflict: 'start-new'` for sleep/wait-condition;
    // schedule's own re-arm-on-every-tick for schedule). Deleting the shared
    // `timer-idx:` entry unconditionally in that window would delete the
    // replacement's own fresh index, leaving its sleep/condition wait or next
    // tick permanently unable to be looked up. Route all three through the
    // same lookup-and-compare check: only delete when the index still points
    // at the exact deadline key that just fired.
    if (
      nextEntry.entry.kind === 'schedule' ||
      nextEntry.entry.kind === 'sleep' ||
      nextEntry.entry.kind === 'wait-condition'
    ) {
      return this.#buildLookupBasedTimerIndexDeleteOperation(nextEntry, indexKey);
    }

    return shouldDeleteTimerIndexWithoutLookup(nextEntry.entry)
      ? { type: 'delete', key: indexKey }
      : null;
  }

  async #buildLookupBasedTimerIndexDeleteOperation(
    nextEntry: ScannedTimerEntry,
    indexKey: string,
  ): Promise<BatchOperation | null> {
    const indexValue = await this.#storage.get(indexKey);
    if (indexValue === null) {
      return null;
    }

    const decodedIndexValue = decode(indexValue);

    // Schedule callbacks re-arm the next tick with the same timer id, and a
    // `start-new` replacement can re-arm a sleep/wait-condition timer at the
    // same deterministic id. Only remove the index when it still points at
    // the timer that just fired; otherwise we would delete the
    // freshly-registered replacement's own index entry.
    return typeof decodedIndexValue !== 'string' || decodedIndexValue === nextEntry.key
      ? { type: 'delete', key: indexKey }
      : null;
  }

  /**
   * Stop the poller without waiting: a synchronous dispose cannot. Use `await scheduler.stop()`
   * where a scan in flight must settle before the storage closes.
   */
  [Symbol.dispose](): void {
    void this.stop();
  }
}
