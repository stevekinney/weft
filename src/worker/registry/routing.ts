// ---------------------------------------------------------------------------
// Stateless routing predicates and selectors
// ---------------------------------------------------------------------------

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
