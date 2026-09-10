/**
 * Bump helpers for the durable per-workflow-id generation counter
 * (`wf-gen:<id>`, WFT-153). See `storage/generation-keys.ts` for the
 * keyspace's full rationale.
 *
 * Mirrors `workflow-claim-transitions.ts`'s epoch-rotation fragment shape
 * (`nextEpochFromObservedBytes` / `buildWorkflowClaimExternalTerminalRotationTransition`)
 * deliberately: both are "mint `(observed ?? 0) + 1`, never a literal"
 * permanently-retained counters bumped in the same atomic batch as the
 * transition that motivates the bump.
 *
 * @module core/engine/workflow-generation-fence
 */

import { KEYS, type BatchOperation } from '../../storage/interface.ts';
import { decodeGeneration, encodeGeneration } from './generation-codec.ts';
import type { EngineInternals } from './internals.ts';

/** Mint the next generation from bytes just read: `(decode(bytes) ?? 0) + 1`, never a literal. */
export function nextGenerationFromObservedBytes(
  observedGenerationBytes: Uint8Array | null,
): number {
  const observedGeneration =
    observedGenerationBytes === null ? null : decodeGeneration(observedGenerationBytes);
  return (observedGeneration ?? 0) + 1;
}

/**
 * Build just the `wf-gen:<id>` bump PUT operation from an ALREADY-OBSERVED
 * value — no storage read of its own. Used by the `onTerminalConflict:
 * 'start-new'` restart path (`start-terminal-conflict-purge.ts`), which folds
 * this operation into its create batch and relies on that batch's own outer
 * `duplicateIdGenerationCondition` — built from the SAME observed bytes this
 * function bumps from — as the CAS fence, rather than a second, independent
 * condition here. Reusing one observed value for both the fence and the bump
 * amount is what makes the restart's own CAS trivially self-consistent: it
 * can never fence itself out on its own legitimate restart, because the
 * value it bumps from is exactly the value its own precondition checks.
 */
export function buildWorkflowGenerationBumpOperation(
  workflowId: string,
  observedGenerationBytes: Uint8Array | null,
): BatchOperation {
  return {
    type: 'put',
    key: KEYS.workflowGeneration(workflowId),
    value: encodeGeneration(nextGenerationFromObservedBytes(observedGenerationBytes)),
  };
}

/**
 * Read the current `wf-gen:<id>` value and build its bump PUT operation, for
 * a STANDALONE purge/retention commit that — unlike the `'start-new'`
 * restart path above — has no pre-existing duplicate-id-style condition to
 * piggyback on. Meant to be folded (via `[...operations]`) into the caller's
 * own operations, alongside `buildExternalTerminalRotationFragment`'s usage
 * in `purgeWorkflow`.
 *
 * Deliberately carries NO `conditionalBatch` precondition of its own — unlike
 * the epoch rotation fragment, which conditions its rotation because a lost
 * update there could let a deposed owner's write slip through. A lost update
 * HERE (two concurrent purges of the very same id racing this read) is
 * harmless for what this key exists to guarantee: either purge's bump still
 * moves the value away from whatever an earlier duplicate-id read observed,
 * which is all a later `duplicateIdGenerationCondition` re-check needs to see
 * a mismatch. Keeping this unconditioned also means purge does not newly
 * require the `conditionalBatch` capability under `ownership: 'none'` with no
 * other conditions in play — it stays on the plain `batch()` path exactly as
 * before this key existed.
 *
 * Runs under EVERY ownership mode — unlike the `wf-owner-epoch` rotation
 * fragment, which is a no-op outside `ownership: 'workflow-lease'`, this
 * always reads and bumps: the ABA hole it closes exists under `'none'` and
 * `'lease'` too.
 */
export async function buildWorkflowGenerationBumpOperationForPurge(
  internals: EngineInternals,
  workflowId: string,
): Promise<BatchOperation> {
  const observedGenerationBytes = await internals.storage.get(KEYS.workflowGeneration(workflowId));
  return buildWorkflowGenerationBumpOperation(workflowId, observedGenerationBytes);
}
