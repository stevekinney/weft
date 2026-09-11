/**
 * Fork-vs-concurrent-replacement guards (WFT-21, Codex review, item 6),
 * split out of `fork-helpers.ts` into their own module purely to keep both
 * `fork-helpers.ts` and `transition.ts` under the repository's 500-line
 * implementation-file ceiling.
 *
 * @module core/engine/lifecycle/fork-source-replacement-guards
 */

import type { Checkpoint, WorkflowState } from '../../types.ts';
import { ForkSourceReplacedError } from '../fork-source-replaced-error.ts';
import type { EngineInternals } from '../internals.ts';
import { loadWorkflowState } from '../storage-io.ts';

/**
 * Correlate `sourceState.workflowExecutionToken` against the loaded (and
 * hydrated) source checkpoint's own token, throwing {@link ForkSourceReplacedError}
 * on a mismatch. `sourceState` is read at `fork()`'s own top, before the
 * possibly-async registration resolve; a concurrent `start(..., { id:
 * sourceWorkflowId, onTerminalConflict: 'start-new' })` replacement landing
 * in that window, if version-compatible, could otherwise let this
 * checkpoint (already reflecting the replacement) get forked alongside
 * `sourceState`'s own STALE type/input. Tolerates either side lacking the
 * field (a pre-upgrade record) — the same bounded precedent as
 * `checkpoint-reads.ts`'s `resolveReplayRevision()` — since there is
 * nothing to compare. Extracted out of `fork()` itself purely to keep
 * `transition.ts` under the repository's implementation-file-size ceiling
 * and `fork()`'s own complexity bounded; no behavior change from what
 * would otherwise be inlined there.
 */
export function assertForkSourceCheckpointMatchesState(
  sourceWorkflowId: string,
  sourceState: WorkflowState,
  sourceCheckpoint: Checkpoint,
): void {
  if (
    sourceCheckpoint.workflowExecutionToken !== undefined &&
    sourceState.workflowExecutionToken !== undefined &&
    sourceCheckpoint.workflowExecutionToken !== sourceState.workflowExecutionToken
  ) {
    throw new ForkSourceReplacedError(sourceWorkflowId);
  }
}

/**
 * Revalidate the source's own generation immediately before `fork()`
 * commits, re-reading `WorkflowState` fresh rather than relying on the
 * in-memory `sourceState` captured earlier — further async work (header
 * lookup, lineage construction, search attribute derivation, the
 * catalog-entry condition build) happens between the checkpoint
 * correlation above and the commit, and a `start-new` replacement could
 * still land inside any of it. Only fires when `sourceState` itself
 * carries a token (mirrors the tolerance in
 * {@link assertForkSourceCheckpointMatchesState}); an undefined
 * revalidated read (the source was purged entirely) also counts as a
 * mismatch. See that function's own doc for why this is extracted out of
 * `fork()`.
 */
export async function assertForkSourceNotReplacedBeforeCommit(
  internals: EngineInternals,
  sourceWorkflowId: string,
  sourceState: WorkflowState,
): Promise<void> {
  if (sourceState.workflowExecutionToken === undefined) return;
  const revalidatedSourceState = await loadWorkflowState(internals, sourceWorkflowId);
  if (revalidatedSourceState?.workflowExecutionToken !== sourceState.workflowExecutionToken) {
    throw new ForkSourceReplacedError(sourceWorkflowId);
  }
}
