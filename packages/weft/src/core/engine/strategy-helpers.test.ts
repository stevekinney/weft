import { describe, expect, it } from 'bun:test';

import { createCheckpoint } from '../checkpoint.ts';
import type { EngineInternals } from './internals.ts';
import {
  feedOperationResult,
  getComposedActivityInterceptor,
  swallowPromiseRejection,
} from './strategy-helpers.ts';

function minimalEngineInternals(overrides: Record<string, unknown>): EngineInternals {
  return overrides as unknown as EngineInternals;
}

describe('strategy helpers', () => {
  it('returns the cached composed activity interceptor when already computed', () => {
    const internals = {
      interceptors: [{}],
      composedActivityInterceptor: null,
    } as EngineInternals;

    expect(getComposedActivityInterceptor(internals)).toBeNull();
  });

  it('treats an absent promise as a no-op rejection sink', async () => {
    await expect(swallowPromiseRejection(undefined)).resolves.toBeUndefined();
  });

  it('resumes worker strategy execution with the latest checkpoint bytes', () => {
    const resumed: unknown[] = [];
    const internals = minimalEngineInternals({
      checkpoints: new Map([
        ['workflow-worker-result', createCheckpoint('workflow-worker-result', '1', 1_000)],
      ]),
      inlineStrategy: null,
      strategy: {
        resumeWorkflow: (message: unknown) => {
          resumed.push(message);
        },
      },
    });

    feedOperationResult(internals, 'workflow-worker-result', {
      status: 'completed',
      value: 'done',
    });

    expect(resumed).toEqual([
      expect.objectContaining({
        operationResult: { status: 'completed', value: 'done' },
        workflowId: 'workflow-worker-result',
      }),
    ]);
  });

  it('passes failed operation categories into the inline throw boundary', () => {
    const thrown: unknown[] = [];
    const internals = minimalEngineInternals({
      checkpoints: new Map(),
      inlineStrategy: {
        continueWorkflow: () => {
          throw new Error('continueWorkflow should not be called for failed outcomes');
        },
        throwIntoWorkflow: (...parameters: unknown[]) => {
          thrown.push(parameters);
        },
      },
    });

    feedOperationResult(internals, 'workflow-inline-result', {
      status: 'failed',
      error: 'review timed out',
      errorName: 'ReviewTimeoutError',
      failureCategory: 'timeout',
    });

    expect(thrown).toEqual([
      [
        'workflow-inline-result',
        expect.objectContaining({ message: 'review timed out', name: 'ReviewTimeoutError' }),
        'timeout',
      ],
    ]);
  });
});
