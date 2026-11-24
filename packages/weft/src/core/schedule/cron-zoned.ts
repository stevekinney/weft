/**
 * Cron occurrences in a time zone with daylight-saving transitions.
 *
 * A cron expression names wall-clock times, so a zone's calendar is searched, not its instants:
 * the next local date-time the expression matches is found on a calendar that has no
 * transitions (the local time read as UTC), then resolved to the instant it names. That makes
 * both transitions fall out of one rule, "a wall-clock time happens once":
 *
 * - A local time that does not exist (the hour skipped when the clock springs forward) cannot
 *   resolve to an instant. It is reported as a tick at the transition, the first instant after
 *   the gap, that does not fire and counts the matches it skipped.
 * - A local time that happens twice (the hour repeated when the clock falls back) resolves to its
 *   first instant, and the second pass is not offered again.
 *
 * A consequence of the second rule: an expression that matches every minute or every hour fires
 * through the repeated hour only once. A schedule that must run on elapsed time uses an interval.
 *
 * @module core/schedule/cron-zoned
 */

import { getOffsetMilliseconds, localDateTimeToTimestamp } from './cron-formatter.ts';
import type { LocalDateTime } from './cron-types.ts';

/**
 * One scheduled instant of a cron expression in a zone.
 *
 * `fires` is whether the expression matches the local time at `at`, for the first time that local
 * time happens. `dstGapSkipped` is how many times the expression matched a local time that does
 * not exist in the gap that ends at `at`, and is `0` unless `at` is the instant a clock sprang
 * forward. Both can hold at once: an hourly expression skips 02:00 and fires 03:00 at the same
 * instant. An `at` where neither holds is a repeated local time already offered.
 */
export type CronTick = {
  /** The instant, in milliseconds since the epoch. */
  readonly at: number;
  /** Whether a run starts at `at`. */
  readonly fires: boolean;
  /** How many matches the daylight-saving gap that ends at `at` swallowed. */
  readonly dstGapSkipped: number;
};

/**
 * Finds the next local date-time, read as UTC milliseconds, that the expression matches strictly
 * after the one given. It is a search on a calendar with no transitions.
 */
export type NaiveCronScan = (afterLocal: number) => number;

/** The longest daylight-saving transition anywhere in the tz database is well under this. */
const TRANSITION_WINDOW_MILLISECONDS = 20 * 3_600_000;
const FOLD_LOOKBACK_MILLISECONDS = 3 * 3_600_000;
const MAXIMUM_REPEATED_LOCAL_TIMES_SKIPPED = 10_000;

function localOf(local: number): LocalDateTime {
  const date = new Date(local);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function toLocal(instant: number, timeZone: string): number {
  return instant + getOffsetMilliseconds(instant, timeZone);
}

/** The first instant at which the local time happens, or `null` when it never does. */
function firstInstantOf(local: number, timeZone: string): number | null {
  return localDateTimeToTimestamp(localOf(local), timeZone, Number.NEGATIVE_INFINITY);
}

/** The instant the zone's offset first differs from the one it has at `local - window`. */
function transitionNear(local: number, timeZone: string): number {
  let low = local - TRANSITION_WINDOW_MILLISECONDS;
  let high = local + TRANSITION_WINDOW_MILLISECONDS;
  const offsetBefore = getOffsetMilliseconds(low, timeZone);
  // Transitions land on whole seconds, so the search narrows on seconds.
  low = Math.floor(low / 1000);
  high = Math.ceil(high / 1000);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (getOffsetMilliseconds(middle * 1000, timeZone) === offsetBefore) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return high * 1000;
}

/** How many local times the expression matches in `[start, end)`, read as UTC milliseconds. */
function countMatches(scan: NaiveCronScan, start: number, end: number): number {
  let count = 0;
  let cursor = start - 1000;
  for (;;) {
    cursor = scan(cursor);
    if (cursor >= end) return count;
    count += 1;
  }
}

/** The matches swallowed by the gap that ends at `at`; `0` when `at` is not the end of one. */
function gapSkippedBefore(scan: NaiveCronScan, at: number, timeZone: string): number {
  const offsetBefore = getOffsetMilliseconds(at - 1, timeZone);
  const offsetAfter = getOffsetMilliseconds(at, timeZone);
  if (offsetBefore >= offsetAfter) return 0;
  return countMatches(scan, at + offsetBefore, at + offsetAfter);
}

/** Whether `at` is the first time its local time happens, as opposed to a repeated hour's second pass. */
function isFirstPass(at: number, timeZone: string): boolean {
  const offset = getOffsetMilliseconds(at, timeZone);
  if (getOffsetMilliseconds(at - FOLD_LOOKBACK_MILLISECONDS, timeZone) <= offset) return true;
  return firstInstantOf(at + offset, timeZone) === at;
}

/**
 * Describes the instant `at` for an expression in a zone, from the instant alone: whether it fires
 * and how many gap matches end there. A schedule stores only its next instant, so this is how a
 * tick is recovered from one.
 */
export function describeZonedCronTick(scan: NaiveCronScan, at: number, timeZone: string): CronTick {
  const local = toLocal(at, timeZone);
  const matches = scan(local - 1000) === local;
  return {
    at,
    fires: matches && isFirstPass(at, timeZone),
    dstGapSkipped: gapSkippedBefore(scan, at, timeZone),
  };
}

/**
 * The next tick of an expression in a zone strictly after `afterTimestamp` (to the second), which
 * is the next first-time local match, or the end of the next daylight-saving gap that swallowed a
 * match, whichever comes first.
 */
export function nextZonedCronTick(
  scan: NaiveCronScan,
  afterTimestamp: number,
  timeZone: string,
  maximumSkipped: number = MAXIMUM_REPEATED_LOCAL_TIMES_SKIPPED,
): CronTick {
  const base = Math.floor(afterTimestamp / 1000) * 1000;
  const minimum = base + 1000;
  let cursor = toLocal(base, timeZone);
  for (let skipped = 0; skipped < maximumSkipped; skipped += 1) {
    const local = scan(cursor);
    const instant = firstInstantOf(local, timeZone);
    if (instant === null) {
      return describeZonedCronTick(scan, transitionNear(local, timeZone), timeZone);
    }
    if (instant >= minimum) {
      return describeZonedCronTick(scan, instant, timeZone);
    }
    // The first time this local time happened is already behind the search: a repeated hour's
    // second pass. It was offered once, so it is not offered again.
    cursor = local;
  }
  throw new Error('Could not find the next cron occurrence after a repeated hour');
}
