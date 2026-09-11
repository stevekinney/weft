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
import type { WorkflowClaimTransitionFragment } from './workflow-claim-transitions.ts';

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
 * Read the current `wf-gen:<id>` value, build its bump PUT operation and (CAS
 * condition permitting) fold BOTH into `base` — the caller's own fragment, in
 * `purgeWorkflow` the `wf-owner-epoch` rotation fragment
 * `buildExternalTerminalRotationFragment` already built — for a STANDALONE
 * purge/retention commit that, unlike the `'start-new'` restart path above,
 * has no pre-existing duplicate-id-style condition of its own to piggyback
 * on. Folding happens HERE, not at the call site, so `purgeWorkflow` stays a
 * flat read-then-commit without its own merge step.
 *
 * RESOLVED (chatgpt-codex-connector review, WFT-153): this bump PUT was
 * previously unconditioned, on the theory that a lost update between two
 * concurrent purges of the same id was harmless — either purge's bump moves
 * the value away from whatever an earlier duplicate-id read observed. That
 * theory misses a THIRD purge landing in between: purge A reads generation
 * N and (slowly) prepares a bump to N+1; purge B — a later purge of the
 * SAME id, after the id was reused and purged again — reads the CURRENT
 * value N+1 and commits a bump to N+2; if A's stale N+1 write then commits
 * UNCONDITIONED, it overwrites B's N+2 with A's own N+1, rolling the
 * "monotonic" counter backward. A cross-engine start that captured the
 * intermediate absent/N+1 pair during the window before B's purge could then
 * pass its `duplicateIdGenerationCondition` re-check after the rollback, even
 * though a run genuinely executed and was purged in between — reopening the
 * exact ABA this key exists to close.
 *
 * The condition folded in now closes that: `expectedValue` is the SAME
 * `observedGenerationBytes` the bump amount is minted from, so a lost race
 * (another purge already changed `wf-gen:<id>` since this read) fails the
 * CAS instead of overwriting a newer generation with a stale one. Gated on
 * `internals.storage.capabilities().conditionalBatch` (the same
 * capability-conditioned pattern `buildWorkflowStateCommit` uses in
 * `storage-io.ts`) rather than required unconditionally: a backend that
 * honestly reports no `conditionalBatch` support keeps the pre-existing
 * unconditioned bump (a residual, capability-limited ABA window, not a new
 * regression) instead of newly requiring a capability purge never required
 * before this fix — purge must keep working, degraded, on such backends.
 *
 * Runs under EVERY ownership mode — unlike the `wf-owner-epoch` rotation
 * fragment, which is a no-op outside `ownership: 'workflow-lease'`, this
 * always reads and bumps: the ABA hole it closes exists under `'none'` and
 * `'lease'` too.
 */
export async function foldWorkflowGenerationBumpForPurge(
  internals: EngineInternals,
  workflowId: string,
  base: WorkflowClaimTransitionFragment,
): Promise<WorkflowClaimTransitionFragment> {
  const key = KEYS.workflowGeneration(workflowId);
  const observedGenerationBytes = await internals.storage.get(key);
  const operation = buildWorkflowGenerationBumpOperation(workflowId, observedGenerationBytes);
  const condition = internals.storage.capabilities().conditionalBatch
    ? { key, expectedValue: observedGenerationBytes }
    : undefined;
  return {
    operations: [...base.operations, operation],
    conditions: base.conditions.concat(condition ?? []),
  };
}
