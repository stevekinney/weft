import type { WorkflowState } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';

/**
 * Re-provide a recovered inline workflow's non-serialized `services` before its
 * generator is driven forward, and decide whether execution should proceed.
 *
 * Both recovery entry points use this: `resumeWorkflowFromStorage` (for a run
 * left `running`) and the delayed-start timer handler (for a `startAfter`/
 * `startAt` run that crashed `pending` before its timer fired). On a fresh
 * process the in-memory `workflowServices` map is empty, so without this a
 * recovered run that originally had services would silently execute with
 * `ctx.services === undefined`.
 *
 * Returns `false` to proceed (services available, or none needed because no
 * resolver is configured). Returns `true` to STOP — the run was terminally
 * failed (services unavailable), or the terminal commit faulted and the run was
 * left for a later boot to retry. Either way the generator must not advance:
 * driving it without services would crash the body and that throw would escape
 * into the recovery loop, aborting sibling runs.
 *
 * Worker mode skips this (services are inline-only, rejected at `engine.start()`).
 * A resolver throw is treated as `unavailable` with the error as the reason,
 * for the same sibling-isolation reason.
 *
 * @param failRun - Terminally fails just this run with `reason`. Supplied by the
 *   caller because the two entry points reach the termination machinery through
 *   different callback bundles.
 * @param onCommitError - Records a fail-warn when `failRun` itself throws, so the
 *   swallowed terminal-commit fault is still observable.
 */
export async function reprovideRecoveredServices(
  internals: EngineInternals,
  state: WorkflowState,
  failRun: (workflowId: string, reason: string) => Promise<void>,
  onCommitError: (source: string, error: unknown, workflowId: string) => void,
): Promise<boolean> {
  const resolver = internals.options.resolveWorkflowServices;
  if (internals.inlineStrategy === null || !resolver) {
    return false;
  }
  // Same-process case: services are still live in the map (the run was launched
  // in this process and is being resumed/started here). Nothing to re-provide.
  if (internals.workflowServices.has(state.id)) {
    return false;
  }

  let reason: string;
  try {
    const resolution = await resolver({
      workflowId: state.id,
      workflowType: state.type,
      input: state.input,
    });
    if (resolution.status === 'available') {
      internals.workflowServices.set(state.id, resolution.services);
      return false;
    }
    reason = resolution.reason;
  } catch (error) {
    // A resolver that throws (e.g. a network-client rebuild rejecting) must not
    // abort recovery of sibling runs — treat it as unavailable.
    reason = error instanceof Error ? error.message : String(error);
  }

  try {
    await failRun(state.id, reason);
  } catch (error) {
    // The terminal-fail commit itself faulted (e.g. a storage write error). The
    // run stays in its persisted pre-execution state for a later boot to retry;
    // still stop here so we never drive the generator without services.
    onCommitError('reprovideRecoveredServices', error, state.id);
  }
  return true;
}
