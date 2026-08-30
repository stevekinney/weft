import { normalizeStorageTimestamp } from '../scheduler.ts';

/**
 * Options shared by the interval occurrence helpers. `maxOccurrences` bounds the
 * number of due occurrences {@link collectDueIntervalOccurrences} returns in a
 * single call so a long backfill window cannot generate an unbounded list.
 */
export type IntervalOccurrenceOptions = {
  maxOccurrences?: number;
};

function assertPositiveInterval(intervalMilliseconds: number): void {
  if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds <= 0) {
    throw new Error('Interval schedule period must be a positive safe integer of milliseconds');
  }
}

/**
 * Compute the first interval occurrence strictly after `afterTimestamp`.
 *
 * Occurrences are anchored at `anchorTimestamp` and spaced exactly
 * `intervalMilliseconds` apart: `anchor + n * interval` for `n >= 1`. The result
 * is the smallest such timestamp greater than `afterTimestamp`, so repeatedly
 * feeding the previous result back in walks forward one interval at a time.
 *
 * For example, a 1-hour interval anchored at epoch (`0`), asked for the next
 * occurrence after 90 minutes (`5_400_000`), returns the 2-hour mark
 * (`7_200_000`).
 */
export function getNextIntervalOccurrence(
  anchorTimestamp: number,
  intervalMilliseconds: number,
  afterTimestamp: number,
): number {
  assertPositiveInterval(intervalMilliseconds);
  const normalizedAnchor = normalizeStorageTimestamp(anchorTimestamp, 'Interval anchor');
  const normalizedAfter = normalizeStorageTimestamp(
    afterTimestamp,
    'Interval occurrence candidate',
  );

  if (normalizedAfter < normalizedAnchor) {
    return normalizedAnchor + intervalMilliseconds;
  }

  const elapsed = normalizedAfter - normalizedAnchor;
  const completedIntervals = Math.floor(elapsed / intervalMilliseconds);
  const candidate = normalizedAnchor + (completedIntervals + 1) * intervalMilliseconds;
  return normalizeStorageTimestamp(candidate, 'Interval occurrence');
}

/**
 * Collect every interval occurrence in the inclusive window
 * `[firstDueAt, throughTimestamp]`, anchored at `anchorTimestamp`. Mirrors the
 * cron occurrence collector so the schedule timer can drive backfill through a
 * single code path regardless of spec kind.
 *
 * For example, a 1-hour interval first due at the 1-hour mark, collected through
 * the 3-hour mark, yields the 1-hour, 2-hour, and 3-hour timestamps.
 */
export function collectDueIntervalOccurrences(
  anchorTimestamp: number,
  intervalMilliseconds: number,
  firstDueAt: number,
  throughTimestamp: number,
  options?: IntervalOccurrenceOptions,
): number[] {
  assertPositiveInterval(intervalMilliseconds);
  const requestedMaxOccurrences = options?.maxOccurrences;
  if (
    requestedMaxOccurrences !== undefined &&
    (!Number.isSafeInteger(requestedMaxOccurrences) || requestedMaxOccurrences <= 0)
  ) {
    throw new Error('Interval occurrence maxOccurrences must be a positive safe integer');
  }
  const maximumOccurrences = requestedMaxOccurrences ?? Number.POSITIVE_INFINITY;
  const dueOccurrences: number[] = [];
  let nextOccurrence = firstDueAt;

  while (nextOccurrence <= throughTimestamp && dueOccurrences.length < maximumOccurrences) {
    dueOccurrences.push(nextOccurrence);
    nextOccurrence = getNextIntervalOccurrence(
      anchorTimestamp,
      intervalMilliseconds,
      nextOccurrence,
    );
  }

  return dueOccurrences;
}
