import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import { ScheduleFiredEvent } from '../events/schedule-events.ts';
import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { unavailableServicesError } from './lifecycle/recovered-services.ts';
import { EMPTY_STORAGE_VALUE } from './lifecycle/shared.ts';
import type { ScheduleCallbacks } from './schedules.ts';

/**
 * Launch one scheduled occurrence's workflow run and emit `schedule:fired`.
 *
 * This is the single chokepoint every occurrence launch flows through — initial
 * cadence ticks, `cancel-running` replacements, and `queue`-drained runs — so it
 * is the one place that reliably holds the launched `workflowId` across all
 * overlap policies. The blocked policies (`skip`, and `queue` while a run is
 * active) never reach here, so they correctly do not fire.
 *
 * `occurrence` is the scheduled grid timestamp the run was due, threaded from the
 * timer loop. It is `undefined` for a `queue`-drained run, whose grid slot was
 * tracked only as a count and whose original timestamp is therefore gone.
 */
export async function startScheduledRun(
  internals: EngineInternals,
  state: ScheduleState,
  callbacks: Pick<ScheduleCallbacks, 'startWorkflow' | 'failWorkflow' | 'handleCleanupError'>,
  occurrence?: number,
): Promise<string> {
  const workflowId = crypto.randomUUID();
  const scheduleRunOperations: BatchOperation[] =
    state.overlap === 'allow'
      ? []
      : [{ type: 'put', key: KEYS.scheduleRun(workflowId), value: encode(state.id) }];

  const resolution = await resolveScheduledRunServices(internals, workflowId, state);

  if (resolution !== null) {
    // Write the "expects services" marker and terminal-cleanup flag atomically
    // with the workflow record. This mirrors startWorkflow's buildPerRunScratchOperations
    // path and is required for both the available and unavailable cases so a
    // fresh-process recovery can tell "never had services" from "had services".
    scheduleRunOperations.push(
      { type: 'put', key: KEYS.workflowHasServices(workflowId), value: EMPTY_STORAGE_VALUE },
      { type: 'put', key: KEYS.terminalCleanupNeeded(workflowId), value: EMPTY_STORAGE_VALUE },
    );

    // Register the terminal-cleanup obligation and, for the available case,
    // store the services in engine memory BEFORE startWorkflow is called.
    //
    // Critically, `startWorkflow` internally calls `queueInlineWorkflowExecutionStart`
    // which posts a MessageChannel message. In Bun/Node.js the handler for that
    // message can fire before our code after `await startWorkflow(...)` runs —
    // making a post-startWorkflow set arrive too late for the completion check
    // in `completeWorkflow` (which reads `workflowsNeedingTerminalCleanup` to
    // decide whether to schedule the deferred terminal cleanup timer). Setting
    // both values synchronously before the call guarantees the completion path
    // always sees them regardless of MessageChannel scheduling.
    //
    // If `startWorkflow` throws, `rollbackTransientStartState` inside it clears
    // both maps for the workflowId, so no leak occurs on the failure path.
    internals.workflowsNeedingTerminalCleanup.add(workflowId);
    if (resolution.status === 'available') {
      internals.workflowServices.set(workflowId, resolution.services);
    }
  }

  // An empty array and `undefined` are equivalent at the receiving end
  // (buildStartBatchOperations spreads `?? []`), so pass the array directly.
  await callbacks.startWorkflow(
    state.workflowType,
    state.input,
    { id: workflowId },
    scheduleRunOperations,
  );

  // The run launched, so the occurrence fired. Emit before the unavailable
  // check: a services failure becomes a separate `workflow:failed`, and the
  // natural causal order is fired -> failed. A `startWorkflow` throw skips this
  // (nothing launched). `occurrence` is undefined for a `queue`-drained run,
  // whose original grid timestamp is not retained (see ScheduleFiredEvent).
  internals.engine.dispatchEvent(
    new ScheduleFiredEvent(state.id, workflowId, internals.options.getNow(), occurrence),
  );

  if (resolution !== null && resolution.status === 'unavailable') {
    // Services unavailable — fail only this occurrence. The schedule timer handler
    // wraps applyScheduleOccurrence in a try/catch that pauses the whole schedule on
    // error; an individual occurrence's resolver failure must not escape there.
    // The run was just started (status 'running') and is in the inline launch queue;
    // failing it here sets status to 'failed' so the queue's status check skips the body.
    const unavailableError = unavailableServicesError(workflowId, resolution.reason);
    try {
      await callbacks.failWorkflow(workflowId, unavailableError);
    } catch (error) {
      callbacks.handleCleanupError('startScheduledRun', error, workflowId);
    }
  }

  return workflowId;
}

/**
 * Resolve workflow services for a scheduled occurrence when the engine has a
 * `resolveWorkflowServices` resolver and is in inline execution mode.
 *
 * Returns `null` when no resolution is needed (no resolver, or worker mode).
 * Returns the resolution result — available or unavailable — otherwise, with
 * resolver throws coerced to unavailable to prevent a single occurrence fault
 * from escaping into the schedule timer handler's error boundary.
 */
async function resolveScheduledRunServices(
  internals: EngineInternals,
  workflowId: string,
  state: ScheduleState,
): Promise<
  { status: 'available'; services: unknown } | { status: 'unavailable'; reason: string } | null
> {
  const resolver = internals.options.resolveWorkflowServices;
  if (internals.inlineStrategy === null || !resolver) {
    return null;
  }

  try {
    return await resolver({ workflowId, workflowType: state.workflowType, input: state.input });
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
