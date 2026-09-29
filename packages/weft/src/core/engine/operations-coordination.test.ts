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
} from './operations-coordination.ts';
import { completeOperation, failOperation } from './operations-router.ts';
import { processWaitConditionOperation } from './operations-wait-condition.ts';
import { processWaitSignalOperation } from './operations-wait-signal.ts';
import { registerSignalWaiter } from './signals.ts';

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
        failOperation: (_workflowId, _operation, error) => {
          throw error;
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
        [/* first scan empty */],
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
        failOperation: (_workflowId, _operation, error) => {
          throw error;
        },
      },
    );

    expect(completed).toHaveBeenCalledWith('workflow-id', payload, 'wait:1', undefined);
    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.size).toBe(0);
  });

  it('does not stage a signal delete when a successor replaces the run during the scan', async () => {
    const operation = {
      type: 'wait-signal' as const,
      operationId: 'wait:stale-delete',
      signalName: 'release',
    };
    const internals = createSignalInternals();
    internals.durableInlineOperations = new Map([
      [
        'workflow-id',
        { operationId: operation.operationId, type: operation.type, workflowExecutionToken: 'old' },
      ],
    ]);
    let scanCount = 0;
    internals.storage = {
      async delete() {},
      scan() {
        scanCount += 1;
        return (async function* () {
          if (scanCount === 2) {
            internals.durableInlineOperations.set('workflow-id', {
              operationId: operation.operationId,
              type: operation.type,
              workflowExecutionToken: 'successor',
            });
            yield [KEYS.signal('workflow-id', 'release', 'signal-1'), encode({ ok: true })];
          }
        })();
      },
    } as never;
    const complete = mock(() => {});

    await processWaitSignalOperation(internals, 'workflow-id', operation, {
      completeOperation: complete,
      failOperation: () => {
        throw new Error('stale signal scan must not fail');
      },
    });

    expect(internals.pendingAtomicWorkflowCommitSideEffects.size).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('drops a buffered success after post-registration replacement and preserves the successor waiter', async () => {
    const operation = {
      type: 'wait-signal' as const,
      operationId: 'wait:buffered-replacement',
      signalName: 'release',
    };
    const internals = createSignalInternals();
    internals.durableInlineOperations = new Map([
      [
        'workflow-id',
        { operationId: operation.operationId, type: operation.type, workflowExecutionToken: 'old' },
      ],
    ]);
    let scanCount = 0;
    const replacement = mock(() => {});
    internals.storage = {
      async delete() {},
      scan() {
        scanCount += 1;
        return (async function* () {
          if (scanCount === 2) {
            internals.durableInlineOperations.set('workflow-id', {
              operationId: operation.operationId,
              type: operation.type,
              workflowExecutionToken: 'successor',
            });
            registerSignalWaiter(internals, 'workflow-id', 'workflow-id:release', replacement);
            yield [KEYS.signal('workflow-id', 'release', 'signal-1'), encode({ ok: true })];
          }
        })();
      },
    } as never;
    const finalized = mock(() => {});
    const fed = mock(() => {});

    await processWaitSignalOperation(internals, 'workflow-id', operation, {
      completeOperation: (workflowId, value, operationId, token) =>
        completeOperation(
          internals,
          workflowId,
          value,
          { finalizePendingTimelineEntry: finalized, feedOperationResult: fed },
          operationId,
          token,
        ),
      failOperation: () => {
        throw new Error('replacement signal must not fail');
      },
    });

    expect(scanCount).toBe(2);
    expect(finalized).not.toHaveBeenCalled();
    expect(fed).not.toHaveBeenCalled();
    expect(internals.signalWaiters.get('workflow-id:release')).toBe(replacement);
  });

  it('does not re-register an old waiter after delivery and run replacement', async () => {
    const operation = {
      type: 'wait-signal' as const,
      operationId: 'wait:delivered-replacement',
      signalName: 'release',
    };
    const signalWaiters = new WaiterTrackingMap();
    const internals = {
      ...createSignalInternals(createSequencedStorage([[], [], []]) as never),
      signalWaiters,
      durableInlineOperations: new Map([
        [
          'workflow-id',
          {
            operationId: operation.operationId,
            type: operation.type,
            workflowExecutionToken: 'old',
          },
        ],
      ]),
    } as unknown as EngineInternals;
    const complete = mock(() => {});
    const task = processWaitSignalOperation(internals, 'workflow-id', operation, {
      completeOperation: complete,
      failOperation: () => {
        throw new Error('stale waiter must not fail');
      },
    });

    await signalWaiters.registration.promise;
    // Let the post-registration scan finish so the old operation is parked on
    // its waiter promise before replacement races the delivered wake.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const oldWaiter = signalWaiters.get('workflow-id:release');
    if (!oldWaiter) throw new Error('expected the old waiter');
    signalWaiters.delete('workflow-id:release');
    internals.durableInlineOperations?.set('workflow-id', {
      operationId: operation.operationId,
      type: operation.type,
      workflowExecutionToken: 'successor',
    });
    oldWaiter();
    await task;

    expect(signalWaiters.has('workflow-id:release')).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('releases the waiter and fails the operation when the buffered-signal scan after registration throws', async () => {
    // The second scan runs after the waiter is registered. If it throws and the
    // waiter stays registered, it outlives the failed operation (COR-1357).
    const scanFailure = new Error('simulated signal scan failure');
    let scanCount = 0;
    const storage = {
      async delete() {},
      scan() {
        scanCount += 1;
        return (async function* () {
          if (scanCount === 2) {
            throw scanFailure;
          }
        })();
      },
    };
    const internals = createSignalInternals(storage as never);
    const failed = mock((_workflowId: string, _operation: unknown, _error: unknown) => {});

    await processWaitSignalOperation(
      internals,
      'workflow-id',
      {
        type: 'wait-signal',
        operationId: 'wait:scan-failure',
        signalName: 'release',
      },
      {
        completeOperation: () => {
          throw new Error('should not complete');
        },
        failOperation: failed,
      },
    );

    expect(scanCount).toBe(2);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]?.[2]).toBe(scanFailure);
    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.size).toBe(0);
  });

  it('does not fail a replacement waiter when an old buffered-signal scan throws', async () => {
    const scanFailure = new Error('stale signal scan failed');
    const replacement = mock(() => {});
    const failed = mock((_workflowId: string, _operation: unknown, _error: unknown) => {});
    let scanCount = 0;
    let internals: EngineInternals;
    const storage = {
      async delete() {},
      scan() {
        scanCount += 1;
        return (async function* () {
          if (scanCount === 2) {
            registerSignalWaiter(internals, 'workflow-id', 'workflow-id:release', replacement);
            throw scanFailure;
          }
        })();
      },
    };
    internals = createSignalInternals(storage as never);

    await processWaitSignalOperation(
      internals,
      'workflow-id',
      { type: 'wait-signal', operationId: 'wait:old', signalName: 'release' },
      {
        completeOperation: () => {
          throw new Error('old waiter must not complete');
        },
        failOperation: failed,
      },
    );

    expect(scanCount).toBe(2);
    expect(failed).not.toHaveBeenCalled();
    expect(internals.signalWaiters.get('workflow-id:release')).toBe(replacement);
    expect(internals.signalWaitersByWorkflow.get('workflow-id')).toContain('workflow-id:release');
  });

  it('drops a pre-registration scan failure after a successor replaces the run', async () => {
    const operation = {
      type: 'wait-signal' as const,
      operationId: 'wait:pre-registration',
      signalName: 'release',
    };
    const internals = createSignalInternals();
    internals.durableInlineOperations = new Map([
      [
        'workflow-id',
        { operationId: operation.operationId, type: operation.type, workflowExecutionToken: 'old' },
      ],
    ]);
    const finalized = mock(() => {});
    const fed = mock(() => {});
    internals.storage = {
      async delete() {},
      scan() {
        internals.durableInlineOperations.set('workflow-id', {
          operationId: operation.operationId,
          type: operation.type,
          workflowExecutionToken: 'successor',
        });
        return (async function* () {
          throw new Error('stale pre-registration scan');
        })();
      },
    } as never;

    await processWaitSignalOperation(internals, 'workflow-id', operation, {
      completeOperation: () => {
        throw new Error('stale scan must not complete');
      },
      failOperation: (workflowId, failedOperation, error, token) =>
        failOperation(
          internals,
          workflowId,
          failedOperation,
          error,
          { finalizePendingTimelineEntry: finalized, feedOperationResult: fed },
          operation.operationId,
          token,
        ),
    });

    expect(finalized).not.toHaveBeenCalled();
    expect(fed).not.toHaveBeenCalled();
  });

  it('drops an already-delivered signal after a successor replaces the run', async () => {
    const operation = {
      type: 'wait-signal' as const,
      operationId: 'wait:already-delivered',
      signalName: 'release',
    };
    const internals = createSignalInternals();
    internals.durableInlineOperations = new Map([
      [
        'workflow-id',
        { operationId: operation.operationId, type: operation.type, workflowExecutionToken: 'old' },
      ],
    ]);
    const finalized = mock(() => {});
    const fed = mock(() => {});
    internals.storage = {
      async delete() {},
      scan() {
        internals.durableInlineOperations.set('workflow-id', {
          operationId: operation.operationId,
          type: operation.type,
          workflowExecutionToken: 'successor',
        });
        return (async function* () {
          yield [KEYS.signal('workflow-id', 'release', 'signal-1'), encode({ ok: true })];
        })();
      },
    } as never;

    await processWaitSignalOperation(internals, 'workflow-id', operation, {
      completeOperation: (workflowId, value, operationId, token) =>
        completeOperation(
          internals,
          workflowId,
          value,
          { finalizePendingTimelineEntry: finalized, feedOperationResult: fed },
          operationId,
          token,
        ),
      failOperation: () => {
        throw new Error('already-delivered signal must not fail');
      },
    });

    expect(finalized).not.toHaveBeenCalled();
    expect(fed).not.toHaveBeenCalled();
  });

  it('drops an immediately-complete wait-condition after a successor replaces the run', async () => {
    const operation = {
      type: 'wait-condition' as const,
      operationId: 'condition:replayed',
      step: 3,
      predicate: () => {
        internals.durableInlineOperations.set('workflow-id', {
          operationId: operation.operationId,
          type: operation.type,
          workflowExecutionToken: 'successor',
        });
        return true;
      },
    };
    const internals = {
      ...createSignalInternals(),
      checkpoints: new Map(),
      durableInlineOperations: new Map([
        [
          'workflow-id',
          {
            operationId: operation.operationId,
            type: operation.type,
            workflowExecutionToken: 'old',
          },
        ],
      ]),
      options: { getNow: () => 0 },
    } as unknown as EngineInternals;
    const finalized = mock(() => {});
    const fed = mock(() => {});

    await processWaitConditionOperation(internals, 'workflow-id', operation, {
      completeOperation: (workflowId, value, operationId, token) =>
        completeOperation(
          internals,
          workflowId,
          value,
          { finalizePendingTimelineEntry: finalized, feedOperationResult: fed },
          operationId,
          token,
        ),
      failOperation: () => {
        throw new Error('wait-condition should not fail');
      },
      isWorkflowRunning: async () => true,
      scheduleConditionDeadline: async () => {},
      cancelConditionDeadline: async () => {},
    });

    expect(finalized).not.toHaveBeenCalled();
    expect(fed).not.toHaveBeenCalled();
  });

  it('does not let an old wait-condition cleanup remove a successor waiter', async () => {
    const schedule = Promise.withResolvers<void>();
    const running = Promise.withResolvers<boolean>();
    const internals = {
      ...createSignalInternals(),
      options: { getNow: () => 0 },
    } as unknown as EngineInternals;
    const operation = {
      type: 'wait-condition' as const,
      operationId: 'condition:old',
      step: 1,
      predicate: () => false,
    };
    const failed = mock(() => {});
    const task = processWaitConditionOperation(internals, 'workflow-id', operation, {
      completeOperation: () => {},
      failOperation: failed,
      isWorkflowRunning: () => running.promise,
      scheduleConditionDeadline: async () => schedule.promise,
      cancelConditionDeadline: async () => {},
    });

    schedule.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const oldWaiter = internals.conditionWaiters.get('workflow-id');
    expect(oldWaiter).toBeFunction();
    oldWaiter?.();
    await Promise.resolve();
    const successorWaiter = mock(() => {});
    internals.conditionWaiters.set('workflow-id', successorWaiter);
    running.resolve(false);
    await task;

    expect(internals.conditionWaiters.get('workflow-id')).toBe(successorWaiter);
    expect(failed).not.toHaveBeenCalled();
  });

  it('does not register a condition waiter after deadline scheduling replaces the run', async () => {
    const operation = {
      type: 'wait-condition' as const,
      operationId: 'condition:old',
      step: 1,
      deadline: 1_000,
      predicate: () => false,
    };
    const internals = {
      ...createSignalInternals(),
      durableInlineOperations: new Map([
        [
          'workflow-id',
          {
            operationId: operation.operationId,
            type: operation.type,
            workflowExecutionToken: 'old',
          },
        ],
      ]),
      options: { getNow: () => 0 },
    } as unknown as EngineInternals;
    const complete = mock(() => {});
    const fail = mock(() => {});
    const cancel = mock(async () => {});

    await processWaitConditionOperation(internals, 'workflow-id', operation, {
      completeOperation: complete,
      failOperation: fail,
      isWorkflowRunning: async () => true,
      scheduleConditionDeadline: async () => {
        internals.durableInlineOperations.set('workflow-id', {
          operationId: operation.operationId,
          type: operation.type,
          workflowExecutionToken: 'successor',
        });
      },
      cancelConditionDeadline: cancel,
    });

    expect(internals.conditionWaiters.has('workflow-id')).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
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
        failOperation: (_workflowId, _operation, error) => {
          throw error;
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
