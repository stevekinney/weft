import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  sleepForTesting,
  waitForRealTimersForTesting,
} from '../../testing/fake-timers.test-support.ts';
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import {
  createStreamOperationCallbacks,
  createTimeOperationCallbacks,
} from './callback-creators-bundles.ts';
import { createSubmitReviewCallbacks } from './callback-creators-schedule.ts';
import {
  createInlineParkingCallbacks,
  createLifecycleCallbacks,
  createRegistrationCallbacks,
  createUpdateCallbacks,
} from './callback-creators.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

function createCompletedWorkflowState(workflowId: string, updatedAt: number): WorkflowState {
  return {
    createdAt: updatedAt,
    id: workflowId,
    input: null,
    result: 'done',
    startedAt: updatedAt,
    status: 'completed',
    type: 'workflow',
    updatedAt,
    version: '1',
  };
}

describe('engine callback creators', () => {
  it('exercises lifecycle pending-update callback wrappers', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const callbacks = createLifecycleCallbacks(engine);

    callbacks.processPendingUpdatesAfterReplay('workflow-callback-replay');
    await callbacks.processPendingUpdatesForHandlers('workflow-callback-handlers');
    callbacks.handleCleanupError('test-cleanup', new Error('cleanup failed'), 'workflow-cleanup');
    await sleepForTesting(0);

    await internals.updateCoordinator.createRequest('workflow-callback-error', 'approve', {
      approved: true,
    });
    internals.inlineStrategy = {
      getContext: () => ({
        updateHandlers: new Map([['approve', () => 'ok']]),
      }),
    } as never;
    const realStorage = internals.storage;
    internals.storage = {
      capabilities: realStorage.capabilities.bind(realStorage),
      delete: realStorage.delete.bind(realStorage),
      get: realStorage.get.bind(realStorage),
      put: realStorage.put.bind(realStorage),
      scan: realStorage.scan.bind(realStorage),
      batch: async () => {
        throw new Error('pending update batch failed');
      },
      [Symbol.dispose]() {
        realStorage[Symbol.dispose]();
      },
    };
    callbacks.processPendingUpdatesAfterReplay('workflow-callback-error');
    await sleepForTesting(0);

    engine[Symbol.dispose]();
  });

  it('reads checkpoint bytes through inline parking callbacks', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    await storage.put(KEYS.checkpoint('workflow-checkpoint'), new Uint8Array([1, 2, 3]));

    await expect(
      createInlineParkingCallbacks(engine).readCheckpointBytes('workflow-checkpoint'),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));

    engine[Symbol.dispose]();
  });

  it('routes workflow target resolution through lifecycle callbacks', () => {
    const engine = new Engine();
    const callbacks = createLifecycleCallbacks(engine);

    expect(callbacks.resolveWorkflowTypeTarget('workflow-target')).toBe('workflow-target');

    engine[Symbol.dispose]();
  });

  it('persists coordinated update responses through update callbacks', async () => {
    const engine = new Engine();

    await createUpdateCallbacks(engine).persistCoordinatedUpdateResponse(
      'workflow-update-response',
      'approve',
      'update-1',
      'idempotency-1',
      { approved: true },
    );

    engine[Symbol.dispose]();
  });

  it('binds submit-review dispatch callbacks to the engine', () => {
    const engine = new Engine();
    const event = new Event('review:submitted');
    const listener = mock(() => {});
    engine.addEventListener('review:submitted', listener);

    createSubmitReviewCallbacks(engine).dispatchEvent(event);

    expect(listener).toHaveBeenCalledWith(event);

    engine[Symbol.dispose]();
  });

  it('routes stream cleanup errors and time operation helpers through engine callbacks', async () => {
    const engine = new Engine();

    createStreamOperationCallbacks(engine).handleCleanupError(
      'stream-cleanup',
      new Error('stream failed'),
      'workflow-stream',
    );

    const timeCallbacks = createTimeOperationCallbacks(engine);
    expect(timeCallbacks.parseStartOptionDuration('5ms', 'options.startAfter')).toBe(5);
    await expect(
      timeCallbacks.failWorkflow('workflow-missing', new Error('failed')),
    ).resolves.toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('runs retention sweeps through registration callbacks and cleans deleted workflow waiters', async () => {
    const storage = new MemoryStorage();
    let now = 10_000;
    const engine = new Engine({ getNow: () => now, storage });
    const internals = getInternals(engine);
    internals.options.retention = { completed: 0 };
    internals.options.retentionSweepIntervalMs = 5;
    internals.options.retentionSweepBatchSize = 10;
    const waiter = mock(() => {});
    internals.signalWaiters.set('workflow-retention-callback:done', waiter);
    internals.signalWaitersByWorkflow.set(
      'workflow-retention-callback',
      'workflow-retention-callback:done',
    );
    await storage.put(
      KEYS.workflow('workflow-retention-callback'),
      encode(createCompletedWorkflowState('workflow-retention-callback', now - 1)),
    );
    await storage.put(
      KEYS.terminalWorkflow(now - 1, 'workflow-retention-callback'),
      new Uint8Array(),
    );

    createRegistrationCallbacks(engine).ensureRetentionSweepInterval();
    await waitForRealTimersForTesting(80);
    now += 10;
    await waitForRealTimersForTesting(80);

    expect(await storage.get(KEYS.workflow('workflow-retention-callback'))).toBeNull();
    expect(internals.signalWaiters.has('workflow-retention-callback:done')).toBe(false);

    engine[Symbol.dispose]();
  });
});
