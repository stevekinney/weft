// ---------------------------------------------------------------------------
// Fair-share routing: pure scoring helpers plus the per-worker in-flight
// counters those scores read from. The counter store lives here, beside the
// scoring functions it feeds, so the fair-share relationship has one home.
// ---------------------------------------------------------------------------

/**
 * Minimal snapshot of per-worker state needed to compute a fair-share score.
 * Callers construct this from live registry data in a single synchronous pass
 * before scoring, so the comparison is consistent across the full candidate set.
 */
export type WorkerScoreSnapshot = {
  /** Worker identifier — used for stable tiebreaking. */
  id: string;
  /** Number of in-flight tasks this worker is currently handling overall. */
  inFlight: number;
  /** Number of in-flight tasks for the specific fair-share partition key. */
  keyLoad: number;
};

/**
 * Computed score for a single candidate worker.
 * Lower `keyLoad` wins; `inFlight` and `id` break ties deterministically.
 */
export type WorkerScore = {
  snapshot: WorkerScoreSnapshot;
  keyLoad: number;
  inFlight: number;
  id: string;
};

/**
 * Produce a {@link WorkerScore} for `snapshot`.
 *
 * The score captures the fair-share key load, overall in-flight count, and
 * worker id so `compareScores` can rank candidates without accessing live
 * state a second time.
 *
 * @example
 * ```ts
 * import { scoreWorker } from './fair-share.ts';
 * const score = scoreWorker({ id: 'w1', inFlight: 3, keyLoad: 1 });
 * console.log(score.keyLoad); // 1
 * ```
 */
export function scoreWorker(snapshot: WorkerScoreSnapshot): WorkerScore {
  return {
    snapshot,
    keyLoad: snapshot.keyLoad,
    inFlight: snapshot.inFlight,
    id: snapshot.id,
  };
}

/**
 * Compare two worker scores for fair-share selection.
 *
 * Ordering (ascending — lower is better):
 * 1. `keyLoad` — prefer the worker carrying fewer tasks for this partition key.
 * 2. `inFlight` — break ties by overall load.
 * 3. `id` — lexicographic tiebreak for determinism across runs.
 *
 * Returns a negative number when `a` is preferred, positive when `b` is
 * preferred, and `0` when they are equivalent (not expected in practice
 * because worker ids are unique).
 *
 * @example
 * ```ts
 * import { compareScores, scoreWorker } from './fair-share.ts';
 * const a = scoreWorker({ id: 'w1', inFlight: 2, keyLoad: 0 });
 * const b = scoreWorker({ id: 'w2', inFlight: 1, keyLoad: 1 });
 * console.log(compareScores(a, b) < 0); // true — a has lower keyLoad
 * ```
 */
export function compareScores(a: WorkerScore, b: WorkerScore): number {
  if (a.keyLoad !== b.keyLoad) return a.keyLoad - b.keyLoad;
  if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Per-worker, per-key in-flight counters for fair-share routing. Keeping this
 * state in one object — rather than an inline `Map<string, Map<string, number>>`
 * in the registry — guarantees increments, releases, and per-worker purges all
 * agree on the same idempotency rules, so the counts never drift from the
 * in-flight task set that drives them.
 *
 * @example
 * ```ts
 * import { FairShareCounters } from './fair-share.ts';
 * const counters = new FairShareCounters();
 * counters.increment('w1', 'tenant-a');
 * console.log(counters.load('w1', 'tenant-a')); // 1
 * ```
 */
export class FairShareCounters {
  /** Outer key = workerId, inner key = fair-share partition key, value = count. */
  #counts = new Map<string, Map<string, number>>();

  /** Current in-flight count for `workerId` on `key` (0 when untracked). */
  load(workerId: string, key: string): number {
    return this.#counts.get(workerId)?.get(key) ?? 0;
  }

  /** Increment the in-flight count for `workerId` on `key`. */
  increment(workerId: string, key: string): void {
    let workerCounts = this.#counts.get(workerId);
    if (workerCounts === undefined) {
      workerCounts = new Map();
      this.#counts.set(workerId, workerCounts);
    }
    workerCounts.set(key, (workerCounts.get(key) ?? 0) + 1);
  }

  /**
   * Decrement the in-flight count for `workerId` on `key`, pruning empty inner
   * and outer maps so an idle worker leaves no residue. Floors at 0.
   */
  release(workerId: string, key: string): void {
    const workerCounts = this.#counts.get(workerId);
    if (workerCounts === undefined) return;
    const next = Math.max(0, (workerCounts.get(key) ?? 0) - 1);
    if (next === 0) {
      workerCounts.delete(key);
      if (workerCounts.size === 0) {
        this.#counts.delete(workerId);
      }
    } else {
      workerCounts.set(key, next);
    }
  }

  /** Drop all counters for a worker that has disconnected. */
  purge(workerId: string): void {
    this.#counts.delete(workerId);
  }
}
