import { collectDueCronTicks, getNextCronTick, type CronTick } from '../schedule.ts';
import {
  collectDueIntervalOccurrences,
  getNextIntervalOccurrence,
} from '../schedule/interval-occurrence.ts';
import type { ScheduleState } from '../types.ts';

/**
 * The recurrence cadence of a schedule, decoded from persisted state into a
 * single discriminated value so occurrence computation never has to inspect
 * both `cronExpression` and `intervalMs` at every call site.
 */
export type ScheduleCadence =
  | { kind: 'cron'; cronExpression: string; timeZone: string }
  | { kind: 'interval'; intervalMs: number; anchor: number };

/**
 * One instant a schedule wakes at: whether a run starts there, and how many wall-clock times the
 * daylight-saving gap that ends there swallowed. Every tick of an interval schedule, and of a cron
 * schedule in UTC, fires and swallows nothing.
 */
export type ScheduleTick = CronTick;

/**
 * What a cadence needs of a schedule. The time zone is required, not defaulted, so a source built
 * by hand cannot compute a cron occurrence in UTC for a schedule that is read in another zone.
 */
type CadenceSource = Pick<
  ScheduleState,
  'cronExpression' | 'intervalMs' | 'createdAt' | 'timeZone'
>;

/**
 * Resolve the cadence of a schedule from its persisted state. Interval schedules
 * are anchored at `createdAt`. Throws if the state carries neither a cron
 * expression nor an interval, which should never happen for a record that passed
 * decode validation.
 */
export function resolveScheduleCadence(state: CadenceSource): ScheduleCadence {
  if (state.intervalMs !== undefined) {
    return { kind: 'interval', intervalMs: state.intervalMs, anchor: state.createdAt };
  }
  if (state.cronExpression !== undefined) {
    return { kind: 'cron', cronExpression: state.cronExpression, timeZone: state.timeZone };
  }
  throw new Error('Schedule state must define either a cron expression or an interval');
}

/**
 * Compute the next instant strictly after `afterTimestamp` that a schedule wakes at, dispatching on
 * cadence kind. Cron schedules defer to the cron engine in the schedule's time zone; interval
 * schedules step forward one period anchored at creation time. A cron schedule's next instant may be
 * the end of a daylight-saving gap that swallowed one of its wall-clock times, where it records the
 * miss and fires only if the expression also matches (see {@link ScheduleTick}).
 */
export function getNextScheduleOccurrence(state: CadenceSource, afterTimestamp: number): number {
  const cadence = resolveScheduleCadence(state);
  if (cadence.kind === 'interval') {
    return getNextIntervalOccurrence(cadence.anchor, cadence.intervalMs, afterTimestamp);
  }
  return getNextCronTick(cadence.cronExpression, afterTimestamp, {
    timeZone: cadence.timeZone,
  }).at;
}

/**
 * Collect every tick in the inclusive window `[firstDueAt, throughTimestamp]` for a schedule,
 * dispatching on cadence kind. `maxOccurrences` bounds the result so a long backfill window cannot
 * produce an unbounded list. `firstDueAt` is a bare stored instant, so a cron tick's `fires` and
 * `dstGapSkipped` are re-derived from it.
 */
export function collectDueScheduleTicks(
  state: CadenceSource,
  firstDueAt: number,
  throughTimestamp: number,
  maxOccurrences: number,
): ScheduleTick[] {
  const cadence = resolveScheduleCadence(state);
  if (cadence.kind === 'interval') {
    return collectDueIntervalOccurrences(
      cadence.anchor,
      cadence.intervalMs,
      firstDueAt,
      throughTimestamp,
      { maxOccurrences },
    ).map((at) => ({ at, fires: true, dstGapSkipped: 0 }));
  }
  return collectDueCronTicks(cadence.cronExpression, firstDueAt, throughTimestamp, {
    timeZone: cadence.timeZone,
    maxOccurrences,
  });
}

/**
 * The first instant at or after `fromAt` (a tick of the schedule) that starts a run. A tick is not
 * always a fire: in a time zone, `nextFireAt` can be the end of a daylight-saving gap that swallowed
 * a wall-clock time and fires only if the expression also matches it (see {@link ScheduleTick}).
 * A gap's end is followed by a later tick, so the search ends.
 */
export function findFiringScheduleOccurrence(state: CadenceSource, fromAt: number): number {
  let at = fromAt;
  for (;;) {
    const [tick] = collectDueScheduleTicks(state, at, at, 1);
    if (tick === undefined || tick.fires) return at;
    at = getNextScheduleOccurrence(state, at);
  }
}

/**
 * Whether a person asked to skip the occurrence at `at` ({@link ScheduleState.skippedOccurrences}):
 * that occurrence exactly, so a skip never takes an earlier occurrence a tick is still owed.
 */
export function isSkippedOccurrence(
  state: Pick<ScheduleState, 'skippedOccurrences'>,
  at: number,
): boolean {
  return state.skippedOccurrences?.includes(at) === true;
}

/**
 * Whether `at` is an instant the schedule's cadence starts a run at: a tick of the cadence (a cron
 * time read in its zone, or a point on an interval's grid) that is not the end of a daylight-saving
 * gap that starts nothing.
 */
export function isFiringScheduleOccurrence(state: CadenceSource, at: number): boolean {
  if (!Number.isSafeInteger(at) || at < 1) return false;
  if (getNextScheduleOccurrence(state, at - 1) !== at) return false;
  return findFiringScheduleOccurrence(state, at) === at;
}

/**
 * `state` skipping exactly `occurrences`, kept ascending and without repeats, or without the field
 * when there are none ({@link ScheduleState.skippedOccurrences} is absent when nothing is skipped).
 */
export function withSkippedOccurrences(
  state: ScheduleState,
  occurrences: Iterable<number>,
): ScheduleState {
  const { skippedOccurrences: _replaced, ...rest } = state;
  const sorted = [...new Set(occurrences)].toSorted((left, right) => left - right);
  return sorted.length === 0 ? rest : { ...rest, skippedOccurrences: sorted };
}

/** `state` without the skipped occurrences before `from`, which the schedule has moved past. */
export function withSkipsFrom(state: ScheduleState, from: number): ScheduleState {
  return withSkippedOccurrences(
    state,
    (state.skippedOccurrences ?? []).filter((at) => at >= from),
  );
}
