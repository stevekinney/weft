import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import { ScheduleFiredEvent } from '../events.ts';
import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { unavailableServicesError } from './lifecycle/recovered-services.ts';
import { EMPTY_STORAGE_VALUE } from './lifecycle/shared.ts';
import { encodeScheduleRunMetadata } from './schedule-run-metadata.ts';
import type { ScheduleCallbacks } from './schedules.ts';

export type ScheduledRunStartOptions = {
  occurrence?: number;
  /** Reserved queue identity. A fresh id is minted when omitted. */
  workflowId?: string;
  /** Schedule state committed atomically with the workflow start. */
  scheduleStateAfterStart?: ScheduleState;
  /** Prior terminal run whose transient schedule metadata is now settled. */
  completedWorkflowId?: string;
};

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
 * timer loop or retained on its durable queue entry until drain.
 */
export async function startScheduledRun(
  internals: EngineInternals,
  state: ScheduleState,
  callbacks: Pick<ScheduleCallbacks, 'startWorkflow' | 'failWorkflow' | 'handleCleanupError'>,
  options: ScheduledRunStartOptions = {},
): Promise<string> {
  const workflowId = options.workflowId ?? crypto.randomUUID();
  const occurrence = options.occurrence;
  const metadata = encodeScheduleRunMetadata(state.id, occurrence);
  const scheduleRunOperations: BatchOperation[] = [
    {
      type: 'put',
      key: KEYS.scheduleRun(workflowId),
      value: metadata,
    },
    {
      type: 'put',
      key: KEYS.scheduleRunLink(workflowId),
      value: metadata,
    },
    {
      type: 'put',
      key: KEYS.scheduleRunBySchedule(state.id, workflowId),
      value: EMPTY_STORAGE_VALUE,
    },
    {
      type: 'put',
      key: KEYS.terminalCleanupNeeded(workflowId),
      value: EMPTY_STORAGE_VALUE,
    },
  ];

  if (options.scheduleStateAfterStart !== undefined) {
    scheduleRunOperations.push({
      type: 'put',
      key: KEYS.schedule(options.scheduleStateAfterStart.id),
      value: encode(options.scheduleStateAfterStart),
    });
  }
  if (options.completedWorkflowId !== undefined) {
    scheduleRunOperations.push({
      type: 'delete',
      key: KEYS.scheduleRun(options.completedWorkflowId),
    });
  }

  const resolution = await resolveScheduledRunServices(internals, workflowId, state, occurrence);

  if (resolution !== null) {
    // Write the "expects services" marker atomically with the workflow record.
    // This mirrors startWorkflow's buildPerRunScratchOperations path and is
    // required for both the available and unavailable cases so a fresh-process
    // recovery can tell "never had services" from "had services".
    scheduleRunOperations.push({
      type: 'put',
      key: KEYS.workflowHasServices(workflowId),
      value: EMPTY_STORAGE_VALUE,
    });

    if (resolution.status === 'available') {
      internals.workflowServices.set(workflowId, resolution.services);
    }
  }

  // Register the terminal-cleanup obligation before startWorkflow is called.
  // Every scheduled run writes `schedule-run` metadata, and the inline start can
  // complete before this function resumes after the await. The in-memory set is
  // what makes completion schedule the deferred durable cleanup timer that
  // sweeps that metadata if the fire-and-forget scheduled-terminal handler is
  // interrupted. If startWorkflow throws, rollbackTransientStartState clears it.
  internals.workflowsNeedingTerminalCleanup.add(workflowId);

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
  // (nothing launched).
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
  occurrence: number | undefined,
): Promise<
  { status: 'available'; services: unknown } | { status: 'unavailable'; reason: string } | null
> {
  const resolver = internals.options.resolveWorkflowServices;
  if (internals.inlineStrategy === null || !resolver) {
    return null;
  }

  try {
    return await resolver({
      workflowId,
      workflowType: state.workflowType,
      input: state.input,
      launchOptions: { id: workflowId },
      schedule: {
        id: state.id,
        ...(occurrence !== undefined ? { occurrence } : {}),
      },
    });
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
