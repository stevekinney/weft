import type { CronField, ParsedCronExpression } from './cron-types.ts';

const MONTH_NAMES = new Map([
  ['JAN', 1],
  ['FEB', 2],
  ['MAR', 3],
  ['APR', 4],
  ['MAY', 5],
  ['JUN', 6],
  ['JUL', 7],
  ['AUG', 8],
  ['SEP', 9],
  ['OCT', 10],
  ['NOV', 11],
  ['DEC', 12],
]);

const DAY_NAMES = new Map([
  ['SUN', 0],
  ['MON', 1],
  ['TUE', 2],
  ['WED', 3],
  ['THU', 4],
  ['FRI', 5],
  ['SAT', 6],
]);

function parseNamedValue(
  token: string,
  names: Map<string, number> | undefined,
  minimum: number,
  maximum: number,
): number {
  const upperToken = token.toUpperCase();
  if (names?.has(upperToken)) {
    return names.get(upperToken)!;
  }

  const numericValue = Number.parseInt(token, 10);
  if (!Number.isInteger(numericValue)) {
    throw new Error(`Invalid cron token "${token}"`);
  }

  const normalizedValue = maximum === 6 && numericValue === 7 ? 0 : numericValue;
  if (normalizedValue < minimum || normalizedValue > maximum) {
    throw new Error(`Cron token "${token}" is outside the allowed range ${minimum}-${maximum}`);
  }

  return normalizedValue;
}

function buildWildcardCronField(minimum: number, maximum: number): CronField {
  return {
    values: Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index),
    wildcard: true,
  };
}

function parseCronStep(segment: string, stepPart: string | undefined): number {
  const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`Invalid cron step "${segment}"`);
  }

  return step;
}

function addSteppedValues(values: Set<number>, start: number, end: number, step: number): void {
  for (let value = start; value <= end; value += step) {
    values.add(value);
  }
}

function addCronSegmentValues(
  values: Set<number>,
  segment: string,
  minimum: number,
  maximum: number,
  names: Map<string, number> | undefined,
): void {
  const [rangePart = '', stepPart] = segment.split('/');
  const step = parseCronStep(segment, stepPart);

  if (rangePart === '*' || rangePart === '?') {
    addSteppedValues(values, minimum, maximum, step);
    return;
  }

  const [startToken, endToken] = rangePart.split('-');
  const start = parseNamedValue(startToken!, names, minimum, maximum);
  const end = endToken === undefined ? start : parseNamedValue(endToken, names, minimum, maximum);

  if (start > end) {
    throw new Error(`Invalid cron range "${segment}"`);
  }

  addSteppedValues(values, start, end, step);
}

function parseCronField(
  field: string,
  minimum: number,
  maximum: number,
  names?: Map<string, number>,
): CronField {
  const trimmedField = field.trim();
  if (trimmedField === '*' || trimmedField === '?') {
    return buildWildcardCronField(minimum, maximum);
  }

  const values = new Set<number>();
  const segments = trimmedField.split(',');

  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (segment.length === 0) {
      throw new Error(`Invalid cron field "${field}"`);
    }

    addCronSegmentValues(values, segment, minimum, maximum, names);
  }

  return {
    values: [...values].toSorted((left, right) => left - right),
    wildcard: false,
  };
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression
    .trim()
    .split(/\s+/)
    .filter((field) => field.length > 0);

  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error('Cron expression must have 5 fields or 6 fields with seconds');
  }

  const hasSeconds = fields.length === 6;
  const [secondField, minuteField, hourField, dayField, monthField, weekdayField] = hasSeconds
    ? fields
    : ['0', ...fields];

  return {
    expression,
    hasSeconds,
    seconds: parseCronField(secondField!, 0, 59),
    minutes: parseCronField(minuteField!, 0, 59),
    hours: parseCronField(hourField!, 0, 23),
    daysOfMonth: parseCronField(dayField!, 1, 31),
    months: parseCronField(monthField!, 1, 12, MONTH_NAMES),
    daysOfWeek: parseCronField(weekdayField!, 0, 6, DAY_NAMES),
  };
}
