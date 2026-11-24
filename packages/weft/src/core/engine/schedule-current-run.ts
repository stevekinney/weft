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

import { KEYS } from '../../storage/keys.ts';
import { ScheduleAttemptedEvent } from '../events.ts';
import type { ScheduleState, WorkflowState } from '../types.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { startOccurrenceRun, type OccurrenceCommit } from './schedule-occurrence-commit.ts';
import {
  applyBlockedScheduleOccurrence,
  drainQueuedScheduleRun,
  drainQueuedScheduleRunUnderRead,
} from './schedule-overlap.ts';
import { decodeScheduleRunMetadata } from './schedule-run-metadata.ts';
import { runIsolatedScheduleStateOperation } from './schedule-state-operations.ts';
import {
  loadScheduleState,
  ScheduleReadConditionLostError,
  scheduleReadConditions,
} from './schedule-state-read.ts';
import type { RefreshedScheduleState, ScheduleCallbacks } from './schedules.ts';
import { clearScheduleCurrentWorkflow } from './state-utilities.ts';
import { writeScheduleState } from './storage-io.ts';
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
  occurrence: number | undefined,
  manual: true | undefined,
  commit: OccurrenceCommit,
): Promise<ScheduleState> {
  // WFT-136/COR-105: the one observation point every occurrence passes through,
  // dispatched before the overlap policy is consulted so a consumer sees the
  // tick itself rather than only the outcomes that launch a run. The blocked
  // policies deliberately do not emit `schedule:fired`, so without this a
  // `skip` collision and a stopped schedule look identical from outside. A tick that decides
  // the occurrence again after losing a start to another engine (COR-1925) is the same attempt.
  if (!commit.retry) {
    internals.engine.dispatchEvent(
      new ScheduleAttemptedEvent(state.id, internals.options.getNow(), occurrence),
    );
  }

  const { state: refreshedState, currentWorkflowState } =
    await callbacks.refreshScheduledWorkflowState(state);
  let stateForOccurrence = refreshedState;
  let hasActiveWorkflow = hasActiveScheduledWorkflow(currentWorkflowState);

  if (!hasActiveWorkflow && stateForOccurrence.queuedRuns.length > 0) {
    stateForOccurrence = await drainQueuedScheduleRun(stateForOccurrence, callbacks, commit);
    hasActiveWorkflow = true;
  }

  if (stateForOccurrence.overlap === 'allow') {
    const options = {
      ...(occurrence !== undefined && { occurrence }),
      ...(manual === true && { manual }),
    };
    await startOccurrenceRun(
      commit,
      callbacks,
      stateForOccurrence,
      stateForOccurrence,
      options,
      true,
    );
    return stateForOccurrence;
  }

  return applyBlockedScheduleOccurrence(
    internals,
    stateForOccurrence,
    hasActiveWorkflow,
    callbacks,
    occurrence,
    manual,
    commit,
  );
}

/**
 * Whether the end of the current run starts the run queued first. An active schedule drains its
 * queue. A paused one keeps the occurrences its cadence queued until it is resumed, but still starts
 * a run a person asked for (COR-1829): nothing else would, since a paused schedule has no timer.
 */
function drainsQueuedRun(state: ScheduleState): boolean {
  const [next] = state.queuedRuns;
  if (next === undefined) return false;
  return state.status === 'active' || (state.status === 'paused' && next.manual === true);
}

/**
 * Waits for the scheduled run `workflowId` to finish its turn: starts the inline launches still
 * queued, then waits for the run's own turn. The run's activity can call back into its schedule,
 * and pause, resume, cancel, and update take the schedule's serialization, so a caller must not
 * hold it while it waits here (COR-1482).
 */
export async function awaitScheduledRunTurn(
  internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<ScheduleCallbacks, 'flushQueuedInlineWorkflowStartsDirectly'>,
): Promise<void> {
  await callbacks.flushQueuedInlineWorkflowStartsDirectly();

  const pendingTurn = internals.inlineStrategy?.waitForWorkflowTurn(workflowId);
  if (pendingTurn) {
    await pendingTurn;
  }
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
  // COR-1482: the schedule record is read and written inside the schedule's serialized write, so
  // what this handler changes is applied to the schedule as it is now, never to a copy loaded
  // before a pause, an update, or a cancel committed.
  //
  // COR-1594: that serialization is per process, so the write is conditioned on the bytes it was
  // decided from. One that loses them read a schedule another process has since changed (a pause,
  // an update), so the schedule is read again and the clearing is applied to it as it is now.
  await runIsolatedScheduleStateOperation(internals, scheduleId, async () => {
    for (;;) {
      const loaded = await loadScheduleState(internals, scheduleId);
      if (!loaded || loaded.state.currentWorkflowId !== workflowId) {
        await deleteTransientScheduleRunMetadata(internals, workflowId);
        return;
      }
      const { state } = loaded;
      const now = internals.options.getNow();
      const clearedState: ScheduleState = {
        ...clearScheduleCurrentWorkflow(state),
        updatedAt: now,
      };
      // Queue entries are accepted work. Keep draining them even if a later update
      // changes overlap; the new policy governs only future occurrences.
      if (drainsQueuedRun(clearedState)) {
        // Conditioned on the bytes this was decided from: a pause, an update, or another engine's
        // drain that landed since the read loses it, and the schedule is read again (COR-1925).
        const drained = await drainQueuedScheduleRunUnderRead(
          internals,
          clearedState,
          loaded.bytes,
          callbacks,
          workflowId,
        );
        if (drained === null) continue;
        return;
      }
      try {
        await writeScheduleState(internals, clearedState, {
          includeTimer: false,
          additionalOperations: [{ type: 'delete', key: KEYS.scheduleRun(workflowId) }],
          extraConditions: scheduleReadConditions(internals, scheduleId, loaded),
        });
        return;
      } catch (error) {
        if (!(error instanceof ScheduleReadConditionLostError)) throw error;
      }
    }
  });
}

async function deleteTransientScheduleRunMetadata(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  // Engine-scoped on purpose: this runs from terminal cleanup, by which point
  // the workflow's claim has already been released, so a per-workflow fence
  // would halt on a claim this engine no longer (correctly) holds and strand
  // the record. The delete is idempotent and only removes transient metadata
  // for a workflow that is already terminal.
  await commitFencedEngineWrite(
    internals,
    null,
    [{ type: 'delete', key: KEYS.scheduleRun(workflowId) }],
    [],
    () => new Error(`Schedule-run cleanup for workflow "${workflowId}" lost its precondition.`),
  );
}
