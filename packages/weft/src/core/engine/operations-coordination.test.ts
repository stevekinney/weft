import { describe, expect, it, mock } from 'bun:test';

import {
  MemoryStorage,
  type BatchOperation,
  type ConditionalBatchCondition,
} from "../../embedded/storage/src/index.ts";
import { waitUntil } from "../../../test-support/embedded/testing/src/wait-until.ts";
import { KEYS } from '../../storage/keys.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { isParallelOperationCacheEntry } from '../context/parallel-cache-entry.ts';
import { workflow } from '../types.ts';
import { createDeferredConsumeEnvelope } from './deferred-consume-envelope.ts';
import { Engine, ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING } from './index.ts';
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
    engine: { dispatchEvent: () => true },
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
      step: 0,
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
    // load-proof: the registration promise was awaited and the scan that follows runs inside the promise chain on in-memory waiters, so a microtask drain parks the old operation
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

/** The parallel cache entry a run's committed checkpoint holds, with its slots, if it holds one. */
async function committedParallelEntry(storage: MemoryStorage, workflowId: string) {
  const bytes = await storage.get(KEYS.checkpoint(workflowId));
  if (bytes === null) return undefined;
  return deserializeCheckpoint(bytes)
    .accumulatedResults.map(([, value]) => value)
    .find(isParallelOperationCacheEntry);
}

/** Records the keys of every batch the engine commits, so a test can say what one batch held. */
class RecordingStorage extends MemoryStorage {
  readonly batches: string[][] = [];

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const committed = await super.conditionalBatch(conditions, operations);
    if (committed) this.batches.push(operations.map((operation) => operation.key));
    return committed;
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    await super.batch(operations);
    this.batches.push(operations.map((operation) => operation.key));
  }
}

type ParallelOperationRequest = Extract<ContextOperationRequest, { type: 'parallel' }>;

/**
 * A `ctx.all` operation of `count` branches the test settles by hand, in the order it chooses, run
 * through `processParallelOperation` with a persist callback that records what it was asked to
 * commit and what the cache held at that moment.
 */
function slotCommitHarness(
  count: number,
  options: { settle?: 'settled'; persist?: boolean; token?: string } = {},
) {
  const workflowId = 'wf-slot-commit';
  const operation: ParallelOperationRequest = {
    type: 'parallel',
    ...(options.settle === undefined ? {} : { settle: options.settle }),
    operationId: 'parallel:0',
    step: 3,
    operations: Array.from({ length: count }, (_, index) => ({
      type: 'wait-signal' as const,
      operationId: `parallel:0:${String(index)}`,
      signalName: `branch-${String(index)}`,
    })),
  };
  const accumulatedResults = new Map<number, unknown>();
  const internals = {
    inlineStrategy: { getContext: () => ({ accumulatedResults }) },
    durableInlineOperations: new Map([
      [
        workflowId,
        { operationId: 'parallel:0', workflowExecutionToken: options.token ?? 'token-1' },
      ],
    ]),
    checkpoints: new Map(),
    pendingTimelineEntries: new Map(),
  } as unknown as EngineInternals;
  const branches = operation.operations.map(() => Promise.withResolvers<unknown>());
  const finalized: number[] = [];
  const commits: {
    cache: unknown;
    finalizedBefore: number[];
    settledBranchOperationIds: readonly string[] | undefined;
  }[] = [];
  let inFlight = 0;
  let overlapped = false;
  let persistFailure: Error | undefined;
  let captured: unknown;
  const done = processParallelOperation(internals, workflowId, operation, {
    executeSubOperation: (_id, subOperation) => {
      const index = Number(subOperation.operationId.split(':').at(-1));
      return branches[index]!.promise;
    },
    runOperationWithResult: async (_id, _operation, execute) => {
      try {
        captured = await execute();
      } catch (error) {
        captured = error;
      }
    },
    ...(options.persist === false
      ? {}
      : {
          persistCheckpoint: async (_id, _operation, report) => {
            inFlight += 1;
            overlapped ||= inFlight > 1;
            commits.push({
              cache: structuredClone(accumulatedResults.get(3)),
              finalizedBefore: [...finalized],
              settledBranchOperationIds: report?.settledBranchOperationIds,
            });
            await Promise.resolve();
            inFlight -= 1;
            if (persistFailure !== undefined) throw persistFailure;
          },
        }),
  });
  return {
    internals,
    accumulatedResults,
    commits,
    finalized,
    failPersistWith(error: Error) {
      persistFailure = error;
    },
    overlapped: () => overlapped,
    result: () => captured,
    done,
    /** Settle branch `index` with a deferred-consume envelope that records its finalization. */
    fulfill(index: number, value: unknown) {
      branches[index]!.resolve(
        createDeferredConsumeEnvelope(async () => {
          finalized.push(index);
          return value;
        }),
      );
    },
    reject(index: number, error: Error) {
      branches[index]!.reject(error);
    },
  };
}

