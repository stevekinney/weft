import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { encode } from '../codec.ts';
import { CleanupWarningEvent } from '../events.ts';
import type { WorkflowState } from '../types.ts';
import {
  createStreamOperationCallbacks,
  createTimeOperationCallbacks,
} from './callback-creators-bundles.ts';
import {
  createScheduleCallbacks,
  createSubmitReviewCallbacks,
} from './callback-creators-schedule.ts';
import {
  createInlineParkingCallbacks,
  createLifecycleCallbacks,
  createRegistrationCallbacks,
  createUpdateCallbacks,
} from './callback-creators.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { type ScheduleCallbacks, startScheduledRun } from './schedules.ts';

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
    versionTuple: { workflowVersion: '1' },
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

  it('routes schedule cleanup errors through engine callbacks', async () => {
    const engine = new Engine();
    const warnings: CleanupWarningEvent[] = [];
    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event as CleanupWarningEvent);
    });

    createScheduleCallbacks(engine).handleCleanupError(
      'schedule-cleanup',
      new Error('schedule cleanup failed'),
      'workflow-schedule',
    );
    await sleepForTesting(0);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.source).toBe('schedule-cleanup');
    expect(warnings[0]!.workflowId).toBe('workflow-schedule');
    expect(warnings[0]!.error.message).toBe('schedule cleanup failed');

    engine[Symbol.dispose]();
  });

  it('reports cleanup errors when failing an unavailable scheduled run also fails', async () => {
    const engine = new Engine({
      resolveWorkflowServices: async () => ({
        status: 'unavailable' as const,
        reason: 'missing service',
      }),
    });
    const cleanupErrors: Array<{ workflowId: string; message: string }> = [];

    try {
      const callbacks: Pick<
        ScheduleCallbacks,
        'failWorkflow' | 'handleCleanupError' | 'startWorkflow'
      > = {
        failWorkflow: async (workflowId, error) => {
          throw new Error(`${workflowId}:${error.message}`);
        },
        handleCleanupError: (source, error, workflowId) => {
          cleanupErrors.push({
            workflowId,
            message: `${source}:${error instanceof Error ? error.message : String(error)}`,
          });
        },
        startWorkflow: async () => {},
      };

      await startScheduledRun(
        getInternals(engine),
        {
          backfill: false,
          createdAt: 1,
          cronExpression: '* * * * *',
          id: 'schedule-cleanup-error',
          input: null,
          nextFireAt: 60_000,
          overlap: 'skip',
          queuedRuns: 0,
          status: 'active',
          updatedAt: 1,
          workflowType: 'workflow',
        },
        callbacks,
      );

      expect(cleanupErrors).toHaveLength(1);
      expect(cleanupErrors[0]!.workflowId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(cleanupErrors[0]!.message).toContain('startScheduledRun:');
    } finally {
      engine[Symbol.dispose]();
    }
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
    timeCallbacks.handleCleanupError(
      'time-cleanup',
      new Error('timer cleanup failed'),
      'workflow-time',
    );

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
    // Advance the logical clock past the retention window, then wait for the
    // sweep interval (5ms real time) to actually delete the record — a
    // condition-based wait instead of two fixed sleeps that flaked under load.
    now += 10;
    await waitForCondition(
      async () => (await storage.get(KEYS.workflow('workflow-retention-callback'))) === null,
      { label: 'retention sweep deleted the completed workflow' },
    );

    expect(await storage.get(KEYS.workflow('workflow-retention-callback'))).toBeNull();
    expect(internals.signalWaiters.has('workflow-retention-callback:done')).toBe(false);

    engine[Symbol.dispose]();
  });
});
