import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { getInternals } from './internals.ts';
import {
  commitWorkflowStateOperations,
  loadWorkflowState,
  runSerializedWorkflowStateWrite,
} from './storage-io.ts';
import {
  cancelWorkflow,
  cleanupWaiters,
  cleanupWorkflowStorage,
  completeWorkflow,
  failWorkflow,
  runDeferredTerminalCleanup,
  type TerminationCallbacks,
} from './termination.ts';

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

function createTerminationCallbacks(
  overrides: Partial<TerminationCallbacks> = {},
): TerminationCallbacks {
  return {
    dispatchEvent: () => {},
    forwardEventToHandle: () => {},
    broadcast: () => {},
    swallowPromiseRejection: async (promise) => {
      await promise?.catch(() => undefined);
    },
    handleCleanupError: () => {},
    handleScheduledWorkflowTerminal: async () => {},
    loadWorkflowState: async () => null,
    runSerializedWorkflowStateWrite: async (_workflowId, writeOperation) => await writeOperation(),
    commitWorkflowStateOperations: async () => {},
    cleanupReviews: async () => {},
    ...overrides,
  };
}

describe('termination helpers', () => {
  it('cleanupWaiters removes single-key signal, update, and review waiters', () => {
    const signalWaiters = new Map<string, () => void>([['wf:signal', () => {}]]);
    const updateWaiters = new Map<string, (payload: unknown) => void>([['wf:update', () => {}]]);
    const reviewWaiters = new Map<string, (decision: unknown) => void>([['wf:review', () => {}]]);
    const internals = {
      signalWaiters,
      signalWaitersByWorkflow: new Map<string, string>([['wf-cleanup', 'wf:signal']]),
      updateWaiters,
      updateWaitersByWorkflow: new Map<string, string>([['wf-cleanup', 'wf:update']]),
      reviewWaiters,
      reviewWaitersByWorkflow: new Map<string, string>([['wf-cleanup', 'wf:review']]),
      sleepResolvers: new Map<string, () => void>(),
      sleepResolversByWorkflow: new Map<string, Set<string>>(),
      workflowReviewIds: new Map<string, Set<string>>(),
      reviewEscalationHandlers: new Map<
        string,
        (entry: { id: string; workflowId: string }) => Promise<boolean>
      >(),
      reviewTimerIds: new Map<string, string[]>(),
      workflowNestingDepths: new Map<string, number>([['wf-cleanup', 1]]),
      workflowHeaders: new Map<string, Map<string, string>>([
        ['wf-cleanup', new Map([['traceparent', 'value']])],
      ]),
      workflowTypeByWorkflowId: new Map<string, string>(),
      scheduler: {
        cancel: async () => {},
      },
    } as unknown as EngineInternals;

    cleanupWaiters(internals, 'wf-cleanup', createTerminationCallbacks());

    expect(signalWaiters.has('wf:signal')).toBe(false);
    expect(updateWaiters.has('wf:update')).toBe(false);
    expect(reviewWaiters.has('wf:review')).toBe(false);
    expect(internals.signalWaitersByWorkflow.has('wf-cleanup')).toBe(false);
    expect(internals.updateWaitersByWorkflow.has('wf-cleanup')).toBe(false);
    expect(internals.reviewWaitersByWorkflow.has('wf-cleanup')).toBe(false);
    expect(internals.workflowNestingDepths.has('wf-cleanup')).toBe(false);
    expect(internals.workflowHeaders.has('wf-cleanup')).toBe(false);
  });

  it('cleanupWaiters removes multi-key signal, update, and review waiter buckets', () => {
    const signalWaiters = new Map<string, () => void>([
      ['wf:signal-a', () => {}],
      ['wf:signal-b', () => {}],
    ]);
    const updateWaiters = new Map<string, (payload: unknown) => void>([
      ['wf:update-a', () => {}],
      ['wf:update-b', () => {}],
    ]);
    const reviewWaiters = new Map<string, (decision: unknown) => void>([
      ['wf:review-a', () => {}],
      ['wf:review-b', () => {}],
    ]);
    const internals = {
      signalWaiters,
      signalWaitersByWorkflow: new Map<string, Set<string>>([
        ['wf-cleanup-many', new Set(['wf:signal-a', 'wf:signal-b'])],
      ]),
      updateWaiters,
      updateWaitersByWorkflow: new Map<string, Set<string>>([
        ['wf-cleanup-many', new Set(['wf:update-a', 'wf:update-b'])],
      ]),
      reviewWaiters,
      reviewWaitersByWorkflow: new Map<string, Set<string>>([
        ['wf-cleanup-many', new Set(['wf:review-a', 'wf:review-b'])],
      ]),
      sleepResolvers: new Map<string, () => void>(),
      sleepResolversByWorkflow: new Map<string, Set<string>>(),
      workflowReviewIds: new Map<string, Set<string>>(),
      reviewEscalationHandlers: new Map<
        string,
        (entry: { id: string; workflowId: string }) => Promise<boolean>
      >(),
      reviewTimerIds: new Map<string, string[]>(),
      workflowNestingDepths: new Map<string, number>(),
      workflowHeaders: new Map<string, Map<string, string>>(),
      workflowTypeByWorkflowId: new Map<string, string>(),
      scheduler: {
        cancel: async () => {},
      },
    } as unknown as EngineInternals;

    cleanupWaiters(internals, 'wf-cleanup-many', createTerminationCallbacks());

    expect(signalWaiters.size).toBe(0);
    expect(updateWaiters.size).toBe(0);
    expect(reviewWaiters.size).toBe(0);
  });

  it('completeWorkflow falls back to stored search attributes when the checkpoint cache is missing', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const completionAttributeFallbackWorkflow = workflow({ name: 'completion-attribute-fallback' })
      .searchAttributes({
        customerId: { type: 'string' },
      })
      .execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      });
    engine.register(completionAttributeFallbackWorkflow);

    const handle = await engine.start('completion-attribute-fallback', null, {
      id: 'completion-attribute-fallback-id',
      searchAttributes: { customerId: 'alpha' },
    });
    await flush();

    const internals = getInternals(engine);
    internals.checkpoints.delete(handle.id);

    const callbacks = createTerminationCallbacks({
      loadWorkflowState: async (workflowId) => await loadWorkflowState(internals, workflowId),
      runSerializedWorkflowStateWrite: async (workflowId, writeOperation) =>
        await runSerializedWorkflowStateWrite(internals, workflowId, writeOperation),
      commitWorkflowStateOperations: async (state, operations) =>
        await commitWorkflowStateOperations(internals, state, operations),
    });

    await completeWorkflow(internals, handle.id, 'done', callbacks);

    const persistedState = await loadWorkflowState(internals, handle.id);
    expect(persistedState?.status).toBe('completed');
    expect(await storage.get(KEYS.attribute(handle.id))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('failWorkflow returns quietly when the workflow is already missing', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);

    const dispatchEvent = mock(() => {});
    await failWorkflow(
      internals,
      'missing-workflow',
      new Error('boom'),
      createTerminationCallbacks({ dispatchEvent }),
    );

    expect(dispatchEvent).not.toHaveBeenCalled();

    engine[Symbol.dispose]();
  });

  it('failWorkflow still rejects the pending result when synchronous cleanup throws', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const failureCleanupThrowWorkflow = workflow({ name: 'failure-cleanup-throw' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      },
    );
    engine.register(failureCleanupThrowWorkflow);

    const handle = await engine.start('failure-cleanup-throw', null, {
      id: 'failure-cleanup-throw-id',
    });
    await flush();

    const internals = getInternals(engine);
    const workflowError = new Error('workflow failed');
    const cleanupError = new Error('cleanup failed');
    const reject = mock((_reason: unknown) => {});

    internals.resultResolvers.set(handle.id, {
      promise: new Promise(() => {}),
      resolve: () => {},
      reject,
    });

    await expect(
      failWorkflow(
        internals,
        handle.id,
        workflowError,
        createTerminationCallbacks({
          cleanupReviews: async () => {
            throw cleanupError;
          },
        }),
      ),
    ).rejects.toBe(cleanupError);

    expect(reject).toHaveBeenCalledWith(workflowError);
    expect(internals.resultResolvers.has(handle.id)).toBe(false);

    const persistedState = await loadWorkflowState(internals, handle.id);
    expect(persistedState?.status).toBe('failed');

    engine[Symbol.dispose]();
  });

  it('cancelWorkflow rejects the pending result when synchronous cleanup throws', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const cancelCleanupThrowWorkflow = workflow({ name: 'cancel-cleanup-throw' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      },
    );
    engine.register(cancelCleanupThrowWorkflow);

    const handle = await engine.start('cancel-cleanup-throw', null, {
      id: 'cancel-cleanup-throw-id',
    });
    await flush();

    const internals = getInternals(engine);
    const cleanupError = new Error('cleanup failed');
    const reject = mock((_reason: unknown) => {});

    internals.resultResolvers.set(handle.id, {
      promise: new Promise(() => {}),
      resolve: () => {},
      reject,
    });

    await expect(
      cancelWorkflow(
        internals,
        handle.id,
        createTerminationCallbacks({
          cleanupReviews: async () => {
            throw cleanupError;
          },
        }),
      ),
    ).rejects.toBe(cleanupError);

    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'Workflow cancelled' }));
    expect(internals.resultResolvers.has(handle.id)).toBe(false);

    engine[Symbol.dispose]();
  });

  it('runDeferredTerminalCleanup ignores malformed and non-terminal cleanup timers', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'deferred-cleanup-running';
    const handleCleanupError = mock(() => {});
    const cleanupReviews = mock(async () => {});

    await runDeferredTerminalCleanup(
      { storage } as never,
      workflowId,
      'not-a-cleanup-timer',
      createTerminationCallbacks({ cleanupReviews, handleCleanupError }),
    );

    expect(handleCleanupError).toHaveBeenCalled();

    await runDeferredTerminalCleanup(
      { storage } as never,
      workflowId,
      'terminal-cleanup:full:token',
      createTerminationCallbacks({
        cleanupReviews,
        loadWorkflowState: async () => ({
          createdAt: 1,
          id: workflowId,
          input: null,
          startedAt: 1,
          status: 'running',
          type: 'workflow',
          updatedAt: 1,
          version: '1',
        }),
      }),
    );

    expect(cleanupReviews).not.toHaveBeenCalled();
  });

  it('completeWorkflow pins the post-commit notify-waiters ordering', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const completionOrderingWorkflow = workflow({ name: 'completion-ordering' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      },
    );
    engine.register(completionOrderingWorkflow);

    const handle = await engine.start('completion-ordering', null, {
      id: 'completion-ordering-id',
    });
    await flush();

    const internals = getInternals(engine);
    const events: string[] = [];

    // Install a resolver so we can witness when resolve fires relative to
    // dispatch/broadcast/forward/finalize.
    const resolveSpy = mock((_value: unknown) => {
      events.push('resolver.resolve');
    });
    internals.resultResolvers.set(handle.id, {
      promise: new Promise(() => {}),
      resolve: resolveSpy,
      reject: () => {},
    });

    const callbacks = createTerminationCallbacks({
      loadWorkflowState: async (workflowId) => await loadWorkflowState(internals, workflowId),
      runSerializedWorkflowStateWrite: async (workflowId, writeOperation) =>
        await runSerializedWorkflowStateWrite(internals, workflowId, writeOperation),
      commitWorkflowStateOperations: async (state, operations) => {
        events.push('commit');
        await commitWorkflowStateOperations(internals, state, operations);
      },
      dispatchEvent: () => events.push('dispatchEvent'),
      forwardEventToHandle: () => events.push('forwardEventToHandle'),
      broadcast: () => events.push('broadcast'),
      handleScheduledWorkflowTerminal: async () => {
        events.push('handleScheduledWorkflowTerminal');
      },
    });

    await completeWorkflow(internals, handle.id, 'done', callbacks);
    await flush();

    // Required ordering invariants:
    // - state commit happens first
    // - dispatchEvent / forwardEventToHandle / broadcast / resolver.resolve fire
    //   in that order, after the commit and before scheduled-terminal handoff
    // - scheduled-terminal handoff is best-effort and fires last
    expect(events[0]).toBe('commit');
    const dispatchIndex = events.indexOf('dispatchEvent');
    const forwardIndex = events.indexOf('forwardEventToHandle');
    const broadcastIndex = events.indexOf('broadcast');
    const resolveIndex = events.indexOf('resolver.resolve');
    const finalizeIndex = events.indexOf('handleScheduledWorkflowTerminal');

    expect(dispatchIndex).toBeGreaterThan(0);
    expect(forwardIndex).toBe(dispatchIndex + 1);
    expect(broadcastIndex).toBe(forwardIndex + 1);
    expect(resolveIndex).toBe(broadcastIndex + 1);
    expect(finalizeIndex).toBeGreaterThan(resolveIndex);

    expect(internals.resultResolvers.has(handle.id)).toBe(false);

    engine[Symbol.dispose]();
  });

  it('flushes durable cleanup deletes in batches', async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(storage, 'deletePrefix', { value: undefined });
    const workflowId = 'cleanup-batched';

    for (let index = 0; index < 1_001; index++) {
      await storage.put(KEYS.signal(workflowId, 'release', `signal-${index}`), new Uint8Array([1]));
    }

    await cleanupWorkflowStorage({ storage } as never, workflowId, false);

    expect(await storage.get(KEYS.signal(workflowId, 'release', 'signal-0'))).toBeNull();
    expect(await storage.get(KEYS.signal(workflowId, 'release', 'signal-1000'))).toBeNull();
  });
});