describe('a ctx.all branch that settles before its siblings commits on its own (COR-2416)', () => {
  const slotOf = (cache: unknown, index: number) =>
    (cache as { branches: { status: string; value?: unknown }[] }).branches[index];

  it('finalizes the settled branch and commits it, with its siblings still pending', async () => {
    const harness = slotCommitHarness(2);
    harness.fulfill(0, 'first');
    await waitUntil(async () => harness.commits.length === 1);
    expect(harness.finalized).toEqual([0]);
    expect(harness.commits[0]!.settledBranchOperationIds).toEqual(['parallel:0:0']);
    expect(slotOf(harness.commits[0]!.cache, 0)).toMatchObject({
      status: 'fulfilled',
      value: 'first',
    });
    expect(slotOf(harness.commits[0]!.cache, 1)?.status).toBe('pending');
    harness.fulfill(1, 'second');
    await harness.done;
    expect(harness.result()).toEqual(['first', 'second']);
    // The last branch to settle belongs to the operation's own result: it commits no slot.
    expect(harness.commits).toHaveLength(1);
  });

  const countRows: readonly [string, number, number][] = [
    ['one branch has no sibling to wait for', 1, 0],
    ['two branches: the first to settle commits', 2, 1],
    ['three branches: every settle but the last commits', 3, 2],
  ];
  for (const [name, count, commits] of countRows) {
    it(`commits ${String(commits)} slot(s): ${name}`, async () => {
      const harness = slotCommitHarness(count);
      for (let index = 0; index < count; index++) {
        harness.fulfill(index, `value-${String(index)}`);
        // Each branch settles after the commit of the one before it has finished.
        await waitUntil(async () => harness.commits.length >= Math.min(index + 1, commits));
      }
      await harness.done;
      expect(harness.commits).toHaveLength(commits);
      expect(harness.result()).toEqual(
        Array.from({ length: count }, (_, index) => `value-${String(index)}`),
      );
    });
  }

  it('never overlaps two commits when branches settle together', async () => {
    const harness = slotCommitHarness(4);
    for (const index of [0, 1, 2]) harness.fulfill(index, index);
    harness.fulfill(3, 3);
    await harness.done;
    expect(harness.overlapped()).toBe(false);
    expect(harness.result()).toEqual([0, 1, 2, 3]);
  });

  it('keeps a branch whose own commit is still queued out of the entry it commits', async () => {
    const harness = slotCommitHarness(3);
    harness.fulfill(0, 'a');
    harness.fulfill(1, 'b');
    await waitUntil(async () => harness.commits.length === 2);
    harness.fulfill(2, 'c');
    await harness.done;
    for (const commit of harness.commits) {
      const fulfilled = (commit.cache as { branches: { status: string }[] }).branches.flatMap(
        (slot, index) => (slot.status === 'fulfilled' ? [index] : []),
      );
      // Every value in a committed entry has been finalized, so an envelope never reaches storage.
      for (const index of fulfilled) expect(commit.finalizedBefore).toContain(index);
    }
  });

  it('writes the all-settled variant for a settled operation', async () => {
    const harness = slotCommitHarness(2, { settle: 'settled' });
    harness.fulfill(0, 'first');
    await waitUntil(async () => harness.commits.length === 1);
    expect((harness.commits[0]!.cache as { variant: string }).variant).toBe('all-settled');
    harness.fulfill(1, 'second');
    await harness.done;
    expect((harness.accumulatedResults.get(3) as { variant: string }).variant).toBe('all-settled');
  });

  const noCommitRows: readonly [string, Parameters<typeof slotCommitHarness>[1]][] = [
    ['no persist callback is provided', { persist: false }],
  ];
  for (const [name, options] of noCommitRows) {
    it(`commits nothing when ${name}`, async () => {
      const harness = slotCommitHarness(2, options);
      harness.fulfill(0, 'first');
      harness.fulfill(1, 'second');
      await harness.done;
      expect(harness.commits).toHaveLength(0);
      expect(harness.result()).toEqual(['first', 'second']);
    });
  }

  it('commits nothing for a branch that settles after its workflow moved to another run', async () => {
    const harness = slotCommitHarness(2);
    harness.internals.durableInlineOperations.set('wf-slot-commit', {
      operationId: 'parallel:0',
      workflowExecutionToken: 'token-2',
    } as never);
    harness.fulfill(0, 'first');
    harness.fulfill(1, 'second');
    await harness.done;
    expect(harness.commits).toHaveLength(0);
  });

  it('fails the operation with a slot commit failure and commits no later slot', async () => {
    const harness = slotCommitHarness(3);
    harness.failPersistWith(new Error('checkpoint write refused'));
    harness.fulfill(0, 'a');
    await waitUntil(async () => harness.commits.length === 1);
    harness.fulfill(1, 'b');
    harness.fulfill(2, 'c');
    await harness.done;
    expect(harness.commits).toHaveLength(1);
    expect(harness.result()).toBeInstanceOf(Error);
    expect((harness.result() as Error).message).toBe('checkpoint write refused');
  });

  it('still writes a rejected sibling and rethrows its reason after the slot commits', async () => {
    const harness = slotCommitHarness(3);
    harness.fulfill(0, 'a');
    await waitUntil(async () => harness.commits.length === 1);
    harness.reject(1, new Error('branch failed'));
    harness.fulfill(2, 'c');
    await harness.done;
    expect((harness.result() as Error).message).toBe('branch failed');
    const entry = harness.accumulatedResults.get(3) as { branches: { status: string }[] };
    expect(entry.branches.map((slot) => slot.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
  });
});

describe('a settled ctx.all branch is committed durably (COR-2416)', () => {
  const rows = [
    { coordinator: 'all', expected: ['A', 'yes'] },
    {
      coordinator: 'allSettled',
      expected: [
        { status: 'fulfilled', value: 'A' },
        { status: 'fulfilled', value: 'yes' },
      ],
    },
  ] as const;

  for (const row of rows) {
    it(`runs a finished ${row.coordinator} branch activity once across three restarts while a sibling wait is open`, async () => {
      let executions = 0;
      const finishing = async () => {
        executions += 1;
        return 'A';
      };
      const name = `${row.coordinator}-slot-commit`;
      const id = `${name}-run`;
      const define = () =>
        workflow({ name }).execute(async function* (ctx) {
          const branches = [ctx.run(finishing), ctx.waitForSignal<string>('go')];
          return yield* row.coordinator === 'all' ? ctx.all(branches) : ctx.allSettled(branches);
        });
      const storage = new MemoryStorage();
      {
        await using original = new Engine({ storage });
        original.register(define());
        await original.start(name, null, { id });
        await original[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](id);
        await waitUntil(async () => (await committedParallelEntry(storage, id)) !== undefined, {
          message: 'the finished branch to be committed',
        });
      }
      for (const restart of [1, 2, 3]) {
        await using restarted = new Engine({ storage });
        restarted.register(define());
        await restarted.recoverAll();
        await restarted[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](id);
        expect({ restart, executions }).toEqual({ restart, executions: 1 });
      }
      await using last = new Engine({ storage });
      last.register(define());
      const [handle] = await last.recoverAll();
      await last[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](id);
      await last.signal(id, 'go', 'yes');
      expect(await handle!.result()).toEqual(row.expected as unknown as never);
      expect(executions).toBe(1);
    });
  }

  it('resumes without a restart with the same result, the activity run once (matrix row E2)', async () => {
    let executions = 0;
    const name = 'all-slot-commit-resume';
    const id = `${name}-run`;
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name }).execute(async function* (ctx) {
        return yield* ctx.all([
          ctx.run(async () => {
            executions += 1;
            return 'A';
          }),
          ctx.waitForSignal<string>('go'),
        ]);
      }),
    );
    const handle = await engine.start(name, null, { id });
    await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](id);
    await handle.signal('go', 'yes');
    expect(await handle.result()).toEqual(['A', 'yes']);
    expect(executions).toBe(1);
  });

  it('commits a nested ctx.all as one branch of the outer one (matrix row E11)', async () => {
    // A nested coordinator is a single operation of its outer branch: durability is the outer
    // `ctx.all`'s, so the nested activities run again only if the nested branch did not settle.
    const executions = { inner: 0 };
    const name = 'all-nested-slot-commit';
    const id = `${name}-run`;
    const define = () =>
      workflow({ name }).execute(async function* (ctx) {
        const inner = ctx.all([
          ctx.run(async () => {
            executions.inner += 1;
            return 'x';
          }),
          ctx.run(async () => {
            executions.inner += 1;
            return 'y';
          }),
        ]);
        return yield* ctx.all([inner, ctx.waitForSignal<string>('go')]);
      });
    const storage = new MemoryStorage();
    {
      await using original = new Engine({ storage });
      original.register(define());
      await original.start(name, null, { id });
      await original[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](id);
      await waitUntil(async () => (await committedParallelEntry(storage, id)) !== undefined, {
        message: 'the nested branch to be committed',
      });
    }
    await using restarted = new Engine({ storage });
    restarted.register(define());
    const [handle] = await restarted.recoverAll();
    await restarted[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](id);
    await restarted.signal(id, 'go', 'yes');
    expect(await handle!.result()).toEqual([['x', 'y'], 'yes']);
    expect(executions.inner).toBe(2);
  });

  it('commits a fulfilled wait slot together with its signal consume, and takes the signal once across a restart', async () => {
    // AC7: the consume of a fulfilled wait slot is staged into the same batch that checkpoints the
    // slot, so no commit holds the slot without the delete, or the delete without the slot.
    const storage = new RecordingStorage();
    let releaseSlow: (value: string) => void = () => undefined;
    let slowRuns = 0;
    const slow = () => {
      slowRuns += 1;
      return new Promise<string>((resolve) => {
        releaseSlow = resolve;
      });
    };
    const name = 'all-wait-slot-commit';
    const id = `${name}-run`;
    const define = () =>
      workflow({ name }).execute(async function* (ctx) {
        return yield* ctx.all([ctx.waitForSignal<string>('go'), ctx.run(slow)]);
      });
    {
      await using original = new Engine({ storage });
      original.register(define());
      const handle = await original.start(name, null, { id });
      await original[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](id);
      await handle.signal('go', 'yes');
      await waitUntil(async () => (await committedParallelEntry(storage, id)) !== undefined, {
        message: 'the fulfilled wait slot to be committed',
      });
    }
    const signalRecordKeys = (batch: string[]) => batch.filter((key) => key.startsWith('sig:'));
    const slotBatches = storage.batches.filter(
      (batch) => batch.includes(KEYS.checkpoint(id)) && signalRecordKeys(batch).length > 0,
    );
    expect(slotBatches).toHaveLength(1);
    const remaining: string[] = [];
    for await (const [key] of storage.scan('sig:')) remaining.push(key);
    expect(remaining).toEqual([]);

    await using restarted = new Engine({ storage });
    restarted.register(define());
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => slowRuns === 2, { message: 'the unfinished branch to run again' });
    releaseSlow('done');
    expect(await handle!.result()).toEqual(['yes', 'done']);
  });
});
