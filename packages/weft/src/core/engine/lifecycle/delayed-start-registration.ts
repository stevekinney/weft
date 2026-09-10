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
): Promise<ExecutableRegistration['entry'] | null> {
  try {
    const resolved = await callbacks.resolveExecutableRegistrationForRevision(type, revision);
    return resolved.entry;
  } catch (error) {
    await ensureDelayedStartClaimAndCleanupBeforeFailure(internals, entry.workflowId);
    const asError = error instanceof Error ? error : new Error(String(error));
    await callbacks.failWorkflow(entry.workflowId, asError);
    return null;
  }
}
