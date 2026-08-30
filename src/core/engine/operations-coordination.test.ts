import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { createDeferredConsumeEnvelope } from './deferred-consume-envelope.ts';
import type { EngineInternals } from './internals.ts';
import {
  executeRunAllOperationResult,
  processParallelOperation,
  processRaceOperation,
  processRunAllOperation,
  processWaitSignalOperation,
} from './operations-coordination.ts';

function createWorkerModeInternals(): EngineInternals {
  return { inlineStrategy: null } as unknown as EngineInternals;
}

function createSignalInternals(storage = new MemoryStorage()): EngineInternals {
  return {
    abortController: new AbortController(),
    inlineStrategy: null,
    signalWaiters: new Map<string, () => void>(),
    signalWaitersByWorkflow: new Map(),
    conditionWaiters: new Map<string, () => void>(),
    deliveredPendingUpdateIds: new Map<string, Set<string>>(),
    pendingAtomicWorkflowCommitSideEffects: new Map(),
    storage,
  } as unknown as EngineInternals;
}

class WaiterTrackingMap extends Map<string, () => void> {
  readonly registration = Promise.withResolvers<void>();
  #resolved = false;

  override set(key: string, value: () => void) {
    if (!this.#resolved) {
      this.#resolved = true;
      this.registration.resolve();
    }
    return super.set(key, value);
  }
}

function createSequencedStorage(entriesByScan: Array<Array<[string, Uint8Array]>>) {
  let scanIndex = 0;

  return {
    async delete() {},
    scan() {
      const entries = entriesByScan[scanIndex++] ?? [];
      return (async function* () {
        for (const entry of entries) {
          yield entry;
        }
      })();
    },
  };
}

