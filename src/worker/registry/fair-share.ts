// ---------------------------------------------------------------------------
// Pure fair-share scoring helpers — no live registry references
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
