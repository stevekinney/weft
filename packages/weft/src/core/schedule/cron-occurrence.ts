import { normalizeStorageTimestamp } from '../scheduler.ts';
import {
  getDefaultTimeZone,
  getZonedParts,
  localDateTimeToTimestamp,
  matchesDay,
  selectNextValue,
  shiftLocalDateTime,
} from './cron-formatter.ts';
import { parseCronExpression } from './cron-parser.ts';
import type {
  CronOccurrenceOptions,
  LocalDateTime,
  ParsedCronExpression,
  ZonedParts,
} from './cron-types.ts';
import { describeZonedCronTick, nextZonedCronTick, type CronTick } from './cron-zoned.ts';

function nextSearchTimestamp(candidate: number): number {
  return candidate + 1000;
}

function startOfLocalDay(parts: ZonedParts): LocalDateTime {
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function advanceToNextMonth(
  candidate: number,
  parts: ZonedParts,
  parsedExpression: ParsedCronExpression,
  timeZone: string,
): number {
  const nextMonth = selectNextValue(parsedExpression.months.values, parts.month);
  const monthCandidate = localDateTimeToTimestamp(
    {
      year: parts.year + (nextMonth.wrapped ? 1 : 0),
      month: nextMonth.value,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
    nextSearchTimestamp(candidate),
  );

  return monthCandidate ?? candidate + 86_400_000;
}

function advanceToNextDay(candidate: number, parts: ZonedParts, timeZone: string): number {
  const nextDayCandidate = localDateTimeToTimestamp(
    shiftLocalDateTime(startOfLocalDay(parts), { days: 1 }),
    timeZone,
    nextSearchTimestamp(candidate),
  );

  return nextDayCandidate ?? candidate + 86_400_000;
}

function advanceToNextHour(
  candidate: number,
  parts: ZonedParts,
  parsedExpression: ParsedCronExpression,
  timeZone: string,
): number {
  const nextHour = selectNextValue(parsedExpression.hours.values, parts.hour);
  const hourCandidate = localDateTimeToTimestamp(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: nextHour.value,
      minute: 0,
      second: 0,
    },
    timeZone,
    nextSearchTimestamp(candidate),
  );

  return hourCandidate ?? advanceToNextDay(candidate, parts, timeZone);
}

function advanceToNextMinute(
  candidate: number,
  parts: ZonedParts,
  parsedExpression: ParsedCronExpression,
  timeZone: string,
): number {
  const nextMinute = selectNextValue(parsedExpression.minutes.values, parts.minute);
  const minuteCandidate = localDateTimeToTimestamp(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: nextMinute.value,
      second: 0,
    },
    timeZone,
    nextSearchTimestamp(candidate),
  );

  if (minuteCandidate !== null) {
    return minuteCandidate;
  }

  const nextHourBoundary = localDateTimeToTimestamp(
    shiftLocalDateTime(
      {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: 0,
        second: 0,
      },
      { hours: 1 },
    ),
    timeZone,
    nextSearchTimestamp(candidate),
  );

  return nextHourBoundary ?? candidate + 3_600_000;
}

function advanceToNextSecond(
  candidate: number,
  parts: ZonedParts,
  parsedExpression: ParsedCronExpression,
  timeZone: string,
): number {
  const nextSecond = selectNextValue(parsedExpression.seconds.values, parts.second);
  const secondCandidate = localDateTimeToTimestamp(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: nextSecond.value,
    },
    timeZone,
    nextSearchTimestamp(candidate),
  );

  if (secondCandidate !== null) {
    return secondCandidate;
  }

  const nextMinuteBoundary = localDateTimeToTimestamp(
    shiftLocalDateTime(
      {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: parts.minute,
        second: 0,
      },
      { minutes: 1 },
    ),
    timeZone,
    nextSearchTimestamp(candidate),
  );

  return nextMinuteBoundary ?? candidate + 60_000;
}

/**
 * How many candidate steps the search takes before it gives up on an expression that parses but
 * can never match, such as the 31st of April. Each step resolves a zoned calendar date, so the
 * exhaustive search is seconds of real work; only the slow lane runs it at this bound.
 */
const MAXIMUM_CRON_SEARCH_STEPS = 100_000;

/**
 * Find the next occurrence of a cron expression after a timestamp, giving up after
 * `maximumSearchSteps` candidate steps. This is the search behind {@link getNextCronOccurrence},
 * which fixes the bound at {@link MAXIMUM_CRON_SEARCH_STEPS}; it is exported so a fast test can
 * exhaust the search with a small bound instead of the production one.
 *
 * It scans instants, so in a zone with daylight-saving transitions it offers a repeated hour's
 * wall-clock time twice. A caller that resolves a time zone goes through {@link getNextCronTick},
 * which scans the zone's calendar instead and so offers each wall-clock time once.
 */
