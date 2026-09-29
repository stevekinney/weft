import { describe, expect, it, mock } from 'bun:test';

import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import type { ContextOperationRequest } from '../context.ts';
import {
  processOperation,
  runOperationWithResult,
  runOperationWithoutResult,
  translateOperationRequest,
  type OperationRouterCallbacks,
} from './operations-router.ts';

function createRouterCallbacks(): OperationRouterCallbacks {
  return {
    processActivityOperation: mock(async () => {}),
    processSleepOperation: mock(async () => {}),
    processWaitSignalOperation: mock(async () => {}),
    processWaitUpdateOperation: mock(async () => {}),
    processWaitConditionOperation: mock(async () => {}),
    processGetVersionOperation: mock(async () => {}),
    processParallelOperation: mock(async () => {}),
    processRaceOperation: mock(async () => {}),
    processMemoOperation: mock(async () => {}),
    processChildWorkflowOperation: mock(async () => {}),
    processOffloadOperation: mock(async () => {}),
    processLoadOperation: mock(async () => {}),
    processArchiveOperation: mock(async () => {}),
    processStateReadOperation: mock(async () => {}),
    processStateCommitOperation: mock(async () => {}),
    processRunAllOperation: mock(async () => {}),
    processSpeculateOperation: mock(async () => {}),
    processStreamOperation: mock(async () => {}),
    processWaitReviewOperation: mock(async () => {}),
    finalizePendingTimelineEntry: mock(() => {}),
    feedOperationResult: mock(() => {}),
  };
}

function createRouterInternals(workflowId: string, operationId: string) {
  return {
    checkpoints: new Map(),
    durableInlineOperations: new Map([[workflowId, { operationId, type: 'activity' }]]),
  } as never;
}

describe('operations router', () => {
  it('rejects operation requests that are not object-like', () => {
    expect(() => translateOperationRequest({} as never, null)).toThrow(
      'Invalid operation request received from execution strategy',
    );
  });

  it('returns inline context operation requests unchanged', () => {
    const operation: ContextOperationRequest = {
      type: 'memo',
      operationId: 'memo:1',
      key: 'cached-value',
      fn: () => 42,
    };

    expect(translateOperationRequest({} as never, operation)).toBe(operation);
  });

  it('normalizes worker operation requests that use kind names', () => {
    expect(
      translateOperationRequest({} as never, {
        kind: 'signal-wait',
        id: 'wait:1',
        input: { ignored: true },
      }),
    ).toEqual(
      expect.objectContaining({
        activityName: '',
        input: { ignored: true },
        operationId: 'wait:1',
        type: 'wait-signal',
      }),
    );

    expect(
      translateOperationRequest({} as never, {
        activityName: 'fetch-user',
        input: 'user-1',
        kind: 'activity',
      }),
    ).toEqual(
      expect.objectContaining({
        activityName: 'fetch-user',
        input: 'user-1',
        type: 'activity',
      }),
    );
  });

  it('rejects operation requests without a supported discriminator', () => {
    expect(() => translateOperationRequest({} as never, { operationId: 'missing-type' })).toThrow(
      'Unsupported operation request shape received from execution strategy',
    );
  });

  it('routes unsupported operation types into failed operation outcomes', async () => {
    const callbacks = createRouterCallbacks();

    await processOperation(
      createRouterInternals('workflow-router', 'unsupported:1'),
      'workflow-router',
      {
        type: 'unknown-operation',
        operationId: 'unsupported:1',
        callerStack: 'workflow stack',
      } as never,
      callbacks,
    );

    expect(callbacks.finalizePendingTimelineEntry).toHaveBeenCalledWith(
      'workflow-router',
      'failed',
      'Unsupported operation type: unknown-operation',
    );
    expect(callbacks.feedOperationResult).toHaveBeenCalledWith(
      'workflow-router',
      {
        error: 'Unsupported operation type: unknown-operation',
        errorName: 'Error',
        failureCategory: 'application',
        status: 'failed',
      },
      expect.objectContaining({
        value: expect.any(Error),
      }),
      'unsupported:1',
      undefined,
    );
  });

  it('captures failures from operations that do not produce a result', async () => {
    const callbacks = createRouterCallbacks();

    await runOperationWithoutResult(
      createRouterInternals('workflow-without-result', 'operation:1'),
      'workflow-without-result',
      { operationId: 'operation:1', callerStack: 'workflow call site' },
      async () => {
        throw new Error('operation failed');
      },
      callbacks,
    );

    expect(callbacks.finalizePendingTimelineEntry).toHaveBeenCalledWith(
      'workflow-without-result',
      'failed',
      'operation failed',
    );
  });

  it('rejects result operations that omit their operation ID', async () => {
    expect(
      await throwingRejectionOf(
        runOperationWithResult(
          createRouterInternals('workflow-without-operation-id', 'operation:1'),
          'workflow-without-operation-id',
          {} as never,
          async () => 'finished',
          createRouterCallbacks(),
        ),
      ),
    ).toThrow('Operation result is missing its operation ID');
  });

  it('completes operations that produce a result', async () => {
    const callbacks = createRouterCallbacks();

    await runOperationWithResult(
      createRouterInternals('workflow-with-result', 'operation:2'),
      'workflow-with-result',
      { operationId: 'operation:2' },
      async () => 'finished',
      callbacks,
    );

    expect(callbacks.finalizePendingTimelineEntry).toHaveBeenCalledWith(
      'workflow-with-result',
      'completed',
      'finished',
    );
    expect(callbacks.feedOperationResult).toHaveBeenCalledWith(
      'workflow-with-result',
      { status: 'completed', value: 'finished' },
      undefined,
      'operation:2',
      undefined,
    );
  });
});
