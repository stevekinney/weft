/**
 * In-process request rate limiting keyed by principal or client address.
 *
 * Weft's request pipeline previously capped only body size (1 MB) and JSON-RPC
 * batch length (100 items); a single principal or IP could otherwise flood the
 * server with unbounded request volume. This limiter adds a configurable
 * fixed-window counter so a hostile or runaway caller is throttled with HTTP
 * 429 once it exceeds its budget.
 *
 * **Scope and trust posture.** This is a single-process, in-memory limiter — it
 * is a load-shedding guardrail, not a distributed quota. Behind multiple server
 * instances each process keeps its own counters; deployments that need a global
 * budget should still front Weft with a shared reverse-proxy limiter. The
 * in-process limiter exists so a single instance cannot be trivially flooded
 * even when no proxy is present.
 *
 * The window clock is injectable so tests advance time deterministically rather
 * than sleeping against the wall clock.
 *
 * @module server/authentication/rate-limiter
 */

/**
 * Configuration for the request rate limiter, supplied via
 * `serve({ rateLimit })`. Omitting `rateLimit` entirely disables limiting (the
 * historical behavior), so it is opt-in and never silently changes an existing
 * deployment.
 *
 * @example
 * ```ts
 * import { type RateLimitConfig } from 'weft/server';
 *
 * const rateLimit: RateLimitConfig = {
 *   maxRequests: 100,
 *   windowMs: 60_000,
 * };
 * void rateLimit;
 * ```
 */
export type RateLimitConfig = {
  /** Maximum requests permitted per key within each `windowMs` window. Must be a positive integer. */
  maxRequests: number;
  /** Length of the fixed window in milliseconds. Must be positive. */
  windowMs: number;
  /**
   * Upper bound on the number of distinct keys tracked at once. When exceeded,
   * the oldest-expiring entries are evicted so a high-cardinality flood of
   * unique keys cannot grow memory without bound. Defaults to 10 000.
   */
  maxTrackedKeys?: number;
};

/**
 * Outcome of a single {@link RateLimiter.check} call.
 *
 * @example
 * ```ts
 * import { type RateLimitDecision } from 'weft/server';
 *
 * function describe(decision: RateLimitDecision): string {
 *   return decision.allowed ? 'ok' : `retry after ${decision.retryAfterSeconds}s`;
 * }
 * void describe;
 * ```
 */
export type RateLimitDecision = {
  /** Whether the request is within budget and may proceed. */
  allowed: boolean;
  /** Requests still available in the current window after this one. */
  remaining: number;
  /** Seconds until the current window resets — surfaced as the `Retry-After` header on a 429. */
  retryAfterSeconds: number;
  /** The configured per-window ceiling, surfaced as `X-RateLimit-Limit`. */
  limit: number;
};

/**
 * A request rate limiter. Call {@link RateLimiter.check} once per request with
 * a stable key (principal subject when authenticated, otherwise client
 * address). `dispose` clears the internal state and is invoked on server
 * shutdown.
 *
 * @example
 * ```ts
 * import { createRateLimiter, type RateLimiter } from 'weft/server';
 *
 * const limiter: RateLimiter = createRateLimiter({ maxRequests: 2, windowMs: 1_000 });
 * console.log(limiter.check('caller-1').allowed); // true
 * console.log(limiter.check('caller-1').allowed); // true
 * console.log(limiter.check('caller-1').allowed); // false
 * limiter.dispose();
 * ```
 */
export type RateLimiter = {
  check(key: string): RateLimitDecision;
  dispose(): void;
};

type WindowEntry = {
  count: number;
  /** Absolute timestamp (ms) at which the current window expires. */
  resetAt: number;
};

const DEFAULT_MAX_TRACKED_KEYS = 10_000;

/**
 * Validate a {@link RateLimitConfig}, throwing on invalid values so a
 * misconfiguration fails fast at `serve()` time rather than admitting an
 * accidentally-unlimited or always-zero limiter.
 *
 * @example
 * ```ts
 * import { validateRateLimitConfig } from 'weft/server';
 *
 * validateRateLimitConfig({ maxRequests: 100, windowMs: 60_000 });
 * console.log('config is valid');
 * ```
 */
export function validateRateLimitConfig(config: RateLimitConfig): void {
  if (!Number.isInteger(config.maxRequests) || config.maxRequests <= 0) {
    throw new Error('rateLimit.maxRequests must be a positive integer');
  }
  if (!Number.isFinite(config.windowMs) || config.windowMs <= 0) {
    throw new Error('rateLimit.windowMs must be a positive number');
  }
  if (
    config.maxTrackedKeys !== undefined &&
    (!Number.isInteger(config.maxTrackedKeys) || config.maxTrackedKeys <= 0)
  ) {
    throw new Error('rateLimit.maxTrackedKeys must be a positive integer when set');
  }
}

/**
 * Create a fixed-window {@link RateLimiter}. The optional `now` clock is for
 * deterministic testing; production callers omit it and the limiter reads
 * `Date.now()`.
 *
 * @example
 * ```ts
 * import { createRateLimiter } from 'weft/server';
 *
 * let clock = 0;
 * const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1_000 }, () => clock);
 * console.log(limiter.check('a').allowed); // true
 * console.log(limiter.check('a').allowed); // false — window not yet reset
 * clock = 1_000;
 * console.log(limiter.check('a').allowed); // true — window rolled over
 * ```
 */
export function createRateLimiter(
  config: RateLimitConfig,
  now: () => number = Date.now,
): RateLimiter {
  validateRateLimitConfig(config);
  const maxTrackedKeys = config.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  const windows = new Map<string, WindowEntry>();

  function evictIfOverCapacity(): void {
    if (windows.size <= maxTrackedKeys) return;
    // Map iteration order is insertion order. Re-inserting on each window roll
    // (delete + set below) keeps the most recently active keys at the tail, so
    // evicting from the head sheds the keys idle longest first.
    const overflow = windows.size - maxTrackedKeys;
    let removed = 0;
    for (const key of windows.keys()) {
      windows.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  return {
    check(key: string): RateLimitDecision {
      const currentTime = now();
      const existing = windows.get(key);

      if (existing === undefined || currentTime >= existing.resetAt) {
        // Fresh window. Re-insert (delete first when rolling over) so the key
        // moves to the Map tail for LRU-style eviction ordering.
        if (existing !== undefined) windows.delete(key);
        const resetAt = currentTime + config.windowMs;
        windows.set(key, { count: 1, resetAt });
        evictIfOverCapacity();
        return {
          allowed: true,
          remaining: config.maxRequests - 1,
          retryAfterSeconds: Math.ceil(config.windowMs / 1_000),
          limit: config.maxRequests,
        };
      }

      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - currentTime) / 1_000));
      if (existing.count >= config.maxRequests) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds,
          limit: config.maxRequests,
        };
      }

      existing.count += 1;
      return {
        allowed: true,
        remaining: config.maxRequests - existing.count,
        retryAfterSeconds,
        limit: config.maxRequests,
      };
    },
    dispose(): void {
      windows.clear();
    },
  };
}
