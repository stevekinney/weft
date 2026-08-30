/**
 * #449: `ActivityCallOptions.scheduleToCloseTimeout` — a cross-attempt wall-clock
 * budget. Unlike the per-attempt `timeout`, this budget spans all retries and the
 * backoff between them, measured from the first dispatch. When exhausted, the
 * activity fails with an `ActivityScheduleToCloseTimeoutError` (a `timeout`
 * failure category) at the retry boundary instead of starting another attempt.
 *
 * The budget is enforced only at the retry boundary, so it has no effect without
 * a retry policy, and it applies to top-level `ctx.run` retries only.
 */
import { describe, expect, it } from 'bun:test';

import { ActivityScheduleToCloseTimeoutError } from '../context/activity-schedule-to-close.ts';
import { isActivityCallOptions } from '../context/session-state.ts';
import { classifyErrorAsFailureCategory } from '../failure-categories.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

describe('#449 scheduleToCloseTimeout', () => {
  it('is recognized as an ActivityCallOptions discriminator key (standalone)', () => {
    // Without `scheduleToCloseTimeout` in DISCRIMINATOR_KEYS, a standalone
    // `{ scheduleToCloseTimeout: '5m' }` would be treated as activity input.
    expect(isActivityCallOptions({ scheduleToCloseTimeout: '5m' })).toBe(true);
  });

  it('fails with a timeout error at the retry boundary once the budget is exhausted', async () => {
    // A controllable clock: the budget is 1000ms. The first attempt happens at
    // t=0 and advances the clock past the budget before failing. With zero backoff,
    // the retry boundary blocks attempt 2 in the catch branch (`now + backoff`
    // already exceeds the deadline) — failing with the schedule-to-close error
    // rather than continuing to maxAttempts (which is 5). The dedicated unit tests
    // in run-operation.test.ts pin the catch-branch vs top-of-loop split directly.
    let now = 1_000_000;
    await using engine = new Engine({ getNow: () => now });
    let attempts = 0;

    const flaky = activity({
      name: 'flaky',
      retry: { maxAttempts: 5, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      scheduleToCloseTimeout: 1000,
      execute: async () => {
        attempts += 1;
        // Advance the clock past the 1000ms budget after the first attempt.
        now += 2000;
        throw new Error('always-fails');
      },
    });

    engine.register(
      workflow({ name: 'stc-wf' })
        .activities({ flaky })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(flaky);
        }),
    );

    const handle = await engine.start('stc-wf', null, { id: 'stc-1' });
    // The error crosses the durable boundary as a message string; assert on it.
    // (The `timeout` failure-category classification is pinned by the dedicated
    // classifyErrorAsFailureCategory unit test below.)
    await expect(handle.result()).rejects.toThrow(
      'exceeded its scheduleToCloseTimeout budget of 1000ms',
    );
    // Exactly ONE attempt ran: the retry boundary blocked attempt 2 before
    // dispatch, well short of maxAttempts: 5.
    expect(attempts).toBe(1);
    const failed = await engine.get('stc-1');
    expect(failed?.status).toBe('failed');
  });

  it('classifies the schedule-to-close error as a timeout failure category', () => {
    const error = new ActivityScheduleToCloseTimeoutError('flaky', 2000, 1000);
    expect(classifyErrorAsFailureCategory(error)).toBe('timeout');
  });

  it('has no effect when no retry policy is configured (fails on first error)', async () => {
    let now = 1_000_000;
    await using engine = new Engine({ getNow: () => now });
    let attempts = 0;

    // No retry policy. scheduleToCloseTimeout is enforced at the retry boundary,
    // so a non-retried activity simply fails on its first error — the budget never
    // engages, and the error is the activity's own, not a schedule-to-close error.
    const oneShot = activity({
      name: 'one-shot',
      scheduleToCloseTimeout: 1,
      execute: async () => {
        attempts += 1;
        now += 10_000; // way past the budget — but there is no retry boundary
        throw new Error('boom');
      },
    });

    engine.register(
      workflow({ name: 'stc-noretry-wf' })
        .activities({ 'one-shot': oneShot })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(oneShot);
        }),
    );

    const handle = await engine.start('stc-noretry-wf', null, { id: 'stc-noretry-1' });
    await expect(handle.result()).rejects.toThrow('boom');
    expect(attempts).toBe(1);
  });

  it('allows the activity to succeed within the budget', async () => {
    let now = 1_000_000;
    await using engine = new Engine({ getNow: () => now });
    let attempts = 0;

    const eventuallyOk = activity({
      name: 'eventually-ok',
      retry: { maxAttempts: 5, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      scheduleToCloseTimeout: 10_000,
      execute: async (_input?: unknown, _ctx?: ActivityContext) => {
        attempts += 1;
        now += 100; // each attempt advances 100ms, well under the 10s budget
        if (attempts < 3) throw new Error('transient');
        return `ok-after-${attempts}`;
      },
    });

    engine.register(
      workflow({ name: 'stc-ok-wf' })
        .activities({ 'eventually-ok': eventuallyOk })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(eventuallyOk);
        }),
    );

    const handle = await engine.start('stc-ok-wf', null, { id: 'stc-ok-1' });
    expect(await handle.result()).toBe('ok-after-3');
    expect(attempts).toBe(3);
  });
});
