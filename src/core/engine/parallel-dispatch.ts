/**
 * Shared dispatch helper for top-level `ctx.all` and `ctx.runAll`. Runs
 * branches with `Promise.allSettled` semantics, captures every branch's
 * outcome, and returns the slot table plus the first observed rejection
 * reason. Callers (`processParallelOperation` for `ctx.all`,
 * `processRunAllOperation` for `ctx.runAll`) build the v2 cache entry
 * from those slots and persist it to the workflow's
 * `accumulatedResults`.
 *
 * The helper itself has no access to a `Context` and does not mutate
 * any workflow state directly — slot construction is its only job. The
 * "persist before rethrow" contract lives in the callers.
 *
 * Nested `ctx.all` (inside another sub-operation, like `ctx.race`) does
 * NOT go through this helper. `executeSubOperation` keeps `Promise.all`
 * semantics for that case so the outer parent's slot captures the inner
 * value verbatim — partial-failure preservation is documented as
 * top-level only.
 *
 * Persistence model in the callers: the engine writes the partial entry
 * into `context.accumulatedResults` in place at the operation's parent
 * step; the existing checkpoint-persistence path picks it up on the
 * next yield boundary. This trades some durability under hard process
 * crashes for a much smaller blast radius into the engine's
 * checkpoint-write machinery — see the `parallel-execution.md` guide
 * for the precise durability contract.
 */

import type {
  ParallelBranchSlot,
  ParallelOperationCacheEntry,
} from '../context/parallel-cache-entry.ts';
import { createParallelOperationCacheEntry } from '../context/parallel-cache-entry.ts';

export type ParallelDispatchResult = {
  /** Final slot table — every entry is `fulfilled` or `rejected`. */
  slots: ParallelBranchSlot[];
  /**
   * Whether at least one branch rejected. Distinguishes "no rejection"
   * from "rejected with `undefined`" — the latter is rare but valid in
   * `Promise.all` semantics.
   */
  hasFirstError: boolean;
  /**
   * The first rejection observed by settlement timing, in its original
   * shape. `Promise.all` rethrows whatever was thrown — including
   * non-`Error` values like strings, numbers, or `undefined`. Callers
   * rethrow this as-is to preserve that contract.
   */
  firstError: unknown;
};

/**
 * Mutable accumulator for the first rejection observed across a fan-out
 * dispatch. Shared by `dispatchBranchesAllSettled` here and by
 * `executeRunAllBranchesSettled` in `engine-helpers.ts` so both
 * Promise.all-style settled dispatches use the same capture logic and
 * don't drift in the contract for "first rejection wins" semantics.
 *
 * `Promise.all` rethrows whatever was thrown — including non-`Error`
 * values like strings, numbers, or `undefined`. The accumulator
 * preserves the original `unknown` value so callers can rethrow it
 * verbatim.
 */
export type FirstRejectionCapture = {
  hasFirstError: boolean;
  firstError: unknown;
};

/** Create a fresh first-rejection accumulator. */
export function createFirstRejectionCapture(): FirstRejectionCapture {
  return { hasFirstError: false, firstError: undefined };
}

/** Record a rejection, keeping only the first one observed by settlement timing. */
export function captureFirstRejection(capture: FirstRejectionCapture, reason: unknown): void {
  if (!capture.hasFirstError) {
    capture.hasFirstError = true;
    capture.firstError = reason;
  }
}

export type DispatchOneBranch = (index: number) => Promise<unknown>;

/**
 * Run every branch via `executeOne(index)`, capturing per-branch outcomes
 * in a slot table. Reused fulfilled slots (passed in via `resumedSlots`)
 * skip dispatch entirely; missing/rejected/aborted slots dispatch fresh.
 *
 * The promise NEVER rejects — callers receive a `slots` array, a
 * `hasFirstError` flag, and the original `firstError` value. Callers
 * translate that into rejection of the parent operation themselves so
 * they can write the partial entry first. Persisted rejection metadata
 * is normalized to `{ name, message }` because raw `Error` objects
 * don't round-trip through MessagePack, but the value rethrown to the
 * workflow generator is the original `unknown` reason.
 */
export async function dispatchBranchesAllSettled(
  operationIds: string[],
  resumedSlots: ParallelBranchSlot[] | undefined,
  executeOne: DispatchOneBranch,
): Promise<ParallelDispatchResult> {
  const slots: ParallelBranchSlot[] = operationIds.map((operationId, i) => {
    const cached = resumedSlots?.[i];
    if (cached?.status === 'fulfilled') return cached;
    return { status: 'pending', operationId };
  });

  const capture = createFirstRejectionCapture();

  await Promise.all(
    operationIds.map(async (operationId, index) => {
      if (slots[index]?.status === 'fulfilled') {
        // Already-fulfilled resumed slot — no-op.
        return;
      }
      try {
        const value = await executeOne(index);
        slots[index] = { status: 'fulfilled', value, operationId };
      } catch (error) {
        // Persist normalized name/message because Error objects don't
        // round-trip through MessagePack, but capture the original
        // reason to rethrow.
        const reasonError = error instanceof Error ? error : new Error(String(error));
        slots[index] = {
          status: 'rejected',
          reason: { name: reasonError.name, message: reasonError.message },
          operationId,
        };
        captureFirstRejection(capture, error);
      }
    }),
  );

  return { slots, hasFirstError: capture.hasFirstError, firstError: capture.firstError };
}

/**
 * Build a v2 cache entry from the result of `dispatchBranchesAllSettled`.
 * Convenience wrapper used by every dispatch site.
 */
export function buildEntryFromSlots(
  variant: 'all' | 'race' | 'run-all',
  slots: ParallelBranchSlot[],
  branchNames?: string[],
): ParallelOperationCacheEntry {
  return createParallelOperationCacheEntry(variant, slots, slots.length, branchNames);
}

/**
 * Reconstruct the user-visible array result from a fully-fulfilled slot
 * table. Throws if any slot is non-fulfilled — callers must check
 * `firstError` first and throw it instead of calling this on a partial
 * result.
 */
export function valuesFromSlots(slots: ParallelBranchSlot[]): unknown[] {
  return slots.map((slot, i) => {
    if (slot.status !== 'fulfilled') {
      throw new Error(`Branch slot ${i} is ${slot.status}, not fulfilled`);
    }
    return slot.value;
  });
}
