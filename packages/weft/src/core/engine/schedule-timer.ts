import type { TimerFiredOutcome } from '../scheduler.ts';
import type { ScheduleState, TimerEntry } from '../types.ts';
import { WeftError } from '../weft-error.ts';
import type { EngineInternals } from './internals.ts';
import { awaitScheduledRunTurn } from './schedule-current-run.ts';
import { resolveEffectiveScheduleFireAt } from './schedule-jitter.ts';
import {
  dispatchMissedFires,
  gapMisses,
  lateMisses,
  recordMissedFires,
} from './schedule-missed-fires.ts';
import {
  collectDueScheduleTicks,
  getNextScheduleOccurrence,
  isSkippedOccurrence,
  type ScheduleTick,
} from './schedule-occurrence.ts';
import { loadScheduleState } from './schedule-state-read.ts';
import {
  drainQueuedRunInSection,
  recordOccurrence,
  scheduleAfterWork,
  type PlannedScheduleTimerWork,
  type ScheduleTimerWork,
} from './schedule-timer-occurrence.ts';
import {
  forgetRetainedTimer,
  lateSinceOf,
  reachedTooLate,
  rememberRetainedTimer,
  type TimerSighting,
} from './schedule-timer-sightings.ts';
import {
  pauseScheduleAfterTimerFailure,
  persistScheduleTimerState,
  ScheduleStatePersistenceError,
  type ScheduleTimerProgress,
} from './schedule-timer-writes.ts';
import type { ScheduleCallbacks } from './schedules.ts';
import { runSerializedScheduleStateOperation } from './storage-io.ts';

/**
 * How far past one poll interval a tick may land before a non-backfill occurrence it reaches
 * counts as missed. The scheduler only sees an occurrence when a poll tick lands after it, so a
 * healthy engine reaches it up to a whole poll interval late, plus the tick's own drift
 * (COR-1616). Only lateness beyond both, such as an engine that was down, is a missed fire.
 */
const SCHEDULE_LATE_GRACE_MILLISECONDS = 1000;
const MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK = 256;

/**
 * How long after its (jittered) fire time a non-backfill occurrence may be reached and still start
 * a run: one poll interval plus {@link SCHEDULE_LATE_GRACE_MILLISECONDS}. A tick that lands later
 * counts it, and every occurrence up to the tick, as missed.
 */
export function scheduleLateAfterMilliseconds(internals: EngineInternals): number {
  return internals.options.schedulerPollIntervalMs + SCHEDULE_LATE_GRACE_MILLISECONDS;
}
const MAX_MISSED_FIRE_COUNT_PER_TICK = MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK;

type ActiveScheduleTimerState = ScheduleState & { nextFireAt: number };

/**
 * One schedule timer tick, in serialized sections of the schedule's own write.
 *
 * A backfilled run is waited for before the next occurrence starts, and the run's activity can
 * call back into its schedule (`pauseSchedule`, `resumeSchedule`, `cancelSchedule`,
 * `updateSchedule`), all of which take that serialization. So the wait is made outside it: an
 * occurrence is started and its state written inside one section, the run's turn is awaited with
 * the serialization released, and the next section reads the schedule again before it goes on.
 * A schedule that changed while the run was going (its `revision` moved, or it is no longer
 * active) is not written back from the copy this tick loaded: whatever changed it owns the
 * timer from then on, and the occurrences this tick had left are not started.
 */
