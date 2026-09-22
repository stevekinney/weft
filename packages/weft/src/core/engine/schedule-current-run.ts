/**
 * The schedule's current-run slot: whether it is occupied, what happens when an
 * occurrence fires against it, and how it is cleared when the run reaches a
 * terminal state. Every function here reads or clears `state.currentWorkflowId`
 * and its `KEYS.scheduleRun(workflowId)` record.
 *
 * `schedules.ts` owns the schedule API itself (create, list, pause, resume,
 * cancel, update) and names these only as `ScheduleCallbacks` fields, which
 * `callback-creators-schedule.ts` wires up — so nothing here is called from
 * there and the only edge back is a type import.
 */

import { KEYS } from '../../storage/interface.ts';
import { ScheduleAttemptedEvent } from '../events.ts';
import type { ScheduleState, WorkflowState } from '../types.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { applyBlockedScheduleOccurrence, drainQueuedScheduleRun } from './schedule-overlap.ts';
import { decodeScheduleRunMetadata } from './schedule-run-metadata.ts';
import type { RefreshedScheduleState, ScheduleCallbacks } from './schedules.ts';
import { clearScheduleCurrentWorkflow } from './state-utilities.ts';
import { loadScheduleState, writeScheduleState } from './storage-io.ts';
import { isValidScheduleIdentifier } from './validation/schedule.ts';

/**
 * Whether a schedule's current run still occupies the schedule slot for overlap
 * purposes. A `'suspended'` run is non-terminal and resumable — it has NOT
 * finished, so it must keep the slot occupied exactly like `'running'`/`'pending'`,
 * otherwise the next occurrence would start an overlapping run under a non-`allow`
 * overlap policy (skip/queue/cancel-running) while the paused run still exists.
 * This is deliberately a wider set than `workflowStatusCanRetainLocalOwnership`
 * (which excludes `'suspended'` so recoverAll skips it): "occupies the schedule
 * slot" is "not terminal", not "locally owned".
 */
function scheduledRunOccupiesSlot(
  currentWorkflowState: WorkflowState | null | undefined,
): currentWorkflowState is WorkflowState {
  const status = currentWorkflowState?.status;
  return status === 'running' || status === 'pending' || status === 'suspended';
}

export async function refreshScheduledWorkflowState(
  internals: EngineInternals,
  state: ScheduleState,
  callbacks: Pick<ScheduleCallbacks, 'loadWorkflowState'>,
): Promise<RefreshedScheduleState> {
  if (!state.currentWorkflowId) {
    return { state, currentWorkflowState: null };
  }
  const currentWorkflowState = await callbacks.loadWorkflowState(state.currentWorkflowId);
  if (scheduledRunOccupiesSlot(currentWorkflowState)) {
    return { state, currentWorkflowState };
  }
  await internals.storage.delete(KEYS.scheduleRun(state.currentWorkflowId));
  return {
    state: clearScheduleCurrentWorkflow(state),
    currentWorkflowState: currentWorkflowState ?? null,
  };
}

function hasActiveScheduledWorkflow(
  currentWorkflowState: WorkflowState | null | undefined,
): boolean {
  return scheduledRunOccupiesSlot(currentWorkflowState);
}

export async function applyScheduleOccurrence(
  internals: EngineInternals,
  state: ScheduleState,
  callbacks: ScheduleCallbacks,
  occurrence?: number,
): Promise<ScheduleState> {
  // WFT-136/COR-105: the one observation point every occurrence passes through,
  // dispatched before the overlap policy is consulted so a consumer sees the
  // tick itself rather than only the outcomes that launch a run. The blocked
  // policies deliberately do not emit `schedule:fired`, so without this a
  // `skip` collision and a stopped schedule look identical from outside.
  internals.engine.dispatchEvent(
    new ScheduleAttemptedEvent(state.id, internals.options.getNow(), occurrence),
  );

  const { state: refreshedState, currentWorkflowState } =
    await callbacks.refreshScheduledWorkflowState(state);
  let stateForOccurrence = refreshedState;
  let hasActiveWorkflow = hasActiveScheduledWorkflow(currentWorkflowState);

  if (!hasActiveWorkflow && stateForOccurrence.queuedRuns.length > 0) {
    stateForOccurrence = await drainQueuedScheduleRun(stateForOccurrence, callbacks);
    hasActiveWorkflow = true;
  }

  if (stateForOccurrence.overlap === 'allow') {
    await callbacks.startScheduledRun(stateForOccurrence, {
      ...(occurrence !== undefined && { occurrence }),
    });
    return stateForOccurrence;
  }

  return applyBlockedScheduleOccurrence(
    internals,
    stateForOccurrence,
    hasActiveWorkflow,
    callbacks,
    occurrence,
  );
}

export async function settleBackfillScheduleState(
  internals: EngineInternals,
  state: ScheduleState,
  callbacks: Pick<
    ScheduleCallbacks,
    'flushQueuedInlineWorkflowStartsDirectly' | 'refreshScheduledWorkflowState'
  >,
): Promise<ScheduleState> {
  if (!state.currentWorkflowId) {
    return state;
  }

  await callbacks.flushQueuedInlineWorkflowStartsDirectly();

  const pendingTurn = internals.inlineStrategy?.waitForWorkflowTurn(state.currentWorkflowId);
  if (pendingTurn) {
    await pendingTurn;
  }

  const refreshed = await callbacks.refreshScheduledWorkflowState(state);
  return refreshed.state;
}

export async function handleScheduledWorkflowTerminal(
  internals: EngineInternals,
  workflowId: string,
  callbacks: ScheduleCallbacks,
): Promise<void> {
  const scheduleRunBytes = await internals.storage.get(KEYS.scheduleRun(workflowId));
  if (!scheduleRunBytes) {
    return;
  }
  const metadata = decodeScheduleRunMetadata(scheduleRunBytes);
  if (metadata === null || !isValidScheduleIdentifier(metadata.id)) {
    await deleteTransientScheduleRunMetadata(internals, workflowId);
    return;
  }
  const scheduleId = metadata.id;
  const state = await loadScheduleState(internals, scheduleId);
  if (!state || state.currentWorkflowId !== workflowId) {
    await deleteTransientScheduleRunMetadata(internals, workflowId);
    return;
  }
  const now = internals.options.getNow();
  const clearedState: ScheduleState = {
    ...clearScheduleCurrentWorkflow(state),
    updatedAt: now,
  };
  // Queue entries are accepted work. Keep draining them even if a later update
  // changes overlap; the new policy governs only future occurrences.
  if (clearedState.status === 'active' && clearedState.queuedRuns.length > 0) {
    await drainQueuedScheduleRun({ ...clearedState, updatedAt: now }, callbacks, workflowId);
    return;
  }
  await writeScheduleState(internals, clearedState, {
    includeTimer: false,
    additionalOperations: [{ type: 'delete', key: KEYS.scheduleRun(workflowId) }],
  });
}

async function deleteTransientScheduleRunMetadata(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  await commitFencedEngineWrite(
    internals,
    workflowId,
    [{ type: 'delete', key: KEYS.scheduleRun(workflowId) }],
    [],
    () => new Error(`Schedule-run cleanup for workflow "${workflowId}" lost its precondition.`),
  );
}
