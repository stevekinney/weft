import type { LocalDateTime, ParsedCronExpression, ZonedParts } from './cron-types.ts';

const WEEKDAY_FROM_PART = new Map([
  ['Sun', 0],
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
]);

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function getDefaultTimeZone(): string {
  return 'UTC';
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'iso8601',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function getOffsetMilliseconds(timestamp: number, timeZone: string): number {
  const parts = getFormatter(timeZone).formatToParts(new Date(timestamp));
  const offsetPart = parts.find((part) => part.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(offsetPart ?? '');
  if (!match) {
    return 0;
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number.parseInt(match[2]!, 10);
  const minutes = Number.parseInt(match[3] ?? '0', 10);
  return sign * (hours * 60 + minutes) * 60_000;
}

export function getZonedParts(timestamp: number, timeZone: string): ZonedParts {
  const formattedParts = getFormatter(timeZone).formatToParts(new Date(timestamp));
  const record = new Map(formattedParts.map((part) => [part.type, part.value]));
  const weekdayValue = record.get('weekday');
  const dayOfWeek = weekdayValue ? WEEKDAY_FROM_PART.get(weekdayValue) : undefined;

  if (dayOfWeek === undefined) {
    throw new Error(`Unable to resolve weekday for time zone "${timeZone}"`);
  }

  return {
    year: Number.parseInt(record.get('year') ?? '', 10),
    month: Number.parseInt(record.get('month') ?? '', 10),
    day: Number.parseInt(record.get('day') ?? '', 10),
    hour: Number.parseInt(record.get('hour') ?? '', 10),
    minute: Number.parseInt(record.get('minute') ?? '', 10),
    second: Number.parseInt(record.get('second') ?? '', 10),
    dayOfWeek,
  };
}

function sameLocalDateTime(left: LocalDateTime, right: ZonedParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

export function localDateTimeToTimestamp(
  localDateTime: LocalDateTime,
  timeZone: string,
  minimumTimestamp: number,
): number | null {
  const naiveTimestamp = Date.UTC(
    localDateTime.year,
    localDateTime.month - 1,
    localDateTime.day,
    localDateTime.hour,
    localDateTime.minute,
    localDateTime.second,
  );

  let candidate = naiveTimestamp;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const offsetMilliseconds = getOffsetMilliseconds(candidate, timeZone);
    const adjustedCandidate = naiveTimestamp - offsetMilliseconds;
    if (adjustedCandidate === candidate) {
      break;
    }
    candidate = adjustedCandidate;
  }

  const candidates = new Set<number>();
  for (let offsetMinutes = -120; offsetMinutes <= 120; offsetMinutes += 15) {
    candidates.add(candidate + offsetMinutes * 60_000);
  }

  const matches = [...candidates]
    .filter((timestamp) => timestamp >= minimumTimestamp)
    .filter((timestamp) => sameLocalDateTime(localDateTime, getZonedParts(timestamp, timeZone)))
    .toSorted((left, right) => left - right);

  return matches[0] ?? null;
}

export function shiftLocalDateTime(
  localDateTime: LocalDateTime,
  adjustment: Partial<Record<'days' | 'hours' | 'minutes', number>>,
): LocalDateTime {
  const date = new Date(
    Date.UTC(
      localDateTime.year,
      localDateTime.month - 1,
      localDateTime.day,
      localDateTime.hour,
      localDateTime.minute,
      localDateTime.second,
    ),
  );

  if (adjustment.days !== undefined) {
    date.setUTCDate(date.getUTCDate() + adjustment.days);
  }
  if (adjustment.hours !== undefined) {
    date.setUTCHours(date.getUTCHours() + adjustment.hours);
  }
  if (adjustment.minutes !== undefined) {
    date.setUTCMinutes(date.getUTCMinutes() + adjustment.minutes);
  }

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

export function selectNextValue(
  values: number[],
  currentValue: number,
): { value: number; wrapped: boolean } {
  for (const value of values) {
    if (value > currentValue) {
      return { value, wrapped: false };
    }
  }

  return { value: values[0]!, wrapped: true };
}

export function matchesDay(parts: ZonedParts, expression: ParsedCronExpression): boolean {
  const matchesDayOfMonth = expression.daysOfMonth.values.includes(parts.day);
  const matchesDayOfWeek = expression.daysOfWeek.values.includes(parts.dayOfWeek);

  if (expression.daysOfMonth.wildcard && expression.daysOfWeek.wildcard) {
    return true;
  }
  if (expression.daysOfMonth.wildcard) {
    return matchesDayOfWeek;
  }
  if (expression.daysOfWeek.wildcard) {
    return matchesDayOfMonth;
  }

  return matchesDayOfMonth || matchesDayOfWeek;
}
