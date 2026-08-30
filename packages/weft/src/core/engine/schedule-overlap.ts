import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import type { ScheduledRunStartOptions } from './schedule-run.ts';
import { clearScheduleCurrentWorkflow } from './state-utilities.ts';

type ScheduleOverlapCallbacks = {
  cancelWorkflow: (workflowId: string) => Promise<void>;
  getWorkflowResult: (workflowId: string) => Promise<unknown>;
  startScheduledRun: (state: ScheduleState, options?: ScheduledRunStartOptions) => Promise<string>;
};

export async function applyBlockedScheduleOccurrence(
  internals: EngineInternals,
  state: ScheduleState,
  hasActiveWorkflow: boolean,
  callbacks: ScheduleOverlapCallbacks,
  occurrence?: number,
): Promise<ScheduleState> {
  if (!hasActiveWorkflow) {
    return startScheduleRunInOccupiedSlot(state, callbacks, occurrence);
  }

  if (state.overlap === 'cancel-running') {
    if (state.currentWorkflowId) {
      void callbacks.getWorkflowResult(state.currentWorkflowId).catch(() => {});
      await callbacks.cancelWorkflow(state.currentWorkflowId);
    }
    return startScheduleRunInOccupiedSlot(
      clearScheduleCurrentWorkflow(state),
      callbacks,
      occurrence,
    );
  }

  if (state.overlap === 'queue') {
    return {
      ...state,
      queuedRuns: [
        ...state.queuedRuns,
        {
          workflowId: crypto.randomUUID(),
          queuedAt: internals.options.getNow(),
          ...(occurrence !== undefined && { occurrence }),
        },
      ],
    };
  }

  return state;
}

async function startScheduleRunInOccupiedSlot(
  state: ScheduleState,
  callbacks: Pick<ScheduleOverlapCallbacks, 'startScheduledRun'>,
  occurrence?: number,
): Promise<ScheduleState> {
  const workflowId = crypto.randomUUID();
  const stateAfterStart: ScheduleState = { ...state, currentWorkflowId: workflowId };
  await callbacks.startScheduledRun(state, {
    workflowId,
    ...(occurrence !== undefined && { occurrence }),
  });
  return stateAfterStart;
}

export async function drainQueuedScheduleRun(
  state: ScheduleState,
  callbacks: Pick<ScheduleOverlapCallbacks, 'startScheduledRun'>,
  completedWorkflowId?: string,
): Promise<ScheduleState> {
  const [queuedRun, ...remainingQueuedRuns] = state.queuedRuns;
  if (queuedRun === undefined) return state;

  const stateAfterStart: ScheduleState = {
    ...state,
    currentWorkflowId: queuedRun.workflowId,
    queuedRuns: remainingQueuedRuns,
  };
  await callbacks.startScheduledRun(state, {
    workflowId: queuedRun.workflowId,
    ...(queuedRun.occurrence !== undefined && { occurrence: queuedRun.occurrence }),
    scheduleStateAfterStart: stateAfterStart,
    ...(completedWorkflowId !== undefined && { completedWorkflowId }),
  });
  return stateAfterStart;
}
