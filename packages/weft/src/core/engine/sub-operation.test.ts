import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { processStateCommitOperation } from './operations-state.ts';
import { executeSubOperation, processWaitReviewOperation } from './sub-operation.ts';

function createSubOperationCallbacks() {
  return {
    createActivityOperationCallbacks: () => ({}) as never,
    createChildWorkflowOperationCallbacks: () => ({}) as never,
    createCoordinationOperationCallbacks: () => ({}) as never,
    createStateOperationCallbacks: () => ({
      ensureTerminalCleanupTracked: mock(async () => {}),
      runOperationWithResult: mock(async () => {}),
    }),
  };
}

describe('engine sub-operations', () => {
  it('commits execution-scoped state deletes through the operation callback path', async () => {
    const storage = new MemoryStorage();
    const results: unknown[] = [];
    const ensureTerminalCleanupTracked = mock(async () => {});
    const callbacks = {
      ensureTerminalCleanupTracked,
      runOperationWithResult: mock(async (_workflowId, _operation, execute) => {
        results.push(await execute());
      }),
    };
    const scope = { ownerWorkflowId: 'workflow-state-owner', type: 'execution' } as const;

    await processStateCommitOperation(
      { storage } as never,
      'workflow-state-owner',
      {
        expectedVersion: 0,
        key: 'counter',
        mode: 'set',
        operationId: 'state-commit:set',
        scope,
        type: 'state-commit',
        value: 2,
      },
      callbacks,
    );
    await processStateCommitOperation(
      { storage } as never,
      'workflow-state-owner',
      {
        expectedVersion: 1,
        key: 'counter',
        mode: 'delete',
        operationId: 'state-commit:delete',
        scope,
        type: 'state-commit',
      },
      callbacks,
    );

    expect(results).toEqual([
      { applied: true, value: 2, version: 1 },
      { applied: true, value: undefined, version: 2 },
    ]);
    expect(ensureTerminalCleanupTracked).toHaveBeenCalledTimes(2);
    expect(ensureTerminalCleanupTracked).toHaveBeenLastCalledWith('workflow-state-owner');
  });

  it('processes wait-review operations through the review callback', async () => {
    const processReviewOperation = mock(async () => {});
    const runOperationWithoutResult = mock(async (_workflowId, _operation, execute) => execute());

    await processWaitReviewOperation(
      {} as never,
      'workflow-review',
      {
        operationId: 'review:1',
        reviewOptions: { artifact: { type: 'text', value: 'hello' }, reviewers: ['human'] },
        type: 'wait-review',
      },
      { processReviewOperation, runOperationWithoutResult },
    );

    expect(processReviewOperation).toHaveBeenCalledWith('workflow-review', {
      artifact: { type: 'text', value: 'hello' },
      reviewers: ['human'],
    });
  });

  it('reads and commits execution-scoped atomic state sub-operations', async () => {
    const callbacks = createSubOperationCallbacks();
    const storage = new MemoryStorage();
    const internals = {
      options: { maxNestingDepth: 10 },
      storage,
      workflowNestingDepths: new Map(),
    };
    const scope = { ownerWorkflowId: 'workflow-state-owner', type: 'execution' } as const;

    const initialSnapshot = await executeSubOperation(
      internals as never,
      'workflow-state-owner',
      {
        initial: 1,
        key: 'counter',
        operationId: 'state-read:1',
        scope,
        type: 'state-read',
      },
      callbacks,
    );
    expect(initialSnapshot).toEqual({ value: 1, version: 0 });

    const setResult = await executeSubOperation(
      internals as never,
      'workflow-state-owner',
      {
        expectedVersion: 0,
        key: 'counter',
        mode: 'set',
        operationId: 'state-commit:1',
        scope,
        type: 'state-commit',
        value: 2,
      },
      callbacks,
    );
    expect(setResult).toEqual({ applied: true, value: 2, version: 1 });
    expect(
      callbacks.createStateOperationCallbacks().ensureTerminalCleanupTracked,
    ).toHaveBeenCalledTimes(0);

    const deleteCallbacks = {
      ...callbacks,
      createStateOperationCallbacks: () => ({
        ensureTerminalCleanupTracked: mock(async () => {}),
        runOperationWithResult: mock(async () => {}),
      }),
    };
    const stateCallbacks = deleteCallbacks.createStateOperationCallbacks();
    deleteCallbacks.createStateOperationCallbacks = () => stateCallbacks;

    const deleteResult = await executeSubOperation(
      internals as never,
      'workflow-state-owner',
      {
        expectedVersion: 1,
        key: 'counter',
        mode: 'delete',
        operationId: 'state-commit:2',
        scope,
        type: 'state-commit',
      },
      deleteCallbacks,
    );

    expect(deleteResult).toEqual({ applied: true, value: undefined, version: 2 });
    expect(stateCallbacks.ensureTerminalCleanupTracked).toHaveBeenCalledWith(
      'workflow-state-owner',
    );
  });

  it('runs nested parallel and race sub-operations', async () => {
    const callbacks = createSubOperationCallbacks();
    const internals = {
      options: { maxNestingDepth: 10 },
      storage: new MemoryStorage(),
      workflowNestingDepths: new Map(),
    };

    await expect(
      executeSubOperation(
        internals as never,
        'workflow-sub-operation',
        {
          operationId: 'parallel:1',
          operations: [
            { fn: () => 'first', key: 'first', operationId: 'memo:1', type: 'memo' },
            { fn: () => 'second', key: 'second', operationId: 'memo:2', type: 'memo' },
          ],
          step: 0,
          type: 'parallel',
        },
        callbacks as never,
      ),
    ).resolves.toEqual(['first', 'second']);

    await expect(
      executeSubOperation(
        internals as never,
        'workflow-sub-operation',
        {
          operationId: 'race:1',
          operations: [
            { fn: () => 'winner', key: 'winner', operationId: 'memo:3', type: 'memo' },
            { fn: () => 'other', key: 'other', operationId: 'memo:4', type: 'memo' },
          ],
          type: 'race',
        },
        callbacks as never,
      ),
    ).resolves.toBe('winner');
  });

  it('propagates outer aborts into nested race controllers while work is pending', async () => {
    const outerController = new AbortController();
    let finishActivity!: (value: string) => void;
    const activityPromise = new Promise<string>((resolve) => {
      finishActivity = resolve;
    });
    const callbacks = {
      ...createSubOperationCallbacks(),
      createActivityOperationCallbacks: () => ({
        getComposedActivityInterceptor: () => null,
        getComposedWorkflowInterceptor: () => null,
        finalizePendingTimelineEntry: () => {},
        feedOperationResult: () => {},
        runOperationWithResult: mock(async () => {}),
      }),
    };
    const internals = {
      activityRegistry: { resolve: () => undefined },
      activityRegistriesByWorkflow: new Map(),
      activityWorkerDispatcher: null,
      heartbeatDetails: new Map(),
      lastHeartbeatDetailsByStep: new Map(),
      inlineStrategy: null,
      options: { maxNestingDepth: 10, payloadSizePolicy: { maxBytes: null } },
      storage: new MemoryStorage(),
      workflowNestingDepths: new Map(),
      workflowTypeByWorkflowId: new Map(),
    };

    const racePromise = executeSubOperation(
      internals as never,
      'workflow-race-abort',
      {
        operationId: 'race:abort',
        operations: [
          {
            activityName: 'slow',
            fn: () => activityPromise,
            input: null,
            operationId: 'activity:slow',
            type: 'activity',
          },
        ],
        type: 'race',
      },
      callbacks,
      outerController.signal,
    );

    await Promise.resolve();
    outerController.abort('outer stopped');
    finishActivity('finished');

    await expect(racePromise).resolves.toBe('finished');
  });

  it('rejects unsupported sub-operation types', async () => {
    await expect(
      executeSubOperation(
        { options: { maxNestingDepth: 10 }, workflowNestingDepths: new Map() } as never,
        'workflow-sub-operation',
        { operationId: 'unknown:1', type: 'unknown' } as never,
        createSubOperationCallbacks() as never,
      ),
    ).rejects.toThrow('Unsupported sub-operation type: unknown');
  });
});