describe('partial-failure preservation worker-mode boundary', () => {
  it('rejects ctx.all partial preservation when worker mode cannot persist fulfilled slots', async () => {
    const operation: Extract<ContextOperationRequest, { type: 'parallel' }> = {
      type: 'parallel',
      operationId: 'parallel:0',
      step: 0,
      operations: [
        {
          type: 'activity',
          operationId: 'parallel:0:0',
          activityName: 'ok',
          fn: async () => 'ok',
          input: undefined,
        },
        {
          type: 'activity',
          operationId: 'parallel:0:1',
          activityName: 'fail',
          fn: async () => {
            throw new Error('boom');
          },
          input: undefined,
        },
      ],
    };

    let captured: unknown;
    await processParallelOperation(createWorkerModeInternals(), 'wf-worker-all', operation, {
      executeSubOperation: async (_workflowId, subOperation) => {
        if (subOperation.type !== 'activity') throw new Error('unexpected operation');
        if (subOperation.fn === undefined) throw new Error('missing activity function');
        return subOperation.fn(subOperation.input);
      },
      runOperationWithResult: async (_workflowId, _operation, execute) => {
        try {
          await execute();
        } catch (error) {
          captured = error;
        }
      },
    });

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain(
      'ctx.all partial-failure preservation is not supported in worker execution mode',
    );
  });

  it('does not consume a wait-signal envelope when worker-mode ctx.all is destined to throw unsupported', async () => {
    // The worker-mode "unsupported" check must run BEFORE finalizeFulfilledSlots:
    // a ctx.all whose fulfilled branch is a wait-signal envelope and whose sibling
    // failed will throw "not supported in worker execution mode". If finalize ran
    // first, it would consume (delete) the durable signal for an operation that can
    // never checkpoint — dropping the signal silently. The early assert prevents
    // any finalize from running on that doomed path.
    let finalizeRan = false;
    const operation: Extract<ContextOperationRequest, { type: 'parallel' }> = {
      type: 'parallel',
      operationId: 'parallel:0',
      step: 0,
      operations: [
        { type: 'wait-signal', operationId: 'parallel:0:0', signalName: 'won' },
        {
          type: 'activity',
          operationId: 'parallel:0:1',
          activityName: 'fail',
          fn: async () => {
            throw new Error('boom');
          },
          input: undefined,
        },
      ],
    };

    let captured: unknown;
    await processParallelOperation(createWorkerModeInternals(), 'wf-worker-envelope', operation, {
      executeSubOperation: async (_workflowId, subOperation) => {
        if (subOperation.type === 'wait-signal') {
          return createDeferredConsumeEnvelope(async () => {
            finalizeRan = true;
            return 'won-payload';
          });
        }
        if (subOperation.type !== 'activity') throw new Error('unexpected operation');
        if (subOperation.fn === undefined) throw new Error('missing activity function');
        return subOperation.fn(subOperation.input);
      },
      runOperationWithResult: async (_workflowId, _operation, execute) => {
        try {
          await execute();
        } catch (error) {
          captured = error;
        }
      },
    });

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain(
      'ctx.all partial-failure preservation is not supported in worker execution mode',
    );
    // The deferred consume never ran: the unsupported throw fired before finalize.
    expect(finalizeRan).toBe(false);
  });

  it('rejects ctx.runAll partial preservation when worker mode cannot persist fulfilled slots', async () => {
    const operation: Extract<ContextOperationRequest, { type: 'run-all' }> = {
      type: 'run-all',
      operationId: 'run-all:0',
      step: 0,
      branches: {
        ok: [async () => 'ok'],
        fail: [
          async () => {
            throw new Error('boom');
          },
        ],
      },
    };

    let captured: unknown;
    await processRunAllOperation(createWorkerModeInternals(), 'wf-worker-run-all', operation, {
      runOperationWithResult: async (_workflowId, _operation, execute) => {
        try {
          await execute();
        } catch (error) {
          captured = error;
        }
      },
    });

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain(
      'ctx.runAll partial-failure preservation is not supported in worker execution mode',
    );
  });

  it('waits for every ctx.all slot finalizer to settle before throwing a finalize error', async () => {
    // finalizeFulfilledSlots must use allSettled, not Promise.all: if one fulfilled
    // wait-signal envelope's deferred consume throws, the sibling consumes must
    // still complete before the operation rejects — a Promise.all would leave them
    // running in the background, mutating durable state for an operation that will
    // never checkpoint.
    let siblingFinalized = false;
    const operation: Extract<ContextOperationRequest, { type: 'parallel' }> = {
      type: 'parallel',
      operationId: 'parallel:0',
      step: 0,
      operations: [
        { type: 'wait-signal', operationId: 'parallel:0:0', signalName: 'boom' },
        { type: 'wait-signal', operationId: 'parallel:0:1', signalName: 'ok' },
      ],
    };

    let captured: unknown;
    await processParallelOperation(createWorkerModeInternals(), 'wf-finalize-fail', operation, {
      executeSubOperation: async (_workflowId, subOperation) =>
        subOperation.operationId === 'parallel:0:0'
          ? createDeferredConsumeEnvelope(async () => {
              throw new Error('consume exploded');
            })
          : createDeferredConsumeEnvelope(async () => {
              siblingFinalized = true;
              return 'ok';
            }),
      runOperationWithResult: async (_workflowId, _operation, execute) => {
        try {
          await execute();
        } catch (error) {
          captured = error;
        }
      },
    });

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('consume exploded');
    // The sibling finalizer ran to completion before the operation rejected.
    expect(siblingFinalized).toBe(true);
  });

  it("records a ctx.race winner's deferred-consume failure in branch timeline metadata", async () => {
    const workflowId = 'wf-race-finalize-fail';
    const timelineEntry = {
      step: 0,
      operationType: 'race',
      operationLabel: 'race',
      inputSummary: '{"operationCount":2}',
      timestamp: 1,
      status: 'running' as const,
    };
    const internals = {
      ...createWorkerModeInternals(),
      pendingTimelineEntries: new Map([[workflowId, { startedAt: 1, entry: timelineEntry }]]),
    } as EngineInternals;
    const operation: Extract<ContextOperationRequest, { type: 'race' }> = {
      type: 'race',
      operationId: 'race:0',
      operations: [
        { type: 'wait-signal', operationId: 'race:0:0', signalName: 'ready' },
        {
          type: 'activity',
          operationId: 'race:0:1',
          activityName: 'slow-loser',
          fn: async () => undefined,
          input: undefined,
        },
      ],
    };

    let captured: unknown;
    await processRaceOperation(internals, workflowId, operation, {
      executeSubOperation: async (_workflowId, subOperation, signal) => {
        if (subOperation.operationId === 'race:0:0') {
          return createDeferredConsumeEnvelope(async () => {
            throw new Error('consume exploded');
          });
        }
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      runOperationWithResult: async (_workflowId, _operation, execute) => {
        try {
          await execute();
        } catch (error) {
          captured = error;
        }
      },
    });

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('consume exploded');
    expect(timelineEntry).toMatchObject({
      branches: [
        {
          index: 0,
          operationId: 'race:0:0',
          operationType: 'wait-signal',
          operationLabel: 'ready',
          outcome: 'won',
          errorSummary: '{"name":"Error","message":"consume exploded"}',
        },
        {
          index: 1,
          operationId: 'race:0:1',
          operationType: 'activity',
          operationLabel: 'slow-loser',
          outcome: 'lost',
        },
      ],
    });
  });

  it('cleans up a wait-signal waiter when cancellation lands after waiter registration', async () => {
    const abortController = new AbortController();
    class AbortOnSetMap extends Map<string, () => void> {
      override set(key: string, value: () => void) {
        abortController.abort();
        return super.set(key, value);
      }
    }

    const internals = {
      ...createSignalInternals(createSequencedStorage([[], []]) as never),
      abortController,
      signalWaiters: new AbortOnSetMap(),
      signalWaitersByWorkflow: new Map(),
    };

    await processWaitSignalOperation(
      internals,
      'workflow-id',
      {
        type: 'wait-signal',
        operationId: 'wait:0',
        signalName: 'release',
      },
      {
        completeOperation: () => {
          throw new Error('should not complete');
        },
      },
    );

    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.size).toBe(0);
  });

  it('delivers a buffered signal discovered after waiter registration', async () => {
    const payload = { ok: true };
    const internals = createSignalInternals(
      createSequencedStorage([
        [
          /* first scan empty */
        ],
        [[KEYS.signal('workflow-id', 'release', 'signal-1'), encode(payload)]],
      ]) as never,
    );
    const completed = mock(() => {});

    await processWaitSignalOperation(
      internals,
      'workflow-id',
      {
        type: 'wait-signal',
        operationId: 'wait:1',
        signalName: 'release',
      },
      {
        completeOperation: completed,
      },
    );

    expect(completed).toHaveBeenCalledWith('workflow-id', payload);
    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.size).toBe(0);
  });

  it('exits wait-signal cleanly when cancellation happens while awaiting the waiter promise', async () => {
    const signalWaiters = new WaiterTrackingMap();
    const internals = {
      ...createSignalInternals(createSequencedStorage([[], []]) as never),
      signalWaiters,
    } as unknown as EngineInternals;

    const waitPromise = processWaitSignalOperation(
      internals,
      'workflow-id',
      {
        type: 'wait-signal',
        operationId: 'wait:2',
        signalName: 'release',
      },
      {
        completeOperation: () => {
          throw new Error('should not complete');
        },
      },
    );

    await signalWaiters.registration.promise;
    const resolve = internals.signalWaiters.get('workflow-id:release');
    if (!resolve) {
      throw new Error('expected signal waiter to be registered');
    }
    internals.abortController.abort();
    resolve();

    await waitPromise;
  });

  it('routes non-speculative run-all branches through direct activity invocation', async () => {
    const result = await executeRunAllOperationResult(
      createWorkerModeInternals(),
      'workflow-id',
      {
        type: 'run-all',
        operationId: 'run-all:direct',
        step: 0,
        branches: {
          first: [
            (input: unknown) => {
              return { echoed: input };
            },
            'payload',
          ],
        },
      },
      {
        getActivityOperationCallbacks: () => {
          throw new Error(
            'activity callbacks should not be used without speculative activity metadata',
          );
        },
      },
      undefined,
    );

    expect(result).toEqual({ first: { echoed: 'payload' } });
  });

  it('reuses resumed run-all branches by name before dispatching the remaining branches', async () => {
    const operation: Extract<ContextOperationRequest, { type: 'run-all' }> = {
      type: 'run-all',
      operationId: 'run-all:resumed',
      step: 4,
      resumedCacheEntry: {
        type: 'parallel-operation-cache-entry',
        __weftParallelOperationCache: true,
        formatVersion: 2,
        variant: 'run-all',
        branchNames: ['cached', 'fresh'],
        subOperationCount: 2,
        branches: [
          { status: 'fulfilled', value: 'cached result', operationId: 'cached-op' },
          { status: 'pending', operationId: 'fresh-op' },
        ],
      },
      branches: {
        cached: [async () => 'should not run'],
        fresh: [async () => 'fresh result'],
      },
    };

    let captured: Record<string, unknown> | undefined;
    await processRunAllOperation(createWorkerModeInternals(), 'workflow-id', operation, {
      runOperationWithResult: async (_workflowId, _operation, execute) => {
        captured = (await execute()) as Record<string, unknown>;
      },
    });

    expect(captured).toEqual({
      cached: 'cached result',
      fresh: 'fresh result',
    });
  });
});
