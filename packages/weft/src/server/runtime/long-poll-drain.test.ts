/**
 * Long-poll drain: tasks that fell back to the long-poll queue while no
 * WebSocket worker could take them move onto one as soon as one can.
 *
 * The end-to-end cases drive a real `serve()` and a raw WebSocket worker with
 * periodic reconciliation disabled, so the drain is the only thing that can
 * move a task. Every wait is on a frame or a durable state change; a frame
 * that never arrives is a hang the per-test timeout reports.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { RemoteTaskRecord } from '../../core/task-ledger/task-ledger-types.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
} from '../../core/task-ledger/task-ledger.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createDeferred } from '../../testing/fake-timers.test-support.ts';
import {
  connectFaultInjectingWorker,
  type FaultInjectingWorker,
} from '../../testing/worker-fault-injection.test-support.ts';
import type { TaskMessage } from '../../worker/protocol.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../../worker/protocol.ts';
import {
  manifestForActivities,
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from '../../worker/registry-fixtures.test-support.ts';
import { serve, type ServeOptions, type WeftServer } from '../index.ts';
import type { PendingTask } from '../task-queue-types.ts';
import { drainLongPollQueue, drainLongPollQueueInBackground } from './long-poll-drain.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { useManualTaskReconciliationForTesting } from './task-reconciliation.ts';

const ACTIVITY = 'test.echo';

let engine: Engine | undefined;
let server: WeftServer | undefined;
const workers: FaultInjectingWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.hardClose();
  await server?.stop();
  server = undefined;
  engine?.[Symbol.dispose]();
  engine = undefined;
});

async function startServer(): Promise<WeftServer> {
  engine = new Engine({ storage: new MemoryStorage() });
  const options = { engine, port: 0, unauthenticatedAccess: 'allow' } satisfies ServeOptions;
  useManualTaskReconciliationForTesting(options);
  server = serve(options);
  await server.ready;
  return server;
}

async function registerWorker(
  running: WeftServer,
  workerId: string,
  concurrency: number,
): Promise<FaultInjectingWorker> {
  const worker = await connectFaultInjectingWorker({
    url: `${running.url.replace(/^http/, 'ws').replace(/\/?$/, '/')}v1/tasks/default/stream`,
    workerId,
  });
  workers.push(worker);
  worker.send({
    type: 'register',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId,
    manifest: manifestForActivities([ACTIVITY]),
    concurrency,
  });
  await worker.nextServerMessage((message) => message.type === 'registerAck');
  return worker;
}

async function nextTask(worker: FaultInjectingWorker, operationId: string): Promise<TaskMessage> {
  const message = await worker.nextServerMessage(
    (candidate) => candidate.type === 'task' && candidate.operationId === operationId,
  );
  if (message.type !== 'task') throw new Error('unreachable');
  return message;
}

async function readRecord(operationId: string): Promise<RemoteTaskRecord | null> {
  if (engine === undefined) throw new Error('no engine');
  return decodeRemoteTaskRecord(await engine.storage.get(taskLedgerKey(operationId)));
}

function dispatch(running: WeftServer, operationId: string): Promise<boolean> {
  return running.dispatchTask({
    operationId,
    activityName: ACTIVITY,
    workflowType: 'test',
    input: null,
  });
}

describe('long-poll drain onto WebSocket workers', () => {
  it('hands a task that fell back before any worker connected to the first worker that registers', async () => {
    const running = await startServer();

    expect(await dispatch(running, 'before-any-worker')).toBe(true);
    expect(running.taskQueue.isTracked('before-any-worker')).toBe(true);
    const beforeRegistration = await readRecord('before-any-worker');
    expect(beforeRegistration?.state).toBe('queued');

    const worker = await registerWorker(running, 'late-worker', 1);
    const task = await nextTask(worker, 'before-any-worker');

    expect(running.taskQueue.isTracked('before-any-worker')).toBe(false);
    expect(running.registry.isAssigned('before-any-worker')).toBe(true);
    expect(await readRecord('before-any-worker')).toMatchObject({
      state: 'leased',
      workerSessionId: 'late-worker',
      attemptToken: task.attemptToken,
    });
  });

  it('hands a task that fell back while the worker was at capacity to the slot its next result frees', async () => {
    const running = await startServer();
    const worker = await registerWorker(running, 'busy-worker', 1);

    expect(await dispatch(running, 'first')).toBe(true);
    const first = await nextTask(worker, 'first');
    expect(await dispatch(running, 'second')).toBe(true);
    expect(running.taskQueue.isTracked('second')).toBe(true);

    worker.send({
      type: 'taskResult',
      operationId: 'first',
      status: 'completed',
      value: 'done',
      attemptToken: first.attemptToken,
    });
    const second = await nextTask(worker, 'second');

    expect(running.taskQueue.isTracked('second')).toBe(false);
    expect(await readRecord('second')).toMatchObject({
      state: 'leased',
      attemptToken: second.attemptToken,
    });
  });
});

describe('drainLongPollQueue', () => {
  // Each bare context owns a TaskQueue whose pending hints arm a real
  // expiration timer; nothing else disposes it, so every test's queue is
  // disposed here (COR-1343).
  const contexts: Array<ReturnType<typeof minimalServerContext>> = [];
  afterEach(() => {
    for (const context of contexts.splice(0)) context.taskQueue[Symbol.dispose]();
  });

  function contextWithIdleWebSocketWorker() {
    const context = minimalServerContext();
    contexts.push(context);
    context.registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'idle-worker',
      queue: 'default',
      activities: [ACTIVITY],
      concurrency: 1,
    });
    context.workerSockets.set('idle-worker', {} as never);
    return context;
  }

  function hint(operationId: string): PendingTask {
    return { operationId, activityName: ACTIVITY, input: null, attempt: 1 };
  }

  it('discards a hint whose ledger record is no longer queued', async () => {
    const context = contextWithIdleWebSocketWorker();
    const options = minimalServeOptions();
    context.taskQueue.enqueue('default', hint('never-recorded'));

    await drainLongPollQueue(context, options, 'default');

    expect(context.taskQueue.isTracked('never-recorded')).toBe(false);
    expect(context.registry.isAssigned('never-recorded')).toBe(false);
  });

  it('restores a hint in place when its dispatch does not land', async () => {
    const context = contextWithIdleWebSocketWorker();
    const options = minimalServeOptions();
    // Queued, but its retry backoff has not elapsed, so the claim is refused.
    const notYetAvailable = {
      recordVersion: 1,
      operationId: 'backing-off',
      workflowType: 'test',
      workflowExecutionToken: 'token-1',
      activityName: ACTIVITY,
      queue: 'default',
      input: null,
      headers: {},
      visibilityTimeoutMilliseconds: 30_000,
      createdAt: 1_000,
      generation: 2,
      state: 'queued',
      attempt: 2,
      availableAt: Date.now() + 60_000,
      firstQueuedAt: 1_000,
      lastQueuedAt: 1_000,
      retryCount: 1,
      requeueCount: 1,
    } satisfies RemoteTaskRecord;
    await options.engine.storage.put(
      taskLedgerKey('backing-off'),
      encodeRemoteTaskRecord(notYetAvailable),
    );
    context.taskQueue.enqueue('default', hint('ahead'), () => {});
    context.taskQueue.enqueue('default', hint('backing-off'));

    await drainLongPollQueue(context, options, 'default');

    expect(context.taskQueue.peekPending('default').map((task) => task.operationId)).toEqual([
      'ahead',
      'backing-off',
    ]);
    expect(context.registry.isAssigned('backing-off')).toBe(false);
    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey('backing-off'))),
    ).toEqual(notYetAvailable);
  });

  it('keeps draining past a hint whose dispatch does not land', async () => {
    const context = contextWithIdleWebSocketWorker();
    context.workerSockets.set('idle-worker', { send: () => 1 } as never);
    const options = minimalServeOptions();
    const queuedRecord = (operationId: string, availableAt: number) =>
      ({
        recordVersion: 1,
        operationId,
        workflowType: 'test',
        workflowExecutionToken: 'token-1',
        activityName: ACTIVITY,
        queue: 'default',
        input: null,
        headers: {},
        visibilityTimeoutMilliseconds: 30_000,
        createdAt: 1_000,
        generation: 1,
        state: 'queued',
        attempt: 1,
        availableAt,
        firstQueuedAt: 1_000,
        lastQueuedAt: 1_000,
        retryCount: 0,
        requeueCount: 0,
      }) satisfies RemoteTaskRecord;
    await options.engine.storage.put(
      taskLedgerKey('backing-off'),
      encodeRemoteTaskRecord(queuedRecord('backing-off', Date.now() + 60_000)),
    );
    await options.engine.storage.put(
      taskLedgerKey('claimable'),
      encodeRemoteTaskRecord(queuedRecord('claimable', 0)),
    );
    context.taskQueue.enqueue('default', hint('backing-off'));
    context.taskQueue.enqueue('default', hint('claimable'));

    await drainLongPollQueue(context, options, 'default');

    expect(context.registry.isAssigned('claimable')).toBe(true);
    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey('claimable')))?.state,
    ).toBe('leased');
    expect(context.taskQueue.peekPending('default').map((task) => task.operationId)).toEqual([
      'backing-off',
    ]);
  });

  it('folds a trigger that arrives mid-drain into the running drain', async () => {
    const context = contextWithIdleWebSocketWorker();
    const options = minimalServeOptions();
    context.taskQueue.enqueue('default', hint('stale-1'));

    const running = drainLongPollQueue(context, options, 'default');
    context.taskQueue.enqueue('default', hint('stale-2'));
    await drainLongPollQueue(context, options, 'default');
    expect(context.longPollDrains.get('default')?.rerun).toBe(true);

    await running;

    expect(context.longPollDrains.has('default')).toBe(false);
    expect(context.taskQueue.pendingCount('default')).toBe(0);
  });

  it('moves nothing once the server is stopping', async () => {
    const context = { ...contextWithIdleWebSocketWorker(), stopping: true };
    context.taskQueue.enqueue('default', hint('left-for-recovery'));

    await drainLongPollQueue(context, minimalServeOptions(), 'default');

    expect(context.taskQueue.isTracked('left-for-recovery')).toBe(true);
  });

  it('logs a move that fails and restores its hint', async () => {
    const context = contextWithIdleWebSocketWorker();
    const options = minimalServeOptions();
    context.taskQueue.enqueue('default', hint('unreadable'));
    using readSpy = spyOn(options.engine.storage, 'get').mockRejectedValue(
      new Error('storage down'),
    );
    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    await drainLongPollQueue(context, options, 'default');

    expect(readSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[weft] Failed to move long-poll task "unreadable" to a worker:',
      expect.any(Error),
    );
    expect(context.taskQueue.isTracked('unreadable')).toBe(true);
    expect(context.taskQueue.pendingCount('default')).toBe(1);
  });

  it('logs a background drain that fails outright instead of rejecting', async () => {
    const context = contextWithIdleWebSocketWorker();
    using _withdrawSpy = spyOn(context.taskQueue, 'withdrawPending').mockImplementation(() => {
      throw new Error('queue broken');
    });
    const logged = createDeferred<unknown[]>();
    using _errorSpy = spyOn(console, 'error').mockImplementation((...parameters: unknown[]) => {
      logged.resolve(parameters);
    });

    drainLongPollQueueInBackground(context, minimalServeOptions(), 'default');

    expect(await logged.promise).toEqual([
      '[weft] Long-poll drain of queue "default" failed:',
      expect.any(Error),
    ]);
    expect(context.longPollDrains.has('default')).toBe(false);
  });
});
