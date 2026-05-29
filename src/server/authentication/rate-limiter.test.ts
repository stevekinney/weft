import { describe, expect, it } from 'bun:test';

import { createRateLimiter, validateRateLimitConfig } from './rate-limiter.ts';

describe('createRateLimiter', () => {
  it('allows requests up to the limit then rejects the flood', () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxRequests: 3, windowMs: 1_000 }, () => clock);

    expect(limiter.check('caller').allowed).toBe(true);
    expect(limiter.check('caller').allowed).toBe(true);
    expect(limiter.check('caller').allowed).toBe(true);

    const flooded = limiter.check('caller');
    expect(flooded.allowed).toBe(false);
    expect(flooded.remaining).toBe(0);
    expect(flooded.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(flooded.limit).toBe(3);
  });

  it('rate-limits a sustained flood from one key', () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxRequests: 10, windowMs: 60_000 }, () => clock);

    let rejected = 0;
    for (let i = 0; i < 100; i++) {
      if (!limiter.check('flooder').allowed) rejected += 1;
    }
    // 10 allowed, the remaining 90 rejected.
    expect(rejected).toBe(90);
  });

  it('tracks keys independently', () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1_000 }, () => clock);

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(false);
  });

  it('resets the window once windowMs has elapsed', () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1_000 }, () => clock);

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);

    clock = 1_000;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('reports decreasing remaining budget', () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxRequests: 3, windowMs: 1_000 }, () => clock);
    expect(limiter.check('a').remaining).toBe(2);
    expect(limiter.check('a').remaining).toBe(1);
    expect(limiter.check('a').remaining).toBe(0);
  });

  it('evicts the oldest keys past maxTrackedKeys', () => {
    let clock = 0;
    const limiter = createRateLimiter(
      { maxRequests: 1, windowMs: 1_000_000, maxTrackedKeys: 2 },
      () => clock,
    );

    limiter.check('a'); // counts 'a'
    clock = 1;
    limiter.check('b'); // counts 'b'
    clock = 2;
    limiter.check('c'); // exceeds capacity (3 > 2) → evicts 'a' (oldest)

    // 'c' and 'b' remain tracked and over budget.
    expect(limiter.check('c').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(false);
    // 'a' was evicted, so its window is forgotten and it is allowed afresh.
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('clears all state on dispose', () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1_000 }, () => clock);
    limiter.check('a');
    expect(limiter.check('a').allowed).toBe(false);
    limiter.dispose();
    expect(limiter.check('a').allowed).toBe(true);
  });
});

describe('validateRateLimitConfig', () => {
  it('rejects non-positive maxRequests', () => {
    expect(() => validateRateLimitConfig({ maxRequests: 0, windowMs: 1_000 })).toThrow();
    expect(() => validateRateLimitConfig({ maxRequests: -1, windowMs: 1_000 })).toThrow();
    expect(() => validateRateLimitConfig({ maxRequests: 1.5, windowMs: 1_000 })).toThrow();
  });

  it('rejects non-positive windowMs', () => {
    expect(() => validateRateLimitConfig({ maxRequests: 1, windowMs: 0 })).toThrow();
    expect(() => validateRateLimitConfig({ maxRequests: 1, windowMs: -5 })).toThrow();
  });

  it('rejects invalid maxTrackedKeys', () => {
    expect(() =>
      validateRateLimitConfig({ maxRequests: 1, windowMs: 1_000, maxTrackedKeys: 0 }),
    ).toThrow();
  });

  it('accepts a valid config', () => {
    expect(() => validateRateLimitConfig({ maxRequests: 100, windowMs: 60_000 })).not.toThrow();
  });
});