export function searchNextCronOccurrence(
  expression: string | ParsedCronExpression,
  afterTimestamp: number,
  options: CronOccurrenceOptions | undefined,
  maximumSearchSteps: number,
): number {
  const parsedExpression =
    typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const timeZone = options?.timeZone ?? getDefaultTimeZone();
  let candidate = normalizeStorageTimestamp(
    Math.floor(afterTimestamp / 1000) * 1000 + 1000,
    'Cron occurrence candidate',
  );

  for (let iteration = 0; iteration < maximumSearchSteps; iteration += 1) {
    const parts = getZonedParts(candidate, timeZone);

    if (!parsedExpression.months.values.includes(parts.month)) {
      candidate = advanceToNextMonth(candidate, parts, parsedExpression, timeZone);
      continue;
    }

    if (!matchesDay(parts, parsedExpression)) {
      candidate = advanceToNextDay(candidate, parts, timeZone);
      continue;
    }

    if (!parsedExpression.hours.values.includes(parts.hour)) {
      candidate = advanceToNextHour(candidate, parts, parsedExpression, timeZone);
      continue;
    }

    if (!parsedExpression.minutes.values.includes(parts.minute)) {
      candidate = advanceToNextMinute(candidate, parts, parsedExpression, timeZone);
      continue;
    }

    if (!parsedExpression.seconds.values.includes(parts.second)) {
      candidate = advanceToNextSecond(candidate, parts, parsedExpression, timeZone);
      continue;
    }

    return candidate;
  }

  throw new Error(`Could not find the next cron occurrence for "${parsedExpression.expression}"`);
}

const DEFAULT_CRON_TIME_ZONE = 'UTC';

function isUtc(options: CronOccurrenceOptions | undefined): boolean {
  const timeZone = options?.timeZone ?? DEFAULT_CRON_TIME_ZONE;
  return timeZone === DEFAULT_CRON_TIME_ZONE;
}

function utcScan(parsedExpression: ParsedCronExpression) {
  return (afterLocal: number): number =>
    searchNextCronOccurrence(
      parsedExpression,
      afterLocal,
      { timeZone: DEFAULT_CRON_TIME_ZONE },
      MAXIMUM_CRON_SEARCH_STEPS,
    );
}

/**
 * The next tick of a cron expression after a timestamp, in the options' time zone (UTC when
 * omitted). A tick is an instant the schedule has to account for: one that fires, or the end of a
 * daylight-saving gap that swallowed a match (see {@link CronTick}). In UTC every tick fires.
 *
 * A wall-clock time happens once: a time the clock skips when it springs forward is a tick that
 * does not fire, and a time the clock repeats when it falls back is offered only the first time.
 */
export function getNextCronTick(
  expression: string | ParsedCronExpression,
  afterTimestamp: number,
  options?: CronOccurrenceOptions,
): CronTick {
  const parsedExpression =
    typeof expression === 'string' ? parseCronExpression(expression) : expression;
  if (isUtc(options)) {
    return {
      at: getNextCronOccurrence(parsedExpression, afterTimestamp, options),
      fires: true,
      dstGapSkipped: 0,
    };
  }
  return nextZonedCronTick(utcScan(parsedExpression), afterTimestamp, options!.timeZone!);
}

/**
 * The next instant a cron expression fires after a timestamp. In a zone with daylight-saving
 * transitions a gap tick is stepped over, so it never names a wall-clock time that does not exist.
 */
export function getNextCronOccurrence(
  expression: string | ParsedCronExpression,
  afterTimestamp: number,
  options?: CronOccurrenceOptions,
): number {
  if (isUtc(options)) {
    return searchNextCronOccurrence(
      expression,
      afterTimestamp,
      { ...options, timeZone: DEFAULT_CRON_TIME_ZONE },
      MAXIMUM_CRON_SEARCH_STEPS,
    );
  }
  const parsedExpression =
    typeof expression === 'string' ? parseCronExpression(expression) : expression;
  let cursor = afterTimestamp;
  for (;;) {
    const tick = getNextCronTick(parsedExpression, cursor, options);
    if (tick.fires) return tick.at;
    cursor = tick.at;
  }
}

function assertMaximumOccurrences(requested: number | undefined): number {
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0)) {
    throw new Error('Cron occurrence maxOccurrences must be a positive safe integer');
  }
  return requested ?? Number.POSITIVE_INFINITY;
}

/**
 * Every tick of a cron expression in the inclusive window `[firstDueAt, throughTimestamp]`, up to
 * `options.maxOccurrences`. `firstDueAt` is a bare instant, as a schedule stores it, so the first
 * tick's `fires` and `dstGapSkipped` are re-derived from it.
 */
export function collectDueCronTicks(
  expression: string | ParsedCronExpression,
  firstDueAt: number,
  throughTimestamp: number,
  options?: CronOccurrenceOptions,
): CronTick[] {
  const parsedExpression =
    typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const maximumOccurrences = assertMaximumOccurrences(options?.maxOccurrences);
  const ticks: CronTick[] = [];
  const utc = isUtc(options);
  let next: CronTick = utc
    ? { at: firstDueAt, fires: true, dstGapSkipped: 0 }
    : describeZonedCronTick(utcScan(parsedExpression), firstDueAt, options!.timeZone!);

  while (next.at <= throughTimestamp && ticks.length < maximumOccurrences) {
    ticks.push(next);
    next = getNextCronTick(parsedExpression, next.at, options);
  }

  return ticks;
}

/** The instants in `[firstDueAt, throughTimestamp]` at which a cron expression fires. */
export function collectDueCronOccurrences(
  expression: string | ParsedCronExpression,
  firstDueAt: number,
  throughTimestamp: number,
  options?: CronOccurrenceOptions,
): number[] {
  return collectDueCronTicks(expression, firstDueAt, throughTimestamp, options)
    .filter((tick) => tick.fires)
    .map((tick) => tick.at);
}
