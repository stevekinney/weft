import { collectDueCronOccurrences, getNextCronOccurrence } from '../schedule.ts';
import type { ScheduleState, TimerEntry } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import type { ScheduleCallbacks } from './schedules.ts';
import { loadScheduleState, writeScheduleState } from './storage-io.ts';

const SCHEDULE_LATE_GRACE_MILLISECONDS = 1000;
const MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK = 256;

type ActiveScheduleTimerState = ScheduleState & { nextFireAt: number };

type ScheduleTimerWork = {
  dueOccurrences: number[];
  occurrencesToProcess: number[];
  skipMissedOccurrences: boolean;
};

export async function handleScheduleTimer(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: ScheduleCallbacks,
): Promise<void> {
  const state = await loadScheduleState(internals, entry.workflowId);
  if (!isCurrentActiveScheduleTimer(state, entry)) {
    return;
  }

  let nextState: ScheduleState = state;
  try {
    const now = internals.options.getNow();
    const work = planScheduleTimerWork(state, entry, now);
    if (!work) {
      return;
    }

    nextState = await processScheduleTimerOccurrences(
      internals,
      state,
      work.occurrencesToProcess,
      now,
      callbacks,
      (processedState) => {
        nextState = processedState;
      },
    );
    await writeScheduleState(internals, {
      ...nextState,
      updatedAt: now,
      nextFireAt: resolveNextScheduleFireAt(nextState, work, now),
    });
  } catch (error) {
    await pauseScheduleAfterTimerFailure(internals, nextState, error);
  }
}

function isCurrentActiveScheduleTimer(
  state: ScheduleState | null,
  entry: TimerEntry,
): state is ActiveScheduleTimerState {
  return state?.status === 'active' && state.nextFireAt === entry.fireAt;
}

function planScheduleTimerWork(
  state: ActiveScheduleTimerState,
  entry: TimerEntry,
  now: number,
): ScheduleTimerWork | null {
  const dueOccurrences = collectDueCronOccurrences(
    state.cronExpression,
    state.nextFireAt,
    Math.max(now, entry.fireAt),
    {
      maxOccurrences: state.backfill ? MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK : 2,
    },
  );
  if (dueOccurrences.length === 0) return null;

  if (!state.backfill && now - state.nextFireAt > SCHEDULE_LATE_GRACE_MILLISECONDS) {
    return {
      dueOccurrences,
      occurrencesToProcess: [],
      skipMissedOccurrences: true,
    };
  }

  const occurrencesToProcess = state.backfill ? dueOccurrences : dueOccurrences.slice(0, 1);
  return {
    dueOccurrences,
    occurrencesToProcess,
    skipMissedOccurrences: false,
  };
}

function resolveNextScheduleFireAt(
  state: ScheduleState,
  work: ScheduleTimerWork,
  now: number,
): number {
  if (work.skipMissedOccurrences) {
    return getNextCronOccurrence(state.cronExpression, now);
  }

  const anchorOccurrence = work.occurrencesToProcess.at(-1) ?? work.dueOccurrences.at(-1)!;
  return getNextCronOccurrence(state.cronExpression, anchorOccurrence);
}

async function processScheduleTimerOccurrences(
  internals: EngineInternals,
  state: ScheduleState,
  occurrencesToProcess: number[],
  now: number,
  callbacks: ScheduleCallbacks,
  onProcessedState: (state: ScheduleState) => void,
): Promise<ScheduleState> {
  let nextState: ScheduleState = state;

  for (const occurrence of occurrencesToProcess) {
    nextState = {
      ...(await callbacks.applyScheduleOccurrence(nextState)),
      lastFireAt: occurrence,
      updatedAt: now,
    };
    onProcessedState(nextState);
    await writeScheduleState(internals, nextState, { includeTimer: false });
    if (state.backfill && nextState.currentWorkflowId !== undefined) {
      nextState = await callbacks.settleBackfillScheduleState(nextState);
      onProcessedState(nextState);
    }
  }

  return nextState;
}

async function pauseScheduleAfterTimerFailure(
  internals: EngineInternals,
  state: ScheduleState,
  error: unknown,
): Promise<void> {
  const errorNow = internals.options.getNow();
  const pausedState: ScheduleState = {
    ...state,
    status: 'paused',
    updatedAt: errorNow,
    nextFireAt: getNextCronOccurrence(state.cronExpression, errorNow),
  };
  await writeScheduleState(internals, pausedState, { includeTimer: false });
  console.error(`[weft] Paused schedule "${pausedState.id}" after timer processing failed:`, error);
}
