/**
 * What an update of a schedule's cadence leaves of its next run and of the runs a person skipped
 * (COR-1985, COR-2018).
 */

import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { earliestSkippableOccurrence } from './schedule-controls.ts';
import { isFiringScheduleOccurrence } from './schedule-occurrence.ts';

/**
 * The next wake-up an update leaves the schedule at (COR-1985): none for a cancelled schedule, the
 * run an active schedule was already waiting for when the update keeps its interval grid, and the
 * first occurrence after the update otherwise.
 */
export function updatedNextFireAt(
  state: ScheduleState,
  keepsIntervalGrid: boolean,
  computeFromNow: () => number,
): number | null {
  if (state.status === 'cancelled') return null;
  if (keepsIntervalGrid && state.status === 'active' && state.nextFireAt !== null) {
    return state.nextFireAt;
  }
  return computeFromNow();
}

/**
 * The skipped occurrences of `state` that `updated` still has as upcoming runs (COR-1985,
 * COR-2018). A skip names one occurrence, so an update that leaves it a run of the cadence (a new
 * description, an overlap policy, a cron expression that still matches it) keeps it, and one that
 * moves the cadence, or the zone it is read in, off it ends it. Upcoming is counted from the run a
 * skip of `updated` would name first ({@link earliestSkippableOccurrence}): not `nextFireAt`, which
 * an overdue interval, a backfill that is catching up, or the end of a daylight-saving gap that
 * starts nothing leave before it.
 */
export function survivingSkips(
  internals: EngineInternals,
  state: ScheduleState,
  updated: ScheduleState,
  now: number,
): number[] {
  const skipped = state.skippedOccurrences ?? [];
  if (skipped.length === 0) return [];
  const earliest = earliestSkippableOccurrence(internals, updated, now);
  if (earliest === null) return [];
  return skipped.filter((at) => at >= earliest && isFiringScheduleOccurrence(updated, at));
}
