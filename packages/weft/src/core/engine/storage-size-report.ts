import { MAX_TIMER_DELAY_MS } from '../application-primitive-guards.ts';

export function normalizeStorageSizeReportInterval(
  value: unknown,
  fieldName: string,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  // The interval is scheduled as one `setInterval`, and a host timer clamps a
  // longer delay to 1 ms, which would query storage on every tick.
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `${fieldName} must be a non-negative safe integer of at most ${MAX_TIMER_DELAY_MS} milliseconds, the largest delay a timer can schedule`,
    );
  }
  return value;
}
