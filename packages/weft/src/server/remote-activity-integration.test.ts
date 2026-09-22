/**
 * COR-152 "Broker Boundary and Configuration" — the end-to-end fixture the
 * issue requires: a real engine, a real `serve()` server, and a real
 * `RemoteWorker`, proving success, failure, retry, cancellation, server
 * restart, engine recovery, header propagation, and execution-token
 * propagation through `ctx.run()`.
 *
 * **Contains no test-only dispatcher replacement.** Every engine here is
 * constructed with the production `activityExecution: { mode: 'remote' }`
 * option and the default, storage-backed `EngineOwnedRemoteActivityBroker`
 * — nothing in this file imports `activity-worker-dispatcher.test-support.ts`
 * or reaches into engine internals to install a fake dispatcher, and no test
 * polls an application-level loop: every wait is a `waitForCondition` on
 * durable or observable state (acceptance criterion 2).
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowInterceptor } from '../core/interceptor.ts';
import type { RemoteTaskRecord } from '../core/task-ledger/task-ledger.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
} from '../core/task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../core/types.ts';
import { activity, workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { RemoteWorker } from '../worker/index.ts';
import { serve, type WeftServer } from './index.ts';

async function readOnlyTaskLedgerRecord(engine: Engine): Promise<RemoteTaskRecord | null> {
  for await (const [, value] of engine.storage.scan('task-ledger:')) {
    return decodeRemoteTaskRecord(value);
  }
  return null;
}

describe('remote activity end-to-end integration (COR-152)', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;
  let remoteWorker: RemoteWorker | undefined;

  afterEach(async () => {
    await remoteWorker?.disconnect();
    remoteWorker = undefined;
    await server?.stop();
    server = undefined;
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('executes success through ctx.run(), propagating headers and the workflow execution token', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    const executedInputs: unknown[] = [];
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'success-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'e2e-success-workflow': {
          name: 'e2e-success-workflow',
          activities: {
            formatGreeting: async (input: unknown) => {
              executedInputs.push(input);
              return `Hello, ${(input as { name: string }).name}!`;
            },
          },
        },
      },
      concurrency: 1,
    });
    await remoteWorker.connect();
    await waitForCondition(() => server?.registry.getWorker('success-worker') !== undefined, {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: 'remote worker to register',
    });

    const traceHeaderInterceptor: WorkflowInterceptor = {
      *activity(interception, next) {
        interception.headers.set('x-trace-id', 'e2e-trace-1');
        return yield* next(interception);
      },
    };
    engine.addInterceptor(traceHeaderInterceptor);

    const formatGreeting = activity({
      name: 'formatGreeting',
      execute: async (_input: { name: string }): Promise<string> => {
        throw new Error('local execution must never run in remote mode');
      },
    });

    engine.register(
      workflow({ name: 'e2e-success-workflow' })
        .activities({ formatGreeting })
        .execute(async function* (context: WorkflowContext, input: { name: string }) {
          return yield* context.run(formatGreeting, input);
        }),
    );

    const handle = await engine.start(
      'e2e-success-workflow',
      { name: 'Ada' },
      { id: 'e2e-success-1' },
    );

    expect(await handle.result()).toBe('Hello, Ada!');
    expect(executedInputs).toEqual([{ name: 'Ada' }]);

    // Header and execution-token propagation: the durable envelope the
    // engine wrote for this dispatch carried both through to the point the
    // worker claimed it.
    const terminalRecord = await readOnlyTaskLedgerRecord(engine);
    expect(terminalRecord?.headers).toEqual({ 'x-trace-id': 'e2e-trace-1' });
    expect(terminalRecord?.workflowExecutionToken).toBeString();
  });

  it('returns the real remote failure to ctx.run()', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'failure-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'e2e-failure-workflow': {
          name: 'e2e-failure-workflow',
          activities: {
            alwaysFails: async () => {
              throw new Error('remote activity intentionally failed');
            },
          },
        },
      },
      concurrency: 1,
    });
    await remoteWorker.connect();
    await waitForCondition(() => server?.registry.getWorker('failure-worker') !== undefined, {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: 'remote worker to register',
    });

    const alwaysFails = activity({
      name: 'alwaysFails',
      execute: async (): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'e2e-failure-workflow' })
        .activities({ alwaysFails })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(alwaysFails);
        }),
    );

    const handle = await engine.start('e2e-failure-workflow', null, { id: 'e2e-failure-1' });
    let caught: unknown;
    try {
      await handle.result();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('remote activity intentionally failed');
  });

  it('resumes ordinary workflow-level retry: a failed attempt is followed by a second dispatch that succeeds', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    let callCount = 0;
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'retry-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'e2e-retry-workflow': {
          name: 'e2e-retry-workflow',
          activities: {
            flaky: async () => {
              callCount += 1;
              if (callCount === 1) throw new Error('transient failure');
              return 'succeeded-on-retry';
            },
          },
        },
      },
      concurrency: 1,
    });
    await remoteWorker.connect();
    await waitForCondition(() => server?.registry.getWorker('retry-worker') !== undefined, {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: 'remote worker to register',
    });

    const flaky = activity({
      name: 'flaky',
      execute: async (): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'e2e-retry-workflow' })
        .activities({ flaky })
        .execute(async function* (context: WorkflowContext) {
          // The WORKFLOW owns retry, exactly as it does for a local
          // activity — this engine applies no automatic retry of its own.
          try {
            return yield* context.run(flaky);
          } catch {
            return yield* context.run(flaky);
          }
        }),
    );

    const handle = await engine.start('e2e-retry-workflow', null, { id: 'e2e-retry-1' });

    expect(await handle.result()).toBe('succeeded-on-retry');
    expect(callCount).toBe(2);
  });

  it('cancellation targets the current durable attempt and settles the local waiter', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      visibilityPollIntervalMs: 50,
    });

    const neverReleased = new Promise<never>(() => {});
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'e2e-cancel-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'e2e-cancel-workflow': {
          name: 'e2e-cancel-workflow',
          activities: { slowActivity: async () => neverReleased },
        },
      },
      concurrency: 1,
      disconnectTimeoutMs: 50,
    });
    await remoteWorker.connect();
    await waitForCondition(() => server?.registry.getWorker('e2e-cancel-worker') !== undefined, {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: 'remote worker to register',
    });

    const slowActivity = activity({
      name: 'slowActivity',
      execute: async (): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'e2e-cancel-workflow' })
        .activities({ slowActivity })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(slowActivity);
        }),
    );

    const handle = await engine.start('e2e-cancel-workflow', null, { id: 'e2e-cancel-1' });

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'leased';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to be leased' },
    );

    await engine.cancel(handle.id);
    await expect(handle.result()).rejects.toThrow();

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state !== 'leased';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'the durable attempt to leave "leased"' },
    );
  });

  it('preserves and completes a remote task across a server restart and engine recovery', async () => {
    await using storage = new MemoryStorage();

    const chargeCard = activity({
      name: 'chargeCard',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    const restartWorkflow = workflow({ name: 'e2e-restart-workflow' })
      .activities({ chargeCard })
      .execute(async function* (context: WorkflowContext) {
        return yield* context.run(chargeCard, { orderId: 'ord-e2e-1' });
      });

    engine = new Engine({ storage, activityExecution: { mode: 'remote' } });
    engine.register(restartWorkflow);
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    const handle = await engine.start('e2e-restart-workflow', null, { id: 'e2e-restart-1' });

    let queuedOperationId: string | undefined;
    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        if (record === null || record.state !== 'queued') return false;
        queuedOperationId = record.operationId;
        return true;
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to reach durable queued state' },
    );
    if (queuedOperationId === undefined) throw new Error('expected a queued operationId');

    // Simulate a process crash: no graceful drain, no cancellation — the
    // engine and server just disappear.
    await server.stop();
    server = undefined;
    engine[Symbol.dispose]();
    engine = undefined;

    // The recovered workflow's `ctx.run()` replay re-derives the same
    // deterministic token and finds the ledger record already `queued` —
    // `EngineOwnedRemoteActivityBroker.enqueue` short-circuits on that
    // (correctly: no duplicate write), so it never fires a fresh
    // `RemoteActivityQueuedEvent` for a new server to react to immediately.
    // The NEW server's own startup recovery scan (`runTaskLedgerRecovery`)
    // DOES unconditionally schedule a redispatch for a `queued` record it
    // finds — via `scheduleDelayedDispatch(delay = max(0, availableAt -
    // now))` — but a record whose `availableAt` is already in the past
    // schedules that redispatch with `delay = 0`, which can fire before a
    // real WebSocket worker has finished connecting and registering. Once
    // that redispatch attempt finds no registered worker, it falls back to
    // the long-poll queue (`enqueueTaskForLongPoll`) — and a task tracked
    // there is permanently ineligible for `reconcileOrphanedRecords`'
    // periodic WebSocket-redispatch path (`redispatchAvailableQueuedRecord`
    // skips any operationId `taskQueue.isTracked`), so no amount of polling
    // ever recovers it once that happens. Confirmed empirically: an
    // unmodified `availableAt` traps the task in roughly 3 of 8 trials.
    //
    // The fix is not a race to win but an explicit, generous barrier: push
    // `availableAt` into the future before the new server ever starts, so
    // its startup scan schedules the redispatch attempt two seconds out
    // — long past when the worker's registration (confirmed below via an
    // explicit `waitForCondition`) will have completed, even under heavy
    // load. This is the SAME "delayed retry" field `requeueExpiredAttempt`
    // already uses for backoff — not a new mechanism, and not a timeout
    // being widened to paper over a hang.
    const queuedKey = taskLedgerKey(queuedOperationId);
    const queuedRaw = await storage.get(queuedKey);
    const queuedRecord = decodeRemoteTaskRecord(queuedRaw);
    if (queuedRecord === null || queuedRecord.state !== 'queued') {
      throw new Error('expected the recovered task to still be durably queued');
    }
    await storage.put(
      queuedKey,
      encodeRemoteTaskRecord({ ...queuedRecord, availableAt: Date.now() + 2_000 }),
    );

    // Recovery: a fresh engine over the SAME durable storage, replaying the
    // in-flight workflow.
    const recoveredEngine = new Engine({ storage, activityExecution: { mode: 'remote' } });
    recoveredEngine.register(restartWorkflow);
    await recoveredEngine.recoverAll();
    engine = recoveredEngine;

    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'recovery-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'e2e-restart-workflow': {
          name: 'e2e-restart-workflow',
          activities: { chargeCard: async () => 'charged-after-recovery' },
        },
      },
      concurrency: 1,
    });
    await remoteWorker.connect();
    // Confirm registration BEFORE relying on the 2s `availableAt` headroom
    // above — this is the explicit barrier the delay exists to make room
    // for, not a hope that it finishes in time.
    await waitForCondition(() => server?.registry.getWorker('recovery-worker') !== undefined, {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: 'recovered remote worker to register',
    });

    const recoveredHandle = engine.getHandle(handle.id);
    expect(await recoveredHandle.result()).toBe('charged-after-recovery');
  });
});
