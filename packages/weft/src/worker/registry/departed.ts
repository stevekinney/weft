// ---------------------------------------------------------------------------
// Workers that went away but are still listed, and workers an operator forgot
// ---------------------------------------------------------------------------

import type { WorkerSnapshot } from './summary.ts';

/** How many departed workers the registry remembers before the oldest is dropped. */
export const MAX_DEPARTED_WORKERS = 100;

/** A worker whose session ended, as it stood when it went. */
export type DepartedWorker = Readonly<{
  snapshot: WorkerSnapshot;
  /** When the session ended, in epoch milliseconds. */
  disconnectedAt: number;
}>;

/**
 * What the registry remembers about workers that are no longer connected: the ones that went away,
 * kept until an operator forgets them or the same id registers again, and the drained workers that
 * are still connected but that an operator asked to stop listing. Both are in memory only: a
 * restarted server lists the workers that connect to it.
 */
export class DepartedWorkers {
  readonly #departed = new Map<string, DepartedWorker>();
  /** Connected, drained workers an operator forgot, with the session generation they forgot. */
  readonly #forgotten = new Map<string, number>();

  /** Remembers `snapshot` as a worker that went away at `disconnectedAt`, evicting the oldest past the limit. */
  record(snapshot: WorkerSnapshot, disconnectedAt: number): void {
    // A worker that went away again moves to the newest end, so eviction drops the longest gone.
    this.#departed.delete(snapshot.id);
    this.#departed.set(snapshot.id, {
      snapshot: { ...snapshot, inFlight: 0, disconnectedAt },
      disconnectedAt,
    });
    this.#forgotten.delete(snapshot.id);
    while (this.#departed.size > MAX_DEPARTED_WORKERS) {
      const oldest = this.#departed.keys().next();
      if (oldest.done) break;
      this.#departed.delete(oldest.value);
    }
  }

  /** A worker registering again is connected: nothing remembers it as gone or forgotten. */
  clear(workerId: string): void {
    this.#departed.delete(workerId);
    this.#forgotten.delete(workerId);
  }

  /** Stops listing a departed worker; whether there was one. */
  forgetDeparted(workerId: string): boolean {
    return this.#departed.delete(workerId);
  }

  /** Stops listing a connected, drained worker until it registers again or is resumed. */
  forgetConnected(workerId: string, sessionGeneration: number): void {
    this.#forgotten.set(workerId, sessionGeneration);
  }

  /** Lists a connected worker again, as resuming it does. */
  restore(workerId: string): void {
    this.#forgotten.delete(workerId);
  }

  /** Whether the connected session of `sessionGeneration` was forgotten. */
  isForgotten(workerId: string, sessionGeneration: number): boolean {
    return this.#forgotten.get(workerId) === sessionGeneration;
  }

  /** The workers that went away and were not forgotten, in the order they went. */
  list(): readonly DepartedWorker[] {
    return [...this.#departed.values()];
  }
}
