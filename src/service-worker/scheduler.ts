/**
 * Browser-compatible timer scheduler for Service Worker environments.
 *
 * Replaces the server-side Scheduler with one that uses
 * Periodic Background Sync (where available) or falls back to
 * `setTimeout`-based polling.
 *
 * @module service-worker/scheduler
 */

import { decode } from '../core/codec';
import { buildTimerBatchOperations } from '../core/scheduler';
import type { TimerEntry } from '../core/types';
import type { Storage } from '../storage/interface';
import { KEYS, resolvePrefixRangeEnd } from '../storage/interface';

// ---------------------------------------------------------------------------
// Periodic sync type (not in default lib but used at runtime in browsers)
// ---------------------------------------------------------------------------

interface PeriodicSyncManager {
  register(tag: string, options?: { minInterval?: number }): Promise<void>;
}

interface RegistrationWithPeriodicSync extends ServiceWorkerRegistration {
  periodicSync?: PeriodicSyncManager;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link ServiceWorkerScheduler}.
 *
 * @example
 * ```ts
 * import { ServiceWorkerScheduler, type ServiceWorkerSchedulerOptions } from '@lostgradient/weft/service-worker';
 * import { MemoryStorage } from '@lostgradient/weft';
 *
 * const storage = new MemoryStorage();
 *
 * const options: ServiceWorkerSchedulerOptions = {
 *   storage,
 *   onTimerFired: (entry) => {
 *     console.log(`Timer ${entry.id} fired.`);
 *   },
 * };
 * const scheduler = new ServiceWorkerScheduler(options);
 * void scheduler;
 * ```
 */
export interface ServiceWorkerSchedulerOptions {
  storage: Storage;
  onTimerFired: (entry: TimerEntry) => void | Promise<void>;
  registration?: ServiceWorkerRegistration;
  periodicSyncTag?: string;
  fallbackIntervalMilliseconds?: number;
  getNow?: () => number;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_PERIODIC_SYNC_TAG = 'weft-timers';
const DEFAULT_FALLBACK_INTERVAL_MILLISECONDS = 60_000;
const DEFAULT_PERIODIC_SYNC_MIN_INTERVAL = 60_000;

// ---------------------------------------------------------------------------
// ServiceWorkerScheduler
// ---------------------------------------------------------------------------

/**
 * Scheduler for browser Service Worker environments, backed by durable storage.
 *
 * @example
 * ```ts
 * import { ServiceWorkerScheduler, createPeriodicSyncHandler } from '@lostgradient/weft/service-worker';
 * import { MemoryStorage } from '@lostgradient/weft';
 *
 * const storage = new MemoryStorage();
 *
 * const scheduler = new ServiceWorkerScheduler({
 *   storage,
 *   onTimerFired: (entry) => {
 *     console.log(`Timer ${entry.id} fired.`);
 *   },
 * });
 *
 * const handlePeriodicSync = createPeriodicSyncHandler(scheduler);
 * void handlePeriodicSync;
 * ```
 */
export class ServiceWorkerScheduler implements Disposable {
  readonly #storage: Storage;
  readonly #onTimerFired: (entry: TimerEntry) => void | Promise<void>;
  readonly #registration: RegistrationWithPeriodicSync | undefined;
  readonly #periodicSyncTag: string;
  readonly #fallbackIntervalMilliseconds: number;
  readonly #getNow: () => number;
  #timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #generation = 0;

  constructor(options: ServiceWorkerSchedulerOptions) {
    this.#storage = options.storage;
    this.#onTimerFired = options.onTimerFired;
    this.#registration = options.registration;
    this.#periodicSyncTag = options.periodicSyncTag ?? DEFAULT_PERIODIC_SYNC_TAG;
    this.#fallbackIntervalMilliseconds =
      options.fallbackIntervalMilliseconds ?? DEFAULT_FALLBACK_INTERVAL_MILLISECONDS;
    this.#getNow = options.getNow ?? Date.now;
  }

