import { describe, expect, it } from 'bun:test';

import { createCheckpoint } from '../checkpoint.ts';
import type { EngineInternals } from './internals.ts';
import {
  feedOperationResult,
  feedWorkflowResult,
  getComposedActivityInterceptor,
  swallowPromiseRejection,
} from './strategy-helpers.ts';

function minimalEngineInternals(overrides: Record<string, unknown>): EngineInternals {
  return overrides as unknown as EngineInternals;
}

describe('strategy helpers', () => {
  function fencedInternals(mode: 'inline' | 'worker', operationId = 'current-operation') {
    const delivered: unknown[] = [];
    const internals = minimalEngineInternals({
      durableInlineOperations: new Map([
        ['workflow', { operationId, type: 'wait-signal', workflowExecutionToken: 'current-run' }],
      ]),
      checkpoints: new Map(),
      inlineStrategy:
        mode === 'inline'
          ? {
              continueWorkflow: (...args: unknown[]) => delivered.push(['success', ...args]),
              throwIntoWorkflow: (...args: unknown[]) => delivered.push(['failure', ...args]),
            }
          : null,
      strategy: {
        resumeWorkflow: (parameters: unknown) => delivered.push(['resume', parameters]),
      },
    });
    return { delivered, internals };
  }

  it('returns the cached composed activity interceptor when already computed', () => {
    const internals = {
      interceptors: [{}],
      composedActivityInterceptor: null,
    } as EngineInternals;

    expect(getComposedActivityInterceptor(internals)).toBeNull();
  });

  it('treats an absent promise as a no-op rejection sink', async () => {
    expect(await swallowPromiseRejection(undefined)).toBeUndefined();
  });

  it('resumes worker strategy execution with the latest checkpoint bytes', () => {
    const resumed: unknown[] = [];
    const internals = minimalEngineInternals({
      checkpoints: new Map([
        ['workflow-worker-result', createCheckpoint('workflow-worker-result', '1', 1_000)],
      ]),
      durableInlineOperations: new Map([
        ['workflow-worker-result', { operationId: 'op-worker', type: 'activity' }],
      ]),
      inlineStrategy: null,
      strategy: {
        resumeWorkflow: (message: unknown) => {
          resumed.push(message);
        },
      },
    });

    feedOperationResult(
      internals,
      'workflow-worker-result',
      {
        status: 'completed',
        value: 'done',
      },
      undefined,
      'op-worker',
      undefined,
    );

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
      durableInlineOperations: new Map([
        ['workflow-inline-result', { operationId: 'op-inline', type: 'activity' }],
      ]),
      inlineStrategy: {
        continueWorkflow: () => {
          throw new Error('continueWorkflow should not be called for failed outcomes');
        },
        throwIntoWorkflow: (...parameters: unknown[]) => {
          thrown.push(parameters);
        },
      },
    });

    feedOperationResult(
      internals,
      'workflow-inline-result',
      {
        status: 'failed',
        error: 'review timed out',
        errorName: 'ReviewTimeoutError',
        failureCategory: 'timeout',
      },
      undefined,
      'op-inline',
      undefined,
    );

    expect(thrown).toEqual([
      [
        'workflow-inline-result',
        expect.objectContaining({ message: 'review timed out', name: 'ReviewTimeoutError' }),
        'timeout',
      ],
    ]);
  });

  it('feeds workflow results through inline and worker strategy boundaries', () => {
    const inlineDelivered: unknown[] = [];
    const inlineInternals = minimalEngineInternals({
      inlineStrategy: {
        continueWorkflow: (...parameters: unknown[]) =>
          inlineDelivered.push(['success', ...parameters]),
        throwIntoWorkflow: (...parameters: unknown[]) =>
          inlineDelivered.push(['failure', ...parameters]),
      },
      checkpoints: new Map(),
    });
    feedWorkflowResult(inlineInternals, 'workflow-inline', { status: 'completed', value: 'done' });
    feedWorkflowResult(inlineInternals, 'workflow-inline', {
      status: 'failed',
      error: 'failed',
      failureCategory: 'application',
    });
    expect(inlineDelivered).toHaveLength(2);

    const resumed: unknown[] = [];
    const workerInternals = minimalEngineInternals({
      inlineStrategy: null,
      checkpoints: new Map(),
      strategy: { resumeWorkflow: (parameters: unknown) => resumed.push(parameters) },
    });
    feedWorkflowResult(workerInternals, 'workflow-worker', { status: 'completed', value: 'done' });
    feedWorkflowResult(workerInternals, 'workflow-worker', {
      status: 'failed',
      error: 'failed',
      failureCategory: 'application',
    });
    expect(resumed).toHaveLength(2);
  });

  for (const mode of ['inline', 'worker'] as const) {
    it(`drops stale success and failure results in ${mode} mode, including the original reason`, () => {
      const { delivered, internals } = fencedInternals(mode);
      feedOperationResult(
        internals,
        'workflow',
        { status: 'completed', value: 'stale-success' },
        undefined,
        'old-operation',
        'old-run',
      );
      feedOperationResult(
        internals,
        'workflow',
        { status: 'failed', error: 'stale-failure', failureCategory: 'application' },
        { value: new Error('stale-failure') },
        'current-operation',
        'old-run',
      );
      expect(delivered).toEqual([]);
    });

    it(`delivers the current activity completion unchanged in ${mode} mode`, () => {
      const { delivered, internals } = fencedInternals(mode, 'activity-operation');
      feedOperationResult(
        internals,
        'workflow',
        { status: 'completed', value: 'activity-result' },
        undefined,
        'activity-operation',
        'current-run',
      );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toEqual(
        mode === 'inline'
          ? ['success', 'workflow', 'activity-result']
          : [
              'resume',
              expect.objectContaining({
                workflowId: 'workflow',
                operationResult: { status: 'completed', value: 'activity-result' },
              }),
            ],
      );
    });
  }

  it('fences the three wait-signal replacement points at shared result routing', () => {
    const { delivered, internals } = fencedInternals('inline', 'replacement-operation');
    for (const scenario of ['pre-registration scan', 'replaced waiter', 'delivered replacement']) {
      feedOperationResult(
        internals,
        'workflow',
        { status: 'failed', error: `${scenario} failure`, failureCategory: 'application' },
        { value: new Error(`${scenario} failure`) },
        'replacement-operation',
        'old-run',
      );
    }
    expect(delivered).toEqual([]);
  });
});
