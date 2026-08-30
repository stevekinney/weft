import type { Duration, RetryPolicy } from '../types.ts';

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

const DURATION_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/i;

const UNIT_TO_MILLISECONDS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

function assertValidDurationMilliseconds(milliseconds: number, source: Duration): void {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      `Duration must resolve to a finite, non-negative number of milliseconds, got: ${String(source)}`,
    );
  }
}

export function normalizeStorageTimestamp(timestamp: number, fieldName: string): number {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new RangeError(
      `${fieldName} must resolve to a finite, non-negative millisecond timestamp, got: ${String(timestamp)}`,
    );
  }

  const normalizedTimestamp = Math.ceil(timestamp);

  if (!Number.isSafeInteger(normalizedTimestamp)) {
    throw new RangeError(
      `${fieldName} must resolve to a safe integer millisecond timestamp, got: ${String(timestamp)}`,
    );
  }

  return normalizedTimestamp;
}

/**
 * Parse a human-readable duration string or number to milliseconds.
 *
 * @example
 * ```ts
 * import { parseDuration } from '@lostgradient/weft';
 *
 * console.log(parseDuration(5000));       // 5000
 * console.log(parseDuration('250ms'));    // 250
 * console.log(parseDuration('30s'));      // 30000
 * console.log(parseDuration('5 minutes')); // 300000
 * console.log(parseDuration('2h'));       // 7200000
 * console.log(parseDuration('1d'));       // 86400000
 * ```
 *
 * @throws Error when the string uses an invalid format or unknown unit.
 * @throws RangeError when the resulting duration is negative or non-finite.
 */
export function parseDuration(duration: Duration): number {
  if (typeof duration === 'number') {
    assertValidDurationMilliseconds(duration, duration);
    return duration;
  }

  const match = DURATION_PATTERN.exec(duration.trim());

  if (!match) {
    throw new Error(
      `Invalid duration string: "${duration}". Expected a number or a string like "30s", "5 minutes", "1 hour", etc.`,
    );
  }

  const value = Number.parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  const multiplier = UNIT_TO_MILLISECONDS[unit];

  if (multiplier === undefined) {
    throw new Error(`Unknown duration unit: "${unit}"`);
  }

  const milliseconds = value * multiplier;
  assertValidDurationMilliseconds(milliseconds, duration);
  return milliseconds;
}

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

/**
 * Calculate exponential backoff delay for a given retry attempt.
 * `attempt` is 1-indexed: `calculateBackoff(1, policy)` returns
 * `initialBackoff` directly. Pass `0` only for non-retry probes; the result is
 * `initialBackoff / backoffMultiplier`.
 *
 * @example
 * ```ts
 * import { calculateBackoff, type RetryPolicy } from '@lostgradient/weft';
 *
 * const policy: RetryPolicy = {
 *   maxAttempts: 5,
 *   initialBackoff: '1s',
 *   backoffMultiplier: 2,
 *   maxBackoff: '30s',
 * };
 *
 * console.log(calculateBackoff(1, policy)); // 1000   (attempt 1: 1s)
 * console.log(calculateBackoff(2, policy)); // 2000   (attempt 2: 2s)
 * console.log(calculateBackoff(5, policy)); // 16000  (attempt 5: 16s, capped at 30s)
 * ```
 */
export function calculateBackoff(attempt: number, policy: RetryPolicy): number {
  const initialMs = parseDuration(policy.initialBackoff);
  const maxMs = parseDuration(policy.maxBackoff);
  const raw = initialMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  return Math.min(raw, maxMs);
}
