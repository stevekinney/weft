import { collectDueCronOccurrences, getNextCronOccurrence } from '../schedule.ts';
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
  | { kind: 'cron'; cronExpression: string }
  | { kind: 'interval'; intervalMs: number; anchor: number };

type CadenceSource = Pick<ScheduleState, 'cronExpression' | 'intervalMs' | 'createdAt'>;

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
    return { kind: 'cron', cronExpression: state.cronExpression };
  }
  throw new Error('Schedule state must define either a cron expression or an interval');
}

/**
 * Compute the next occurrence strictly after `afterTimestamp` for a schedule,
 * dispatching on cadence kind. Cron schedules defer to the cron engine; interval
 * schedules step forward one period anchored at creation time.
 */
export function getNextScheduleOccurrence(state: CadenceSource, afterTimestamp: number): number {
  const cadence = resolveScheduleCadence(state);
  if (cadence.kind === 'interval') {
    return getNextIntervalOccurrence(cadence.anchor, cadence.intervalMs, afterTimestamp);
  }
  return getNextCronOccurrence(cadence.cronExpression, afterTimestamp);
}

/**
 * Collect every occurrence in the inclusive window `[firstDueAt, throughTimestamp]`
 * for a schedule, dispatching on cadence kind. `maxOccurrences` bounds the result
 * so a long backfill window cannot produce an unbounded list.
 */
export function collectDueScheduleOccurrences(
  state: CadenceSource,
  firstDueAt: number,
  throughTimestamp: number,
  maxOccurrences: number,
): number[] {
  const cadence = resolveScheduleCadence(state);
  if (cadence.kind === 'interval') {
    return collectDueIntervalOccurrences(
      cadence.anchor,
      cadence.intervalMs,
      firstDueAt,
      throughTimestamp,
      { maxOccurrences },
    );
  }
  return collectDueCronOccurrences(cadence.cronExpression, firstDueAt, throughTimestamp, {
    maxOccurrences,
  });
}
