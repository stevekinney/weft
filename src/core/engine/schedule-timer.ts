import { ScheduleMissedFireEvent } from '../events/schedule-events.ts';
import type { ScheduleState, TimerEntry } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { resolveEffectiveScheduleFireAt } from './schedule-jitter.ts';
import { collectDueScheduleOccurrences, getNextScheduleOccurrence } from './schedule-occurrence.ts';
import type { ScheduleCallbacks } from './schedules.ts';
import { loadScheduleState, writeScheduleState } from './storage-io.ts';

const SCHEDULE_LATE_GRACE_MILLISECONDS = 1000;
const MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK = 256;

type ActiveScheduleTimerState = ScheduleState & { nextFireAt: number };

type MissedScheduleOccurrences = {
  count: number;
  lastMissedFireAt: number;
  windowStart: number;
  windowEnd: number;
};

type ScheduleTimerWork = {
  dueOccurrences: number[];
  missedOccurrences?: MissedScheduleOccurrences;
  occurrencesToProcess: number[];
  skipMissedOccurrences: boolean;
};

class ScheduleStatePersistenceError extends Error {
  constructor(
    readonly scheduleId: string,
    cause: unknown,
  ) {
    super(`Failed to persist schedule "${scheduleId}" while processing its timer`, { cause });
  }
}

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

    if (work.occurrencesToProcess.length === 0) {
      nextState = {
        ...nextState,
        updatedAt: now,
        nextFireAt: resolveNextScheduleFireAt(nextState, work, now),
        ...(work.missedOccurrences && {
          lastMissedFireAt: work.missedOccurrences.lastMissedFireAt,
          missedFireCount: nextState.missedFireCount + work.missedOccurrences.count,
        }),
      };
      await persistScheduleTimerState(internals, nextState);
      if (work.missedOccurrences) {
        internals.engine.dispatchEvent(
          new ScheduleMissedFireEvent(
            nextState.id,
            work.missedOccurrences.count,
            work.missedOccurrences.windowStart,
            work.missedOccurrences.windowEnd,
          ),
        );
      }
      return;
    }

    nextState = await processScheduleTimerOccurrences(internals, state, work, now, callbacks, {
      onProcessedState: (processedState) => {
        nextState = processedState;
      },
    });
  } catch (error) {
    if (error instanceof ScheduleStatePersistenceError) {
      throw error;
    }
    await pauseScheduleAfterTimerFailure(internals, nextState, error);
  }
}

function isCurrentActiveScheduleTimer(
  state: ScheduleState | null,
  entry: TimerEntry,
): state is ActiveScheduleTimerState {
  return (
    state?.status === 'active' &&
    state.nextFireAt !== null &&
    resolveEffectiveScheduleFireAt(state, state.nextFireAt) === entry.fireAt
  );
}

function planScheduleTimerWork(
  state: ActiveScheduleTimerState,
  entry: TimerEntry,
  now: number,
): ScheduleTimerWork | null {
  const dueOccurrences = collectDueScheduleOccurrences(
    state,
    state.nextFireAt,
    Math.max(now, entry.fireAt),
    state.backfill ? MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK : 2,
  );
  if (dueOccurrences.length === 0) return null;

  if (!state.backfill && now - entry.fireAt > SCHEDULE_LATE_GRACE_MILLISECONDS) {
    return {
      dueOccurrences,
      missedOccurrences: countMissedScheduleOccurrences(state, state.nextFireAt, now),
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

function countMissedScheduleOccurrences(
  state: ActiveScheduleTimerState,
  firstDueAt: number,
  throughTimestamp: number,
): MissedScheduleOccurrences {
  let count = 0;
  let occurrence = firstDueAt;
  let lastMissedFireAt = firstDueAt;

  while (occurrence <= throughTimestamp) {
    count += 1;
    lastMissedFireAt = occurrence;
    const nextOccurrence = getNextScheduleOccurrence(state, occurrence);
    if (nextOccurrence <= occurrence) {
      throw new Error(`Schedule "${state.id}" produced a non-advancing occurrence`);
    }
    occurrence = nextOccurrence;
  }

  return {
    count,
    lastMissedFireAt,
    windowStart: firstDueAt,
    windowEnd: throughTimestamp,
  };
}

function resolveNextScheduleFireAt(
  state: ScheduleState,
  work: ScheduleTimerWork,
  now: number,
): number {
  if (work.skipMissedOccurrences) {
    return getNextScheduleOccurrence(state, now);
  }

  const anchorOccurrence = work.occurrencesToProcess.at(-1) ?? work.dueOccurrences.at(-1)!;
  return getNextScheduleOccurrence(state, anchorOccurrence);
}

async function processScheduleTimerOccurrences(
  internals: EngineInternals,
  state: ScheduleState,
  work: ScheduleTimerWork,
  now: number,
  callbacks: ScheduleCallbacks,
  options: { onProcessedState: (state: ScheduleState) => void },
): Promise<ScheduleState> {
  let nextState: ScheduleState = state;

  for (const [index, occurrence] of work.occurrencesToProcess.entries()) {
    const finalOccurrence = index === work.occurrencesToProcess.length - 1;
    nextState = {
      ...(await callbacks.applyScheduleOccurrence(nextState)),
      lastFireAt: occurrence,
      updatedAt: now,
    };
    if (finalOccurrence) {
      nextState = {
        ...nextState,
        nextFireAt: resolveNextScheduleFireAt(nextState, work, now),
      };
    }
    options.onProcessedState(nextState);
    await persistScheduleTimerState(internals, nextState, { includeTimer: finalOccurrence });
    if (state.backfill && nextState.currentWorkflowId !== undefined) {
      nextState = await callbacks.settleBackfillScheduleState(nextState);
      if (finalOccurrence) {
        nextState = {
          ...nextState,
          updatedAt: now,
          nextFireAt: resolveNextScheduleFireAt(nextState, work, now),
        };
        await persistScheduleTimerState(internals, nextState);
      }
      options.onProcessedState(nextState);
    }
  }

  return nextState;
}

async function persistScheduleTimerState(
  internals: EngineInternals,
  state: ScheduleState,
  options?: { includeTimer?: boolean },
): Promise<void> {
  try {
    await writeScheduleState(internals, state, options);
  } catch (error) {
    throw new ScheduleStatePersistenceError(state.id, error);
  }
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
    nextFireAt: getNextScheduleOccurrence(state, errorNow),
  };
  await writeScheduleState(internals, pausedState, { includeTimer: false });
  console.error(`[weft] Paused schedule "${pausedState.id}" after timer processing failed:`, error);
}
