import type { ScheduleState, TimerEntry } from '../types.ts';
import {
  createInlineLaunchQueueCallbacks,
  createLifecycleCallbacks,
  createTerminationCallbacks,
  registerScheduledWorkflowTerminalHandler,
} from './callback-creators-core.ts';
import type { Engine } from './index.ts';
import { flushQueuedInlineWorkflowStartsDirectly } from './inline-launch-queue.ts';
import { getInternals } from './internals.ts';
import { startWorkflow } from './lifecycle.ts';
import type { ReviewOperationCallbacks, SubmitReviewCallbacks } from './reviews.ts';
import {
  applyScheduleOccurrence,
  handleScheduleTimer,
  handleScheduledWorkflowTerminal,
  refreshScheduledWorkflowState,
  settleBackfillScheduleState,
  startScheduledRun,
  type RefreshedScheduleState,
  type ScheduleCallbacks,
} from './schedules.ts';
import { loadWorkflowState } from './storage-io.ts';
import { feedOperationResult } from './strategy-helpers.ts';
import { ensureTerminalCleanupTracked, failWorkflow, handleCleanupError } from './termination.ts';

export function createScheduleCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): ScheduleCallbacks {
  return {
    startWorkflow: async (type, input, options, additionalStartOperations) => {
      await startWorkflow(
        getInternals(engine),
        type,
        input,
        options,
        additionalStartOperations,
        createLifecycleCallbacks(engine),
      );
    },
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    cancelWorkflow: (workflowId) => engine.cancel(workflowId),
    getWorkflowResult: (workflowId) => engine.getHandle(workflowId).result(),
    refreshScheduledWorkflowState: (state) => refreshScheduledWorkflowStateForEngine(engine, state),
    startScheduledRun: (state, occurrence) => startScheduledRunForEngine(engine, state, occurrence),
    applyScheduleOccurrence: (state, occurrence) =>
      applyScheduleOccurrenceForEngine(engine, state, occurrence),
    settleBackfillScheduleState: (state) => settleBackfillScheduleStateForEngine(engine, state),
    flushQueuedInlineWorkflowStartsDirectly: () =>
      flushQueuedInlineWorkflowStartsDirectly(
        getInternals(engine),
        createInlineLaunchQueueCallbacks(engine),
      ),
    failWorkflow: (workflowId, error) =>
      failWorkflow(getInternals(engine), workflowId, error, createTerminationCallbacks(engine)),
    handleCleanupError: (source, error, workflowId) =>
      handleCleanupError(getInternals(engine), source, error, workflowId, {
        dispatchEvent: (event) => engine.dispatchEvent(event),
      }),
  };
}

export function createReviewOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): ReviewOperationCallbacks {
  return {
    dispatchEvent: engine.dispatchEvent.bind(engine),
    failWorkflow: (workflowId, error) =>
      failWorkflow(getInternals(engine), workflowId, error, createTerminationCallbacks(engine)),
    feedOperationResult: (workflowId, result) =>
      feedOperationResult(getInternals(engine), workflowId, result),
    ensureTerminalCleanupTracked: (workflowId) =>
      ensureTerminalCleanupTracked(getInternals(engine), workflowId),
  };
}

export function createSubmitReviewCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): SubmitReviewCallbacks {
  return { dispatchEvent: engine.dispatchEvent.bind(engine) };
}

export async function refreshScheduledWorkflowStateForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, state: ScheduleState): Promise<RefreshedScheduleState> {
  return refreshScheduledWorkflowState(
    getInternals(engine),
    state,
    createScheduleCallbacks(engine),
  );
}
export async function startScheduledRunForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  state: ScheduleState,
  occurrence?: number,
): Promise<string> {
  return startScheduledRun(
    getInternals(engine),
    state,
    createScheduleCallbacks(engine),
    occurrence,
  );
}
export async function applyScheduleOccurrenceForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  state: ScheduleState,
  occurrence?: number,
): Promise<ScheduleState> {
  return applyScheduleOccurrence(
    getInternals(engine),
    state,
    createScheduleCallbacks(engine),
    occurrence,
  );
}
export async function settleBackfillScheduleStateForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, state: ScheduleState): Promise<ScheduleState> {
  return settleBackfillScheduleState(getInternals(engine), state, createScheduleCallbacks(engine));
}
export async function handleScheduleTimerForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, entry: TimerEntry): Promise<void> {
  return handleScheduleTimer(getInternals(engine), entry, createScheduleCallbacks(engine));
}
export async function handleScheduledWorkflowTerminalForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, workflowId: string): Promise<void> {
  return handleScheduledWorkflowTerminal(
    getInternals(engine),
    workflowId,
    createScheduleCallbacks(engine),
  );
}

// Wire the schedule terminal handler into the core registry at module load so
// `createTerminationCallbacks` in `callback-creators-core.ts` can call back
// into schedule without a static import cycle.
registerScheduledWorkflowTerminalHandler(
  <TW extends object, TA extends object>(engine: Engine<TW, TA>, workflowId: string) =>
    handleScheduledWorkflowTerminalForEngine(engine, workflowId),
);
