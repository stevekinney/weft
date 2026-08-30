// ---------------------------------------------------------------------------
// Routing predicates and policy selectors. The selectors take whatever live
// state they need (round-robin cursor, fair-share counters) as parameters so
// all worker-selection logic lives here rather than inline in the registry.
// ---------------------------------------------------------------------------

import { compareScores, type FairShareCounters, scoreWorker } from './fair-share.ts';
import type { WorkerInfo } from './types.ts';

/**
 * Return `true` when `worker` is eligible for the given `activityName` and
 * optional `queue` constraint, and has spare capacity.
 *
 * This is the single canonical gate every routing policy relies on — it
 * extracts the capacity+queue+activity filter out of `findWorker` so the loop
 * body reads as a simple linear scan.
 */
export function matchesWorkerCapabilities(
  worker: WorkerInfo,
  activityName: string,
  queue: string | undefined,
): boolean {
  if (queue !== undefined && worker.queue !== queue) return false;
  if (!worker.activities.includes(activityName)) return false;
  return worker.inFlight < worker.concurrency;
}

/**
 * Pick the worker with the lowest in-flight count. Ties broken by stable
 * worker id ordering so the choice is deterministic across runs.
 *
 * `eligible` must be non-empty — the caller is responsible for this precondition.
 */
export function pickLeastLoaded(eligible: WorkerInfo[]): WorkerInfo {
  let best = eligible[0]!;
  for (let index = 1; index < eligible.length; index += 1) {
    const candidate = eligible[index]!;
    if (
      candidate.inFlight < best.inFlight ||
      (candidate.inFlight === best.inFlight && candidate.id < best.id)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Round-robin selection with a per-(queue, activity) cursor so two activities
 * sharing a queue advance independently. Mutates `cursor` in place, advancing
 * the entry for this (queue, activity) pair.
 *
 * `eligible` must be non-empty — the caller is responsible for this precondition.
 */
export function pickRoundRobin(
  eligible: WorkerInfo[],
  cursor: Map<string, number>,
  queue: string | undefined,
  activityName: string,
): WorkerInfo {
  const key = `${queue ?? '__default__'}::${activityName}`;
  const position = cursor.get(key) ?? 0;
  const pick = eligible[position % eligible.length]!;
  cursor.set(key, position + 1);
  return pick;
}

/**
 * Fair-share selection: the worker carrying the fewest in-flight tasks for
 * `fairShareKey` wins, ties broken by overall in-flight count then stable id
 * order. The score snapshot is built synchronously so the ranking is consistent
 * across the full candidate set.
 *
 * `eligible` must be non-empty — the caller is responsible for this precondition.
 */
export function pickFairShare(
  eligible: WorkerInfo[],
  counters: FairShareCounters,
  fairShareKey: string,
): WorkerInfo {
  const scores = eligible.map((worker) =>
    scoreWorker({
      id: worker.id,
      inFlight: worker.inFlight,
      keyLoad: counters.load(worker.id, fairShareKey),
    }),
  );
  const winner = scores.reduce((best, candidate) =>
    compareScores(candidate, best) < 0 ? candidate : best,
  );
  return eligible.find((worker) => worker.id === winner.id)!;
}
