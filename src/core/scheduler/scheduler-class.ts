import type { BatchOperation, Storage } from '../../storage/interface.ts';
import { KEYS, resolvePrefixRangeEnd } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import type { TimerEntry } from '../types.ts';
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

export interface SchedulerOptions {
  storage: Storage;
  onTimerFired: (entry: TimerEntry) => void | Promise<void>;
  pollIntervalMs?: number;
  getNow?: () => number;
  /**
   * Commit the batch that deletes a fired timer's keys after its callback
   * returns. Defaults to an unfenced `storage.batch`. The engine supplies a
   * lease-fenced commit (#563) so that under deposition the fired-timer delete
   * shares fate with the callback's fenced reschedule/clear: if the engine has
   * lost the lease, BOTH are rejected and the timer survives at its (now past)
   * `fireAt` for the successor to re-drive — rather than the unfenced delete
   * landing while the fenced follow-up write is rejected, stranding durable
   * state with no timer. In the supported single-engine path the engine holds
   * the lease, so this commits exactly as the unfenced default would.
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

type TimerProcessingResult = 'processed' | 'retry';

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
 * import { MemoryStorage } from '@lostgradient/weft/storage/memory';
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
 * scheduler.stop();
 * ```
 */
export class Scheduler implements Disposable {
  readonly #storage: Storage;
  readonly #onTimerFired: (entry: TimerEntry) => void | Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #getNow: () => number;
  readonly #commitTimerCleanup: (operations: BatchOperation[]) => Promise<void>;
  #intervalHandle: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#storage = options.storage;
    this.#onTimerFired = options.onTimerFired;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#getNow = options.getNow ?? Date.now;
    this.#commitTimerCleanup =
      options.commitTimerCleanup ?? ((operations) => this.#storage.batch(operations));
  }

  /** Start the polling loop. */
  start(): void {
    if (this.#intervalHandle !== null) return;
    this.#stopped = false;

    this.#intervalHandle = setInterval(() => {
      void this.tick();
    }, this.#pollIntervalMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    this.#stopped = true;
    if (this.#intervalHandle !== null) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
  }

  /** Schedule a durable timer (writes to storage). */
  async schedule(entry: TimerEntry): Promise<void> {
    await this.#storage.batch(buildTimerBatchOperations(entry));
  }

  /** Cancel a timer (removes from storage). */
  async cancel(id: string, _workflowId: string): Promise<void> {
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

    await this.#storage.batch([
      { type: 'delete', key: deadlineKey },
      { type: 'delete', key: indexKey },
    ]);
  }

  /** Force an immediate scan for expired timers (for tests). */
  async tick(now?: number): Promise<void> {
    if (this.#stopped) return;
    await this.#processExpiredTimers(now, { respectStopped: true });
  }

  /** Process all expired timers then stop.
   *  Works even after stop() has been called — the intent is to drain remaining
   *  timers before final shutdown. Bypasses the #stopped guard so a
   *  stop()-then-flush() sequence works without re-enabling suspended interval
   *  ticks that might race with this drain.
   */
  async flush(now?: number): Promise<void> {
    await this.#processExpiredTimers(now, { respectStopped: false });
    this.stop();
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

    for (const timerSource of timerSources) {
      await advanceTimerSource(timerSource, this.#storage);
    }

    while (this.#hasPendingTimer(timerSources)) {
      const selectedSource = selectNextTimerSource(timerSources);
      const nextEntry = selectedSource?.next;
      if (!nextEntry || !selectedSource) {
        break;
      }

      // Re-check #stopped before each callback so an interval-dispatched tick
      // terminates early when stop() or dispose is called concurrently. flush()
      // skips this check because its purpose is to drain remaining timers.
      if (respectStopped && this.#stopped) break;

      const processingResult = await this.#processSelectedTimer(nextEntry, cleanupOperations);
      if (processingResult === 'retry') {
        await advanceTimerSource(selectedSource, this.#storage);
        continue;
      }

      await advanceTimerSource(selectedSource, this.#storage);
    }

    await this.#deleteProcessedTimerKeys(cleanupOperations);
  }

  #scanExpiredTimers(currentTime: number): TimerScanIterators {
    return {
      deadline: this.#storage.scan('wf-deadline:', {
        lt: resolvePrefixRangeEnd(KEYS.deadline(currentTime, '')),
        limit: EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE,
      }),
      delayedStart: this.#storage.scan('wf-delayed:', {
        lt: resolvePrefixRangeEnd(KEYS.delayedStart(currentTime, '')),
        limit: EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE,
      }),
      schedule: this.#storage.scan('schedule-due:', {
        lt: resolvePrefixRangeEnd(KEYS.scheduleTick(currentTime, '')),
        limit: EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE,
      }),
      terminalCleanup: this.#storage.scan('wf-cleanup:', {
        lt: resolvePrefixRangeEnd(KEYS.terminalCleanup(currentTime, '')),
        limit: EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE,
      }),
      teardown: this.#storage.scan('wf-teardown:', {
        lt: resolvePrefixRangeEnd(KEYS.teardownTimer(currentTime, '')),
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

  #hasPendingTimer(timerSources: TimerSource[]): boolean {
    return timerSources.some((timerSource) => timerSource.next !== null);
  }

  async #processSelectedTimer(
    nextEntry: ScannedTimerEntry,
    cleanupOperations: BatchOperation[],
  ): Promise<TimerProcessingResult> {
    try {
      await this.#onTimerFired(nextEntry.entry);
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
    if (nextEntry.entry.kind === 'schedule') {
      return this.#buildScheduleTimerIndexDeleteOperation(nextEntry, indexKey);
    }

    return shouldDeleteTimerIndexWithoutLookup(nextEntry.entry)
      ? { type: 'delete', key: indexKey }
      : null;
  }

  async #buildScheduleTimerIndexDeleteOperation(
    nextEntry: ScannedTimerEntry,
    indexKey: string,
  ): Promise<BatchOperation | null> {
    const indexValue = await this.#storage.get(indexKey);
    if (indexValue === null) {
      return null;
    }

    const decodedIndexValue = decode(indexValue);

    // Schedule callbacks re-arm the next tick with the same timer id.
    // Only remove the index when it still points at the timer that just
    // fired; otherwise we would delete the freshly-registered next tick.
    return typeof decodedIndexValue !== 'string' || decodedIndexValue === nextEntry.key
      ? { type: 'delete', key: indexKey }
      : null;
  }

  [Symbol.dispose](): void {
    this.stop();
  }
}