export async function handleScheduleTimer(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: ScheduleCallbacks,
): Promise<TimerFiredOutcome> {
  const sighting: TimerSighting = { at: undefined, late: false };
  let step = await runSerializedScheduleStateOperation(internals, entry.workflowId, () =>
    beginScheduleTimer(internals, entry, callbacks, sighting),
  );
  while (step.kind === 'settle') {
    const pending = step;
    try {
      await awaitScheduledRunTurn(internals, pending.workflowId, callbacks);
    } catch (error) {
      await failScheduleTimerWait(internals, entry.workflowId, pending, error);
      return;
    }
    step = await runSerializedScheduleStateOperation(internals, entry.workflowId, () =>
      resumeScheduleTimer(internals, entry.workflowId, pending, callbacks),
    );
  }
  if (!(await timerStillOwed(internals, entry))) {
    forgetRetainedTimer(internals, entry);
    return undefined;
  }
  // A tick that was itself too late keeps the count where it was: the delivery that follows is
  // late too, and a run is not made on time by standing aside.
  if (sighting.at !== undefined && !sighting.late) {
    rememberRetainedTimer(internals, entry, sighting.at, scheduleLateAfterMilliseconds(internals));
  }
  return 'retain';
}

/**
 * Whether the stored schedule still owes the occurrence `entry` fired, so that deleting the entry
 * would leave an active schedule that no timer wakes until some engine boots (COR-1925,
 * COR-1985). That is the case whenever the stored schedule is active and its next occurrence is
 * still the entry's, whatever the tick did. Two ways to get there:
 *
 * - A catch-up. A backfill commits each occurrence it starts (`lastFireAt`) and moves
 *   `nextFireAt`, and so replaces the entry, only with the last. A tick that stands aside because
 *   another engine went on with the catch-up (its start or write lost) leaves the fired entry as
 *   the schedule's only timer; if that engine dies before its last write, deleting the entry
 *   would strand the schedule. A delivery that finds the remaining occurrences already started by
 *   the other engine starts none of them again: it resumes after `lastFireAt`, and its starts are
 *   conditioned on the schedule it read.
 * - A write that re-armed the same occurrence. An update that keeps the interval keeps the anchor
 *   and `nextFireAt`, and so puts the timer again under the key (`schedule-due:<at>:<id>`) the
 *   tick that stood aside from it is about to delete. The key names the occurrence, not the
 *   generation of the timer, so the tick cannot tell the entry it fired from the one the write
 *   put; only the stored schedule can.
 *
 * So the entry is kept, and delivered again, until the stored schedule shows its occurrence
 * handled (`nextFireAt` moved, and the last write armed the next timer) or no longer active. A
 * tick that handled the occurrence itself has moved `nextFireAt`, so a normal tick keeps nothing.
 */
async function timerStillOwed(internals: EngineInternals, entry: TimerEntry): Promise<boolean> {
  if (internals.disposed) return false;
  const loaded = await loadScheduleState(internals, entry.workflowId);
  const state = loaded?.state;
  return (
    state?.status === 'active' &&
    state.nextFireAt !== null &&
    resolveEffectiveScheduleFireAt(state, state.nextFireAt) === entry.fireAt
  );
}

/**
 * The wait for a backfilled run's turn failed, as it does when the engine's handling of the run
 * fails (a storage fault while the run is saved). The whole tick used to sit inside one failure
 * boundary, and the schedule was paused once; the wait is outside it now, so the boundary is
 * rebuilt here. Left to escape, the failure would make the scheduler retry the entry, and every
 * poll would plan the same occurrence again, whose `nextFireAt` a non-final occurrence leaves
 * unchanged.
 *
 * The pause is made in a serialized section, from the schedule as it is now, and only if it is
 * still active at the `revision` this tick left it: a pause, an update, or a cancel made during
 * the wait owns the schedule, and a pause written on top of it, or from the state this tick last
 * wrote, would undo it. A failure that is the engine shutting down is not a fault of the
 * schedule: pausing it would leave it paused for good after the restart, so it is left as it
 * is for boot recovery.
 */
