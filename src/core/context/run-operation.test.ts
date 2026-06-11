import { describe, expect, it } from 'bun:test';

import { Context } from '../context.ts';
import { ActivityScheduleToCloseTimeoutError } from './activity-schedule-to-close.ts';
import { getInternals } from './internals.ts';
import {
  completeActivityRetryAttemptForTesting,
  createRunActivityRequest,
  readActivityRetryAttemptForTesting,
  readCompletedRetrySleepCountForTesting,
  runActivityWithRetry,
  shouldRetryActivityError,
} from './run-operation.ts';

const ACTIVITY_RETRY_STATE_LOCAL_KEY = '__weftActivityRetryState';

function createContext(overrides: Partial<ConstructorParameters<typeof Context>[0]> = {}) {
  return new Context({
    workflowId: 'wf-run-operation',
    workflowType: 'run-operation-test',
    startedAt: 1000,
    abortController: new AbortController(),
    ...overrides,
  });
}

describe('run-operation retry state', () => {
  it('rejects an invalid checkpointed retry attempt', () => {
    const context = createContext();
    getInternals(context).checkpointLocals = {
      ...getInternals(context).checkpointLocals,
      [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
        version: 1,
        attempts: { '0': 1 },
      },
    };

    expect(() => createRunActivityRequest(context, 'activity-name', ['payload'])).toThrow(
      'Invalid checkpointed activity retry attempt 1 for step 0',
    );
  });

  it('rejects an invalid checkpointed completed retry sleep count when replaying a cached result', () => {
    const context = createContext();
    context.accumulatedResults.set(0, 'cached-result');
    getInternals(context).checkpointLocals = {
      ...getInternals(context).checkpointLocals,
      [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
        version: 1,
        attempts: {},
        completedRetrySleeps: { '0': -1 },
      },
    };

    expect(() => createRunActivityRequest(context, 'activity-name', ['payload'])).toThrow(
      'Invalid checkpointed activity retry sleep count -1 for step 0',
    );
  });

  it('matches non-Error failures against nonRetryableErrors by string value', () => {
    expect(
      shouldRetryActivityError(
        'ValidationFailure',
        {
          maxAttempts: 3,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
          nonRetryableErrors: ['ValidationFailure'],
        },
        1,
      ),
    ).toBe(false);
  });

  it('throws when replay resumes at a retry attempt without a retry policy', () => {
    const context = createContext();
    getInternals(context).checkpointLocals = {
      ...getInternals(context).checkpointLocals,
      [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
        version: 1,
        attempts: { '0': 2 },
      },
    };

    const generator = runActivityWithRetry(context, 'activity-name', ['payload']);
    expect(() => generator.next()).toThrow(
      'Missing activity retry policy for checkpointed retry attempt 2',
    );
  });

  it('exposes the retry-state readers for focused corruption tests', () => {
    const context = createContext();
    const internals = getInternals(context);
    internals.checkpointLocals = {
      ...internals.checkpointLocals,
      [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
        version: 1,
        attempts: { '3': 2 },
        completedRetrySleeps: { '4': 5 },
      },
    };

    expect(readActivityRetryAttemptForTesting(internals, 3)).toBe(2);
    expect(readCompletedRetrySleepCountForTesting(internals, 4)).toBe(5);
  });

  it('rejects an invalid completed retry sleep count when finalizing retry state', () => {
    const internals = getInternals(createContext());

    expect(() => completeActivityRetryAttemptForTesting(internals, 2, 10_001)).toThrow(
      'Invalid completed activity retry sleep count 10001 for step 2',
    );
  });

  it('retries once, sleeps, then succeeds on the next attempt', () => {
    const context = createContext();
    const activity = Object.assign((_input: unknown) => 'unused', {
      retry: {
        maxAttempts: 3,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
    });

    const generator = runActivityWithRetry<string>(context, activity, ['payload']);
    const firstYield = generator.next();
    expect(firstYield.done).toBe(false);
    expect(firstYield.value).toMatchObject({
      type: 'activity',
      activityName: activity.name || 'anonymous',
    });
    expect((firstYield.value as { attempt?: number }).attempt).toBeUndefined();

    const retrySleep = generator.throw(new Error('retryable failure'));
    expect(retrySleep.done).toBe(false);
    expect(retrySleep.value).toMatchObject({ type: 'sleep' });

    const secondYield = generator.next();
    expect(secondYield.done).toBe(false);
    expect(secondYield.value).toMatchObject({
      type: 'activity',
      activityName: activity.name || 'anonymous',
      attempt: 2,
    });

    const completed = generator.next('final-result');
    expect(completed).toEqual({ done: true, value: 'final-result' });
  });
});

describe('#449 scheduleToCloseTimeout retry-state anchor', () => {
  const ACTIVITY_DEF = (scheduleToCloseTimeout: number) =>
    Object.assign((_input: unknown) => 'unused', {
      retry: { maxAttempts: 5, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '30s' },
      scheduleToCloseTimeout,
    });

  it('writes the dispatchedAt anchor on first dispatch and preserves it across a retry mutation', () => {
    let now = 1_000_000;
    const context = createContext({ getNow: () => now });
    const internals = getInternals(context);

    const generator = runActivityWithRetry(context, ACTIVITY_DEF(60_000), ['payload']);
    generator.next(); // first dispatch — writes dispatchedAt for step 0

    const afterDispatch = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY] as {
      dispatchedAt?: Record<string, number>;
    };
    expect(afterDispatch.dispatchedAt).toEqual({ '0': 1_000_000 });

    // Drive a retry: writeActivityRetryAttempt rebuilds the slot. The anchor must
    // survive (the bug class the completedRetrySleeps-preservation comment warns of).
    now += 500;
    generator.throw(new Error('retryable failure')); // -> records attempt 2 + sleeps

    const afterRetry = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY] as {
      attempts: Record<string, number>;
      dispatchedAt?: Record<string, number>;
    };
    expect(afterRetry.attempts).toEqual({ '0': 2 });
    // The anchor is UNCHANGED — measured from the original dispatch, not reset.
    expect(afterRetry.dispatchedAt).toEqual({ '0': 1_000_000 });
  });

  it('throws in the CATCH branch when the next backoff would itself carry past the budget', () => {
    // The budget covers the backoff between attempts, so when `now + nextBackoff`
    // already exceeds the deadline we refuse to schedule that doomed sleep and
    // throw at the retry decision point — `generator.throw` itself throws, before
    // a sleep is ever yielded.
    let now = 1_000_000;
    const context = createContext({ getNow: () => now });

    const generator = runActivityWithRetry(context, ACTIVITY_DEF(1000), ['payload']);
    generator.next(); // first dispatch at t=1_000_000

    // Fail the first attempt with the clock already past the budget; the catch
    // branch sees `now (1_002_000) + backoff (1000) - dispatchedAt >= 1000` and
    // throws rather than scheduling a backoff that lands well past the deadline.
    now += 2000; // jump past the 1000ms budget
    let thrown: unknown;
    try {
      generator.throw(new Error('retryable failure'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ActivityScheduleToCloseTimeoutError);
    const error = thrown as ActivityScheduleToCloseTimeoutError;
    // Actual elapsed already exceeds the budget here, so this is the GENUINELY-elapsed
    // case even though it fires in the catch branch: "exceeded" wording, no projection.
    expect(error.elapsed).toBe(2000);
    expect(error.budget).toBe(1000);
    expect(error.projectedNextDispatchElapsed).toBeUndefined();
    expect(error.message).toContain('exceeded its scheduleToCloseTimeout budget of 1000ms');
  });

  it('fails at the retry DECISION point when the next backoff would overshoot, while elapsed is still under budget', () => {
    // Codex's round-2 scenario: fail attempt 1 at elapsed 1s, budget 10s, backoff
    // 30s. The actual elapsed (1s) is well WITHIN budget, but the next retry would
    // start at 31s — past the 10s deadline. We refuse to schedule that doomed sleep
    // and fail now. The error must report the ACTUAL elapsed (1000ms), not a
    // fictional 31000ms, and surface the projected next-dispatch as the reason.
    const DECISION_DEF = Object.assign((_input: unknown) => 'unused', {
      retry: { maxAttempts: 5, initialBackoff: 30_000, backoffMultiplier: 1, maxBackoff: 30_000 },
      scheduleToCloseTimeout: 10_000,
    });
    let now = 1_000_000;
    const context = createContext({ getNow: () => now });

    const generator = runActivityWithRetry(context, DECISION_DEF, ['payload']);
    generator.next(); // first dispatch at t=1_000_000, dispatchedAt = 1_000_000

    now += 1000; // attempt 1 fails at elapsed 1000ms — still under the 10_000ms budget
    let thrown: unknown;
    try {
      generator.throw(new Error('retryable failure'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ActivityScheduleToCloseTimeoutError);
    const error = thrown as ActivityScheduleToCloseTimeoutError;
    // Actual elapsed, not the projected 31000ms.
    expect(error.elapsed).toBe(1000);
    expect(error.budget).toBe(10_000);
    // The projected next dispatch (31000ms after first dispatch) is the decider.
    expect(error.projectedNextDispatchElapsed).toBe(31_000);
    expect(error.message).toContain('will not retry within its scheduleToCloseTimeout budget');
    expect(error.message).toContain('next retry would start at 31000ms');
  });

  it('throws at the TOP of the loop when downtime during backoff pushes wall time past the budget', () => {
    // The distinct branch the catch check cannot cover: the backoff is scheduled
    // (small enough that `now + backoff` is still within budget), the workflow
    // parks on the sleep, and only THEN does wall time jump past the deadline —
    // the crash-during-backoff / long-park case. On the next dispatch, the
    // top-of-loop check fires before attempt 2 is dispatched.
    const SMALL_BACKOFF_DEF = Object.assign((_input: unknown) => 'unused', {
      retry: { maxAttempts: 5, initialBackoff: 10, backoffMultiplier: 1, maxBackoff: 10 },
      scheduleToCloseTimeout: 1000,
    });
    let now = 1_000_000;
    const context = createContext({ getNow: () => now });

    const generator = runActivityWithRetry(context, SMALL_BACKOFF_DEF, ['payload']);
    generator.next(); // first dispatch at t=1_000_000, dispatchedAt = 1_000_000

    // Fail attempt 1 with the clock unmoved: catch-branch check is `1_000_000 + 10
    // - 1_000_000 = 10 >= 1000`? No → it schedules the 10ms backoff sleep and
    // records attempt 2. `generator.throw` returns the sleep yield (does NOT throw).
    const retrySleep = generator.throw(new Error('retryable failure'));
    expect(retrySleep.done).toBe(false);
    expect(retrySleep.value).toMatchObject({ type: 'sleep' });

    // Now the park outlasts the budget (e.g. the process was down for 2s). On the
    // next dispatch the top-of-loop check fires: attempt 2 > 1 and `now -
    // dispatchedAt = 2000 >= 1000`.
    now += 2000;
    let thrown: unknown;
    try {
      generator.next();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ActivityScheduleToCloseTimeoutError);
    const error = thrown as ActivityScheduleToCloseTimeoutError;
    // Top-of-loop is always the genuinely-elapsed case: actual elapsed (2000ms)
    // reported, "exceeded" wording, and NO projection (a regression that leaked a
    // projection into this path would fail here).
    expect(error.elapsed).toBe(2000);
    expect(error.budget).toBe(1000);
    expect(error.projectedNextDispatchElapsed).toBeUndefined();
    expect(error.message).toContain('exceeded its scheduleToCloseTimeout budget of 1000ms');
  });

  it('allows exactly one attempt for a zero-budget activity, then throws at the retry boundary', () => {
    // A 0ms budget is exhausted the instant any time would be spent on a retry: the
    // activity gets its one guaranteed attempt, then `now + backoff - dispatchedAt
    // >= 0` is trivially true in the catch branch, so attempt 2 is never dispatched.
    const ZERO_BUDGET_DEF = Object.assign((_input: unknown) => 'unused', {
      retry: { maxAttempts: 5, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      scheduleToCloseTimeout: 0,
    });
    const now = 1_000_000;
    const context = createContext({ getNow: () => now });

    const generator = runActivityWithRetry(context, ZERO_BUDGET_DEF, ['payload']);
    generator.next(); // the one guaranteed attempt

    // Fail attempt 1 without advancing the clock: `now + 0 - dispatchedAt = 0 >= 0`
    // → the catch branch throws immediately. No second attempt, no sleep.
    expect(() => generator.throw(new Error('retryable failure'))).toThrow(
      ActivityScheduleToCloseTimeoutError,
    );
  });

  it('does not write a dispatchedAt anchor when no scheduleToCloseTimeout is set', () => {
    const context = createContext();
    const internals = getInternals(context);
    const activity = Object.assign((_input: unknown) => 'unused', {
      retry: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '30s' },
    });

    const generator = runActivityWithRetry(context, activity, ['payload']);
    generator.next();

    const slot = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY] as
      | { dispatchedAt?: Record<string, number> }
      | undefined;
    // No anchor written — the slot is absent entirely on a clean first dispatch.
    expect(slot?.dispatchedAt).toBeUndefined();
  });

  it('fails loudly on a corrupt (non-finite) persisted dispatchedAt anchor instead of resetting the window', () => {
    // A present-but-non-finite anchor is corrupt checkpoint data. Silently
    // re-initializing it to `now` would reset the schedule-to-close window — the
    // exact contract the anchor upholds — so the read throws instead. (An ABSENT
    // anchor is a legitimate first dispatch / old record and is NOT an error.)
    const context = createContext({ getNow: () => 1_000_000 });
    const internals = getInternals(context);
    internals.checkpointLocals = {
      ...internals.checkpointLocals,
      [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
        version: 1,
        attempts: {},
        // NaN survives a JSON-free codec round-trip as a number-typed non-finite.
        dispatchedAt: { '0': Number.NaN },
      },
    };

    // The anchor is read when the generator dispatches (resolveScheduleToCloseBudget),
    // so drive the first `next()` — that is where the corrupt anchor is rejected.
    const generator = runActivityWithRetry(context, ACTIVITY_DEF(60_000), ['payload']);
    expect(() => generator.next()).toThrow(
      'Invalid checkpointed activity dispatch anchor NaN for step 0',
    );
  });

  it('reuses an existing dispatchedAt anchor on replay instead of resetting the window', () => {
    // Replay: a fresh generator runs against checkpointLocals that already hold a
    // dispatchedAt anchor for this step (written by the original run before a
    // crash). The anchor must be READ, not overwritten — so the budget keeps
    // measuring from the original dispatch, not from the recovery clock.
    let now = 5_000_000;
    const context = createContext({ getNow: () => now });
    const internals = getInternals(context);
    internals.checkpointLocals = {
      ...internals.checkpointLocals,
      [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
        version: 1,
        attempts: {},
        dispatchedAt: { '0': 1_000_000 }, // original dispatch, long before `now`
      },
    };

    const generator = runActivityWithRetry(context, ACTIVITY_DEF(60_000), ['payload']);
    generator.next(); // first dispatch of THIS run reads the existing anchor

    const slot = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY] as {
      dispatchedAt?: Record<string, number>;
    };
    // Anchor unchanged at the original dispatch time, not reset to `now`.
    expect(slot.dispatchedAt).toEqual({ '0': 1_000_000 });
  });
});
