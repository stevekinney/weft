/**
 * #494: `ActivityCallOptions.timeout` — an INLINE per-attempt wall-clock cap.
 *
 * Unlike `scheduleToCloseTimeout` (a cross-attempt budget enforced at the retry
 * boundary), `timeout` bounds a single attempt's wall clock and is measured fresh
 * on every attempt. When it fires, the workflow stops awaiting the attempt and the
 * activity's `AbortSignal` is aborted so a cooperating activity can stop — but Weft
 * cannot forcibly preempt the activity function, so a non-cooperating activity
 * keeps running in the background. The timed-out attempt is retried (with a fresh
 * cap) when a retry policy permits. Enforcement is inline-only; worker-mode
 * per-attempt bounds are governed by `visibilityTimeout`.
 */
import { describe, expect, it } from 'bun:test';

import {
  ActivityPerAttemptTimeoutError,
  parsePerAttemptTimeoutMs,
} from '../context/activity-schedule-to-close.ts';
import { isActivityCallOptions } from '../context/session-state.ts';
import { classifyErrorAsFailureCategory } from '../failure-categories.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

/** A promise that never settles, so the per-attempt timer is the only way out. */
function hangForever(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    // Honor abort so the dangling promise is cleaned up when the test ends, but
    // only AFTER the deadline has already rejected the awaiting workflow — this
    // models a NON-cooperating-then-cleanup activity, not a cooperating one.
    signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

describe('#494 per-attempt timeout', () => {
  it('treats `timeout` as a call option only alongside another discriminator key', () => {
    // `timeout` is a valid ActivityCallOptions key but deliberately NOT a
    // standalone discriminator (a bare `{ timeout }` is ambiguous with input data).
    // It is recognized once paired with an unambiguous discriminator like `queue`.
    expect(isActivityCallOptions({ timeout: '5s' })).toBe(false);
    expect(isActivityCallOptions({ timeout: '5s', queue: 'gpu' })).toBe(true);
  });

  it('fails a hung inline attempt with ActivityPerAttemptTimeoutError once the cap elapses', async () => {
    await using engine = new Engine();

    const hangs = activity({
      name: 'hangs',
      timeout: 20,
      execute: async (_input?: unknown, ctx?: ActivityContext) => hangForever(ctx?.signal),
    });

    engine.register(
      workflow({ name: 'per-attempt-wf' })
        .activities({ hangs })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(hangs);
        }),
    );

    const handle = await engine.start('per-attempt-wf', null, { id: 'pat-1' });
    await expect(handle.result()).rejects.toThrow(
      'attempt 1 exceeded its per-attempt timeout of 20ms',
    );
    const failed = await engine.get('pat-1');
    expect(failed?.status).toBe('failed');
  });

  it('lets an attempt that completes before the cap succeed normally', async () => {
    await using engine = new Engine();

    const quick = activity({
      name: 'quick',
      timeout: 1000,
      execute: async () => 'done',
    });

    engine.register(
      workflow({ name: 'quick-wf' })
        .activities({ quick })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(quick);
        }),
    );

    const handle = await engine.start('quick-wf', null, { id: 'quick-1' });
    await expect(handle.result()).resolves.toBe('done');
  });

  it('aborts the activity AbortSignal when the per-attempt cap fires', async () => {
    await using engine = new Engine();
    let signalAborted = false;

    const watches = activity({
      name: 'watches',
      timeout: 20,
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        ctx?.signal.addEventListener('abort', () => {
          signalAborted = true;
        });
        return hangForever(ctx?.signal);
      },
    });

    engine.register(
      workflow({ name: 'abort-wf' })
        .activities({ watches })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(watches);
        }),
    );

    const handle = await engine.start('abort-wf', null, { id: 'abort-1' });
    // The error crosses the durable boundary as a message string (the class is not
    // reconstructed), so assert on the message — the failure-category test below
    // pins the class + classification directly.
    await expect(handle.result()).rejects.toThrow('exceeded its per-attempt timeout of 20ms');
    // The deadline fired the per-attempt AbortController, so the activity's composite
    // signal saw the abort — a cooperating activity could have stopped on it.
    expect(signalAborted).toBe(true);
  });

  it('lets a cooperating activity stop promptly on the aborted signal', async () => {
    await using engine = new Engine();

    const cooperates = activity({
      name: 'cooperates',
      timeout: 20,
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        // Resolve as soon as the signal aborts — a well-behaved long-running
        // activity that honors cancellation.
        await new Promise<void>((resolve) => {
          if (ctx?.signal.aborted) return resolve();
          ctx?.signal.addEventListener('abort', () => resolve());
        });
        return 'stopped-cooperatively';
      },
    });

    engine.register(
      workflow({ name: 'coop-wf' })
        .activities({ cooperates })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(cooperates);
        }),
    );

    const handle = await engine.start('coop-wf', null, { id: 'coop-1' });
    // The workflow still fails with the per-attempt timeout (the deadline already
    // rejected the awaited result), even though the activity itself stopped — the
    // cooperative stop frees resources but does not retroactively succeed the run.
    await expect(handle.result()).rejects.toThrow('exceeded its per-attempt timeout of 20ms');
  });

  it('retries a timed-out attempt with a fresh cap when a retry policy permits', async () => {
    await using engine = new Engine();
    let attempts = 0;

    const flakyThenFast = activity({
      name: 'flakyThenFast',
      timeout: 20,
      retry: { maxAttempts: 3, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        attempts += 1;
        if (attempts === 1) return hangForever(ctx?.signal); // first attempt overruns the cap
        return 'recovered';
      },
    });

    engine.register(
      workflow({ name: 'retry-cap-wf' })
        .activities({ flakyThenFast })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(flakyThenFast);
        }),
    );

    const handle = await engine.start('retry-cap-wf', null, { id: 'retry-cap-1' });
    await expect(handle.result()).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('classifies the per-attempt timeout error as a timeout failure category', () => {
    const error = new ActivityPerAttemptTimeoutError('hangs', 2, 1000);
    expect(classifyErrorAsFailureCategory(error)).toBe('timeout');
    expect(error.activityName).toBe('hangs');
    expect(error.attempt).toBe(2);
    expect(error.timeoutMs).toBe(1000);
  });

  describe('parsePerAttemptTimeoutMs', () => {
    it('returns undefined when unset', () => {
      expect(parsePerAttemptTimeoutMs(undefined)).toBeUndefined();
    });

    it('parses a numeric duration', () => {
      expect(parsePerAttemptTimeoutMs(500)).toBe(500);
    });

    it('parses a duration string', () => {
      expect(parsePerAttemptTimeoutMs('2s')).toBe(2000);
    });

    it('rejects a zero cap as meaningless', () => {
      expect(() => parsePerAttemptTimeoutMs(0)).toThrow('must be greater than 0ms');
    });

    it('rejects a negative cap (via duration validation)', () => {
      // `parseDuration` rejects negatives before the `<= 0` guard is reached.
      expect(() => parsePerAttemptTimeoutMs(-1)).toThrow(
        'Duration must resolve to a finite, non-negative number of milliseconds',
      );
    });

    it('rejects a non-number / non-string value (hostile input)', () => {
      expect(() => parsePerAttemptTimeoutMs({})).toThrow('must be a number or duration string');
      expect(() => parsePerAttemptTimeoutMs(true)).toThrow('must be a number or duration string');
    });
  });
});