async function failScheduleTimerWait(
  internals: EngineInternals,
  scheduleId: string,
  pending: Extract<ScheduleTimerStep, { kind: 'settle' }>,
  error: unknown,
): Promise<void> {
  if (isEngineShutdown(internals, error)) return;
  await runSerializedScheduleStateOperation(internals, scheduleId, async () => {
    const current = await loadScheduleState(internals, scheduleId);
    if (
      current === null ||
      current.state.status !== 'active' ||
      current.state.revision !== pending.revision
    ) {
      return;
    }
    await pauseScheduleAfterTimerFailure(internals, current.state, current, error);
  });
}

/** Whether `error` is the engine going away rather than something the schedule's run did. */
function isEngineShutdown(internals: EngineInternals, error: unknown): boolean {
  return internals.disposed || (error instanceof WeftError && error.code === 'EngineDisposedError');
}

/** Where a tick stands between its serialized sections. */
type ScheduleTimerStep =
  | { readonly kind: 'done' }
  | {
      readonly kind: 'settle';
      /** The backfilled run to wait for, with the serialization released. */
      readonly workflowId: string;
      readonly work: ScheduleTimerWork;
      readonly now: number;
      /** The occurrence just started: the next section goes on from the one after it. */
      readonly index: number;
      /** The schedule's `revision` as this tick left it, to tell whether anything else changed it. */
      readonly revision: number;
      /**
       * The occurrence this tick last started (`lastFireAt`). Another engine that goes on with the
       * catch-up while this tick waits moves it, and then the occurrences left are its to start.
       */
      readonly lastFireAt: number | undefined;
    };

/** Runs one section, pausing the schedule when its processing fails, as the whole tick used to. */
async function guardScheduleTimerSection(
  internals: EngineInternals,
  progress: ScheduleTimerProgress,
  section: () => Promise<ScheduleTimerStep>,
): Promise<ScheduleTimerStep> {
  try {
    return await section();
  } catch (error) {
    if (error instanceof ScheduleStatePersistenceError) {
      throw error;
    }
    await pauseScheduleAfterTimerFailure(internals, progress.state, progress.stored, error);
    return { kind: 'done' };
  }
}

async function beginScheduleTimer(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: ScheduleCallbacks,
  sighting: TimerSighting,
): Promise<ScheduleTimerStep> {
  if (internals.deposed) return { kind: 'done' };

  const loaded = await loadScheduleState(internals, entry.workflowId);
  const state = loaded?.state ?? null;
  if (loaded === null || !isCurrentActiveScheduleTimer(state, entry)) {
    return { kind: 'done' };
  }

  const progress: ScheduleTimerProgress = { state, stored: loaded };
  return guardScheduleTimerSection(internals, progress, async () => {
    const now = internals.options.getNow();
    const lateAfter = scheduleLateAfterMilliseconds(internals);
    const lateSince = lateSinceOf(internals, entry);
    sighting.at = now;
    sighting.late = reachedTooLate(state, lateSince, now, lateAfter);
    const planned = planScheduleTimerWork(state, entry, now, lateAfter, lateSince);
    if (!planned) {
      return { kind: 'done' };
    }
    const work: ScheduleTimerWork = {
      ...planned,
      recorded: await recordMissedFires(internals, state, planned.missed),
    };

    if (work.occurrencesToProcess.length === 0) {
      const nextState: ScheduleState = {
        ...scheduleAfterWork(state, work),
        updatedAt: now,
        ...work.recorded.counters,
      };
      progress.state = nextState;
      if (
        !(await persistScheduleTimerState(internals, progress, nextState, {
          additionalOperations: work.recorded.operations,
        }))
      ) {
        return { kind: 'done' };
      }
      dispatchMissedFires(internals, nextState.id, work.recorded.announce);
      return { kind: 'done' };
    }

    // What a tick missed is written with the first run it starts, in one write, and announced once
    // that write has landed.
    const stateWithMisses: ScheduleState = { ...state, ...work.recorded.counters };
    return processScheduleTimerOccurrences(
      internals,
      stateWithMisses,
      work,
      now,
      callbacks,
      0,
      progress,
    );
  });
}

