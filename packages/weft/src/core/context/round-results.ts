/**
 * What a lockstep round (a document `map` batch, see `document-batch.ts`) reads and forgets of the
 * results its items record.
 *
 * Each item of a round asks for one operation, numbered through the shared step counter, and the
 * round's `ctx.allSettled` takes the next number and caches every item's outcome. Resuming an item
 * with its outcome makes the operation it asked for record that outcome at its own number too. A
 * replay must ask for every item's operation again, exactly as the first run did, so the round
 * numbers the same way; an operation that found its own result recorded would return it without
 * asking, and every later number would shift by one. So the round forgets what its items recorded
 * at the numbers of the rounds before it: the round's own cache entry holds those outcomes.
 *
 * @module context/round-results
 */

import { getInternals, hasContextInternals } from './internals.ts';

/** Where the steps of a context stand: the next number, and the numbers holding results. */
export type RoundMark = { readonly next: number; readonly recorded: ReadonlySet<number> };

/** The mark of `context` now, or `undefined` for a context that numbers no steps (a worker's). */
export function markRound(context: object): RoundMark | undefined {
  if (!hasContextInternals(context)) return undefined;
  const internals = getInternals(context);
  return {
    next: internals.stepIndex,
    recorded: new Set(internals.accumulatedResults?.keys() ?? []),
  };
}

/**
 * Forget every result `context` recorded since `mark` under a number below the mark's: the
 * outcomes the items of earlier rounds recorded as they resumed. A result that was there at the
 * mark (a run persisted before rounds forgot them) is kept, so such a run replays as it did.
 */
export function forgetEarlierRoundResults(context: object, mark: RoundMark | undefined): void {
  if (mark === undefined || !hasContextInternals(context)) return;
  const results = getInternals(context).accumulatedResults;
  if (results === undefined) return;
  // Deleting the entry a `for...of` over a `Map` is on is safe: iteration moves to the next.
  for (const step of results.keys()) {
    if (step < mark.next && !mark.recorded.has(step)) results.delete(step);
  }
}
