import { describe, expect, it } from 'bun:test';

import { Context } from '../context.ts';
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
