/**
 * Pure token-bucket record and reducer behind `DurableRateLimiter`, split out
 * of `concurrency.ts` to keep that file under the line budget (mirroring
 * `concurrency-lock-record.ts`). Deterministic in its inputs, so it replays
 * identically.
 *
 * @module core/concurrency-token-bucket
 */

/**
 * Persisted state of a {@link DurableRateLimiter} bucket, stored in one CAS
 * slot per bucket. An `undefined` slot is a fresh bucket: full at
 * `maximumTokens`, with `lastRefillAt` set to the first `now` observed.
 *
 * @example
 * ```ts
 * import type { TokenBucketRecord } from '@lostgradient/weft';
 *
 * const record: TokenBucketRecord = { tokens: 4, lastRefillAt: 1_700_000_000_000 };
 * void record;
 * ```
 */
export interface TokenBucketRecord {
  /** Whole tokens currently available. */
  tokens: number;
  /** Timestamp (ms) through which whole refill intervals have been credited. */
  lastRefillAt: number;
}

/** Outcome of a {@link DurableRateLimiter.tryConsume} call. */
export interface TokenConsumeResult {
  consumed: boolean;
  /** `0` when consumed; otherwise milliseconds until the next token is credited. */
  retryAfterMs: number;
}

/** Bucket parameters plus the caller-supplied clock reading. */
export interface ConsumeInput {
  tokensPerInterval: number;
  interval: number;
  maximumTokens: number;
  now: number;
}

/**
 * Pure token-bucket transition: refill by whole intervals, then try to take
 * one token. Deterministic in `(current, input)` so it replays identically.
 * `current === undefined` is a fresh bucket, full at `maximumTokens`.
 */
export function reduceConsume(
  current: TokenBucketRecord | undefined,
  input: ConsumeInput,
): { record: TokenBucketRecord; result: TokenConsumeResult } {
  const { tokensPerInterval, interval, maximumTokens, now } = input;
  const base = current ?? { tokens: maximumTokens, lastRefillAt: now };
  const intervals = Math.max(0, Math.floor((now - base.lastRefillAt) / interval));
  const tokens = Math.min(maximumTokens, base.tokens + intervals * tokensPerInterval);
  const lastRefillAt = base.lastRefillAt + intervals * interval;
  if (tokens >= 1) {
    return {
      record: { tokens: tokens - 1, lastRefillAt },
      result: { consumed: true, retryAfterMs: 0 },
    };
  }
  return {
    record: { tokens, lastRefillAt },
    result: { consumed: false, retryAfterMs: lastRefillAt + interval - now },
  };
}

/**
 * Options for {@link DurableRateLimiter}. `interval` is deliberately not
 * `intervalMs`: it matches the option names of the non-durable token bucket in
 * `@lostgradient/operative`'s backpressure module.
 *
 * @example
 * ```ts
 * import { DurableRateLimiter, type DurableRateLimiterOptions } from '@lostgradient/weft';
 *
 * const options: DurableRateLimiterOptions = {
 *   tokensPerInterval: 10,
 *   interval: 1_000,
 *   maximumTokens: 20,
 * };
 * const limiter = new DurableRateLimiter(options);
 * void limiter;
 * ```
 */
export interface DurableRateLimiterOptions {
  /** Tokens credited per whole elapsed interval. Positive integer. */
  tokensPerInterval: number;
  /** Interval length in milliseconds. Positive finite number. */
  interval: number;
  /** Bucket capacity. Positive integer `>= tokensPerInterval`. Defaults to `tokensPerInterval`. */
  maximumTokens?: number;
}

/**
 * Validate {@link DurableRateLimiterOptions} and return the resolved
 * `maximumTokens`, throwing `RangeError` for any invalid value.
 */
export function resolveRateLimiterOptions(options: DurableRateLimiterOptions): number {
  const { tokensPerInterval, interval } = options;
  if (!Number.isInteger(tokensPerInterval) || tokensPerInterval < 1) {
    throw new RangeError(
      `DurableRateLimiter tokensPerInterval must be a positive integer, received ${tokensPerInterval}`,
    );
  }
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new RangeError(
      `DurableRateLimiter interval must be a positive number of milliseconds, received ${interval}`,
    );
  }
  const maximumTokens = options.maximumTokens ?? tokensPerInterval;
  if (!Number.isInteger(maximumTokens) || maximumTokens < tokensPerInterval) {
    throw new RangeError(
      `DurableRateLimiter maximumTokens must be a positive integer >= tokensPerInterval (${tokensPerInterval}), received ${maximumTokens}`,
    );
  }
  return maximumTokens;
}
