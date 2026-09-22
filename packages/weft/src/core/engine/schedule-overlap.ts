import { ScheduleSkippedEvent } from '../events.ts';
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

  // WFT-136/COR-105: the blocked fallthrough. `'allow'` returns before
  // `applyBlockedScheduleOccurrence` is ever reached and the two branches above
  // consume `'queue'` and `'cancel-running'`, so in practice this is
  // `overlap: 'skip'` dropping the occurrence — the policy travels on the event
  // rather than being asserted here, so a future blocked policy stays truthful.
  const skippedAt = internals.options.getNow();
  internals.engine.dispatchEvent(
    new ScheduleSkippedEvent(
      state.id,
      skippedAt,
      state.overlap,
      occurrence,
      state.currentWorkflowId,
    ),
  );
  // COR-1224 — the durable half. The event above is a live signal and is gone
  // the moment nobody is listening; a dropped occurrence creates no run, so
  // without this nothing records that the tick happened at all. A counter and
  // a timestamp rather than a durable row per tick: a schedule whose fires
  // outlast its cadence collides forever, and per-tick rows would grow without
  // bound to say "nothing happened".
  return {
    ...state,
    skippedCount: state.skippedCount + 1,
    lastSkippedAt: skippedAt,
  };
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
    // WFT-95: this replays an already-persisted queued-run id rather than
    // admitting a fresh one — see ScheduledRunStartOptions.skipAdmissionIdCheck.
    skipAdmissionIdCheck: true,
  });
  return stateAfterStart;
}
