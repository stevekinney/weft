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

  it('throws ActivityScheduleToCloseTimeoutError at the retry boundary once the budget is exhausted', () => {
    let now = 1_000_000;
    const context = createContext({ getNow: () => now });

    const generator = runActivityWithRetry(context, ACTIVITY_DEF(1000), ['payload']);
    generator.next(); // first dispatch at t=1_000_000

    // Fail the first attempt; the retry sleep is yielded.
    now += 2000; // jump past the 1000ms budget
    generator.throw(new Error('retryable failure'));

    // Replay the (cached/past-due) backoff sleep, then the top-of-loop budget check
    // must fire before dispatching attempt 2.
    expect(() => generator.next()).toThrow(ActivityScheduleToCloseTimeoutError);
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