/**
 * The section that follows a backfilled run's turn: reads the schedule again, and goes on only if
 * nothing else changed it meanwhile.
 */
async function resumeScheduleTimer(
  internals: EngineInternals,
  scheduleId: string,
  pending: Extract<ScheduleTimerStep, { kind: 'settle' }>,
  callbacks: ScheduleCallbacks,
): Promise<ScheduleTimerStep> {
  if (internals.deposed) return { kind: 'done' };

  const loaded = await loadScheduleState(internals, scheduleId);
  if (
    loaded === null ||
    loaded.state.status !== 'active' ||
    loaded.state.revision !== pending.revision ||
    loaded.state.lastFireAt !== pending.lastFireAt
  ) {
    return { kind: 'done' };
  }
  const current = loaded.state;

  const progress: ScheduleTimerProgress = { state: current, stored: loaded };
  return guardScheduleTimerSection(internals, progress, async () => {
    const { work, now, index } = pending;
    const refreshed = await callbacks.refreshScheduledWorkflowState(current);
    let nextState = refreshed.state;
    // The run this tick waited for is over and this section just cleared the slot, so its own
    // terminal handler, which comes after this section, finds the slot no longer names it and
    // drains nothing. A run queued behind it starts here instead, as it does when an occurrence
    // finds the slot free, or it waits a whole cadence.
    if (
      current.currentWorkflowId !== undefined &&
      nextState.currentWorkflowId === undefined &&
      nextState.queuedRuns.length > 0
    ) {
      // The drain is conditioned on the bytes this section holds, and writes the schedule as it
      // returns it, so that is what the key holds afterwards and the next write of this tick is
      // conditioned on it (COR-1925). One that finds the schedule no longer the tick's ends it.
      const drained = await drainQueuedRunInSection(internals, progress, nextState, callbacks);
      if (drained === null) return { kind: 'done' };
      nextState = drained;
    }
    if (index === work.occurrencesToProcess.length - 1) {
      nextState = { ...scheduleAfterWork(nextState, work), updatedAt: now };
      progress.state = nextState;
      if (!(await persistScheduleTimerState(internals, progress, nextState))) {
        return { kind: 'done' };
      }
    }
    progress.state = nextState;
    return processScheduleTimerOccurrences(
      internals,
      nextState,
      work,
      now,
      callbacks,
      index + 1,
      progress,
    );
  });
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

/**
 * Where a tick starts: a backfill commits each occurrence it starts (`lastFireAt`) and moves
 * `nextFireAt` only with the last, so a tick that finds `lastFireAt` at or past `nextFireAt` is
 * resuming a catch-up another tick (or this one, before a restart) has begun, and what it has fired
 * is not started again (COR-1925). `firedThrough` is that `lastFireAt`; when no occurrence is left
 * after it, the cadence moves on past it.
 */
function resumePointOfCatchUp(state: ActiveScheduleTimerState): {
  firedThrough: number | undefined;
  firstDueAt: number;
} {
  const { lastFireAt, nextFireAt } = state;
  if (lastFireAt === undefined || lastFireAt < nextFireAt) {
    return { firedThrough: undefined, firstDueAt: nextFireAt };
  }
  return { firedThrough: lastFireAt, firstDueAt: getNextScheduleOccurrence(state, lastFireAt) };
}

function planScheduleTimerWork(
  state: ActiveScheduleTimerState,
  entry: TimerEntry,
  now: number,
  lateAfterMilliseconds: number,
  lateSince: number,
): PlannedScheduleTimerWork | null {
  const { firedThrough, firstDueAt } = resumePointOfCatchUp(state);
  const dueTicks = collectDueScheduleTicks(
    state,
    firstDueAt,
    Math.max(now, entry.fireAt),
    state.backfill ? MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK : 2,
  );
  if (dueTicks.length === 0) {
    return firedThrough === undefined
      ? null
      : { missed: [], occurrencesToProcess: [], anchor: firedThrough };
  }

  if (reachedTooLate(state, lateSince, now, lateAfterMilliseconds)) {
    const missedTicks = collectMissedScheduleTicks(state, state.nextFireAt, now);
    return {
      missed: [
        ...lateMisses(state, missedTicks.ticks, state.nextFireAt, missedTicks.windowEnd),
        ...gapMisses(missedTicks.ticks),
      ],
      occurrencesToProcess: [],
      anchor: missedTicks.ticks.at(-1)?.at ?? state.nextFireAt,
    };
  }

  const handled = state.backfill ? dueTicks : dueTicks.slice(0, 1);
  return {
    missed: gapMisses(handled),
    occurrencesToProcess: handled
      .filter((tick) => tick.fires && !isSkippedOccurrence(state, tick.at))
      .map((tick) => tick.at),
    anchor: handled.at(-1)!.at,
  };
}

/**
 * The ticks from `firstDueAt` through `throughTimestamp` that a late timer skips, at most
 * {@link MAX_MISSED_FIRE_COUNT_PER_TICK}, and where the window they cover ends: `throughTimestamp`,
 * or the last tick when the cap stopped short of it.
 */
function collectMissedScheduleTicks(
  state: ActiveScheduleTimerState,
  firstDueAt: number,
  throughTimestamp: number,
): { ticks: ScheduleTick[]; windowEnd: number } {
  const ticks = collectDueScheduleTicks(
    state,
    firstDueAt,
    throughTimestamp,
    MAX_MISSED_FIRE_COUNT_PER_TICK,
  );
  const last = ticks.at(-1);
  const cappedBeforeThroughTimestamp =
    last !== undefined &&
    ticks.length === MAX_MISSED_FIRE_COUNT_PER_TICK &&
    getNextScheduleOccurrence(state, last.at) <= throughTimestamp;
  return { ticks, windowEnd: cappedBeforeThroughTimestamp ? last.at : throughTimestamp };
}

/**
 * Starts the occurrences from `fromIndex`, writing the state after each. A backfilled run that
 * is still the schedule's current one ends the section: the caller waits for it with the
 * serialization released and comes back through {@link resumeScheduleTimer}.
 *
 * An occurrence a person skipped after this tick planned (in `skippedOccurrences` on the state the
 * section holds, which a resumed section reads again) starts no run (COR-1829). What the tick missed
 * is written with the first write it makes, so a skipped first occurrence hands it on.
 */
async function processScheduleTimerOccurrences(
  internals: EngineInternals,
  state: ScheduleState,
  work: ScheduleTimerWork,
  now: number,
  callbacks: ScheduleCallbacks,
  fromIndex: number,
  progress: ScheduleTimerProgress,
): Promise<ScheduleTimerStep> {
  let nextState: ScheduleState = state;
  let missesUnwritten = fromIndex === 0;

  for (let index = fromIndex; index < work.occurrencesToProcess.length; index += 1) {
    const occurrence = work.occurrencesToProcess[index]!;
    const finalOccurrence = index === work.occurrencesToProcess.length - 1;
    const skipped = isSkippedOccurrence(nextState, occurrence);
    if (skipped && !finalOccurrence) continue;
    const written = await recordOccurrence(
      internals,
      progress,
      {
        state: nextState,
        occurrence,
        finalOccurrence,
        withMisses: missesUnwritten,
        work,
        now,
      },
      callbacks,
    );
    if (written === null) return { kind: 'done' };
    nextState = written;
    missesUnwritten = false;
    if (!skipped && state.backfill && nextState.currentWorkflowId !== undefined) {
      return {
        kind: 'settle',
        workflowId: nextState.currentWorkflowId,
        work,
        now,
        index,
        revision: nextState.revision,
        lastFireAt: nextState.lastFireAt,
      };
    }
  }

  return { kind: 'done' };
}