  /** Schedule a durable timer (writes to storage). */
  async schedule(entry: TimerEntry): Promise<void> {
    await this.#storage.batch(buildTimerBatchOperations(entry));
  }

  /** Cancel a timer (removes from storage). */
  async cancel(id: string): Promise<void> {
    const indexKey = `timer-idx:${id}`;
    const indexValue = await this.#storage.get(indexKey);

    if (indexValue === null) return;

    const deadlineKey = decode(indexValue) as string;

    await this.#storage.batch([
      { type: 'delete', key: deadlineKey },
      { type: 'delete', key: indexKey },
    ]);
  }

  /** Scan for expired timers, fire callbacks, and clean up. */
  async tick(now?: number): Promise<void> {
    const currentTime = now ?? this.#getNow();

    const expired: Array<{ key: string; entry: TimerEntry }> = [];

    for await (const [key, value] of this.#storage.scan('wf-deadline:', {
      lt: resolvePrefixRangeEnd(KEYS.deadline(currentTime, '')),
    })) {
      const entry = decode(value) as TimerEntry;
      expired.push({ key, entry });
    }

    for await (const [key, value] of this.#storage.scan('wf-delayed:', {
      lt: resolvePrefixRangeEnd(KEYS.delayedStart(currentTime, '')),
    })) {
      const entry = decode(value) as TimerEntry;
      expired.push({ key, entry });
    }

    expired.sort((left, right) => {
      if (left.entry.fireAt !== right.entry.fireAt) {
        return left.entry.fireAt - right.entry.fireAt;
      }

      return left.key.localeCompare(right.key);
    });

    for (const { key, entry } of expired) {
      try {
        await this.#onTimerFired(entry);
      } catch (error) {
        console.error(`Timer callback failed for timer ${entry.id}:`, error);
        continue;
      }

      const indexKey = `timer-idx:${entry.id}`;
      await this.#storage.batch([
        { type: 'delete', key },
        { type: 'delete', key: indexKey },
      ]);
    }
  }

  /** Process all expired timers then stop. */
  async flush(now?: number): Promise<void> {
    await this.tick(now);
    this.stop();
  }

  /** Start the scheduler. Uses Periodic Background Sync if available, otherwise falls back to setTimeout polling. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#generation++;

    const periodicSync = this.#registration?.periodicSync;

    if (periodicSync) {
      // Capture the generation so the async .catch() handler can detect a
      // stop()/start() cycle that happened while the registration was pending.
      // Without this, the deferred handler could create a duplicate polling loop.
      const startGeneration = this.#generation;

      void periodicSync
        .register(this.#periodicSyncTag, {
          minInterval: DEFAULT_PERIODIC_SYNC_MIN_INTERVAL,
        })
        .catch(() => {
          if (this.#generation !== startGeneration) return;
          // Periodic sync registration failed — fall back to polling
          this.#schedulePoll();
        });
      return;
    }

    this.#schedulePoll();
  }

  /** Stop the scheduler and clear all timeout handles. */
  stop(): void {
    this.#running = false;
    this.#generation++;

    if (this.#timeoutHandle !== null) {
      clearTimeout(this.#timeoutHandle);
      this.#timeoutHandle = null;
    }
  }

  [Symbol.dispose](): void {
    this.stop();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  #schedulePoll(): void {
    if (!this.#running) return;

    // Capture the generation so the async .finally() handler can detect a
    // stop()/start() cycle that happened while a tick was in-flight. Without
    // this, the old tick's .finally() could create a duplicate polling loop.
    const pollGeneration = this.#generation;

    this.#timeoutHandle = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) => {
          console.error('[weft] ServiceWorkerScheduler tick failed:', error);
        })
        .finally(() => {
          if (this.#generation !== pollGeneration) return;
          this.#schedulePoll();
        });
    }, this.#fallbackIntervalMilliseconds);
  }
}
