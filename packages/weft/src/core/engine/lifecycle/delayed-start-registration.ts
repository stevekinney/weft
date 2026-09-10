import type { TimerEntry } from '../../types.ts';
import type { ExecutableRegistration } from '../dynamic-source-execution.ts';
import type { EngineInternals } from '../internals.ts';
import type { TimeOperationCallbacks } from '../operations-time.ts';
import { ensureDelayedStartClaimAndCleanupBeforeFailure } from './standalone-claim-acquire.ts';

/**
 * Resolve `type`'s registration for a delayed-start fire, failing the
 * workflow (via `callbacks.failWorkflow`) and returning `null` on any
 * resolution error instead of throwing. ADR 0002: acquires this workflow's
 * claim standalone + hydrates cleanup tracking BEFORE failing — the
 * happy-path pending→running fold later in `startDelayedWorkflow` would
 * otherwise establish both.
 *
 * Resolved against `revision` — the pending run's own persisted
 * `WorkflowState.revision` (WFT-17), `undefined` for a legacy record —
 * never the catalog's active pointer, so a delayed-start fire honors the
 * exact revision this run was created against, matching
 * `resumeWorkflowFromStorage()`'s use of the same resolver.
 *
 * Returns the FULL `{ entry, revision }` pair, not just `entry` — mirroring
 * `resolveExecutableRegistrationOrRenamedNotFound()`'s shape used by
 * `resume.ts`/`transition.ts`. For a legacy, pre-revision-pinning pending
 * record with exactly one registered `registerSource()` candidate, the
 * resolver can unambiguously resolve that candidate even though the input
 * `revision` was `undefined` — the caller MUST thread this returned
 * `revision` (not the input `revision` or the persisted state's own,
 * still-`undefined` `revision`) through the pending→running transition and
 * into `beginWorkflowExecution`, or the per-instance identity cache ends up
 * stamped with the wrong (missing) revision (WFT-19 review round 7).
 */
export async function resolveDelayedStartRegistrationOrFail(
  internals: EngineInternals,
  entry: TimerEntry,
  type: string,
  revision: string | undefined,
  callbacks: Pick<
    TimeOperationCallbacks,
    'failWorkflow' | 'resolveExecutableRegistrationForRevision'
  >,
): Promise<ExecutableRegistration | null> {
  try {
    return await callbacks.resolveExecutableRegistrationForRevision(type, revision);
  } catch (error) {
    await ensureDelayedStartClaimAndCleanupBeforeFailure(internals, entry.workflowId);
    const asError = error instanceof Error ? error : new Error(String(error));
    await callbacks.failWorkflow(entry.workflowId, asError);
    return null;
  }
}
