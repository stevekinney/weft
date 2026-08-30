/**
 * `weft.task.queues.list` operation + REST binding — unit tests.
 *
 * Covers:
 * - REST GET succeeds with `system:read` and reports backlog, oldest
 *   queued age, waiting pollers, scheduling policy, in-flight, and
 *   connected workers per queue, sorted by queue name.
 * - Idle queues — connected workers with no pending tasks and no
 *   waiters — still appear in the response.
 * - Authorization: 401 unauthenticated, 403 missing scope, 200 with
 *   scope.
 * - The operation reads the clock exactly once per request, applying the
 *   same `now` to every `oldestQueuedAgeMs`.
 * - Discovery-only registry: `invoke` throws so a misconfigured server
 *   surfaces the error instead of silently returning bogus data.
 * - The waiter test parks a poll on a separate queue with an activity
 *   that cannot match any pending task, so the waiter count is
 *   independent of backlog dequeue behavior.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from '../../worker/registry-fixtures.test-support.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import type { PendingTask } from '../task-queue-types.ts';
import { TaskQueue } from '../task-queue.ts';
import {
  createListTaskQueuesOperation,
  createListTaskQueuesRestBinding,
  listTaskQueuesOperation,
  mergeQueueHealth,
} from './list-task-queues.ts';
import {
  assertOperationRejectsInsufficientScope,
  assertOperationRejectsUnauthenticated,
  createOperationTestEngine,
  systemReadAuthContext,
} from './operation-registry-test-helpers.test-support.ts';

function pinnedTask(operationId: string, activityName: string, enqueuedAt: number): PendingTask {
  return { operationId, activityName, input: {}, enqueuedAt };
}

const binding = createListTaskQueuesRestBinding();

describe('weft.task.queues.list — REST GET /v1/task-queues', () => {
  let engine: Engine | undefined;
  let pendingPolls: AbortController[] = [];
  let outstandingPolls: Promise<unknown>[] = [];

  afterEach(async () => {
    for (const controller of pendingPolls) controller.abort();
    await Promise.all(outstandingPolls);
    pendingPolls = [];
    outstandingPolls = [];
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('reports backlog, oldest queued age, in-flight, waiting pollers, and idle-worker queues', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    // queue-a: has backlog + a connected worker carrying one in-flight task.
    workerRegistry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'w-a',
      queue: 'queue-a',
      activities: ['activity-A'],
      concurrency: 4,
    });
    workerRegistry.assignTask('w-a', 'op-inflight', 30_000, undefined, 'attempt-token');
    taskQueue.enqueue('queue-a', pinnedTask('op-a1', 'activity-A', 1000));
    taskQueue.enqueue('queue-a', pinnedTask('op-a2', 'activity-A', 500));

    // queue-b: parked waiter on a non-matching activity so it does not
    // consume any pending task. Worker on queue-b is registered too so
    // connectedWorkers > 0.
    workerRegistry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'w-b',
      queue: 'queue-b',
      activities: ['activity-B'],
      concurrency: 1,
    });
    const controller = new AbortController();
    pendingPolls.push(controller);
    outstandingPolls.push(
      taskQueue.poll('queue-b', ['no-such-activity'], 30_000, controller.signal),
    );
    // Yield so the waiter registers before we snapshot.
    await Promise.resolve();

    // queue-c: idle queue with a connected worker, no backlog, no waiters.
    workerRegistry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'w-c',
      queue: 'queue-c',
      activities: ['activity-C'],
      concurrency: 2,
    });

    const FIXED_NOW = 10_000;
    const operation = createListTaskQueuesOperation({
      workerRegistry,
      taskQueue,
      clock: () => FIXED_NOW,
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/task-queues', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([operation]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };

    expect(body.items.map((item) => item['queue'])).toEqual(['queue-a', 'queue-b', 'queue-c']);
    expect(body.items[0]).toEqual({
      queue: 'queue-a',
      backlog: 2,
      oldestEnqueuedAt: 500,
      oldestQueuedAgeMs: 9500,
      waitingPollers: 0,
      schedulingPolicy: 'priority',
      inFlight: 1,
      connectedWorkers: 1,
    });
    expect(body.items[1]).toEqual({
      queue: 'queue-b',
      backlog: 0,
      oldestEnqueuedAt: null,
      oldestQueuedAgeMs: null,
      waitingPollers: 1,
      schedulingPolicy: 'priority',
      inFlight: 0,
      connectedWorkers: 1,
    });
    expect(body.items[2]).toEqual({
      queue: 'queue-c',
      backlog: 0,
      oldestEnqueuedAt: null,
      oldestQueuedAgeMs: null,
      waitingPollers: 0,
      schedulingPolicy: 'priority',
      inFlight: 0,
      connectedWorkers: 1,
    });
  });

  it('rejects unauthenticated callers with 401', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await assertOperationRejectsUnauthenticated({
      operationName: 'weft.task.queues.list',
      engine,
      liveRegistry: createLiveOperationRegistry({ workerRegistry, taskQueue }),
    });
  });

  it('rejects callers without system:read with 403', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await assertOperationRejectsInsufficientScope({
      operationName: 'weft.task.queues.list',
      engine,
      liveRegistry: createLiveOperationRegistry({ workerRegistry, taskQueue }),
    });
  });
});

describe('weft.task.queues.list — operation behavior', () => {
  it('invokes the clock exactly once per request', async () => {
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();
    taskQueue.enqueue('alpha', pinnedTask('a1', 'work', 100));
    taskQueue.enqueue('alpha', pinnedTask('a2', 'work', 50));
    taskQueue.enqueue('beta', pinnedTask('b1', 'work', 200));

    let calls = 0;
    const operation = createListTaskQueuesOperation({
      workerRegistry,
      taskQueue,
      clock: () => {
        calls += 1;
        return 1000;
      },
    });

    const engine = createOperationTestEngine();
    try {
      const result = await executeOperation(
        'weft.task.queues.list',
        {},
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry: createOperationRegistry([operation]),
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(calls).toBe(1);
      const items = (result.value as { items: Array<{ oldestQueuedAgeMs: number | null }> }).items;
      // alpha's oldest is 50, beta's oldest is 200; both derived against FIXED 1000.
      expect(items.map((item) => item.oldestQueuedAgeMs)).toEqual([950, 800]);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('throws EngineFailure when invoked from a discovery-only registry', async () => {
    const engine = createOperationTestEngine();
    try {
      const result = await executeOperation(
        'weft.task.queues.list',
        {},
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry: createOperationRegistry([listTaskQueuesOperation]),
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.fault.code).toBe('EngineFailure');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('mergeQueueHealth', () => {
  it('joins worker-load and queue-entries into a sorted, idempotent shape', () => {
    const merged = mergeQueueHealth({
      now: 500,
      workerSummaries: [
        {
          id: 'w1',
          queue: 'orders',
          activities: ['charge'],
          concurrency: 5,
          inFlight: 2,
          availableCapacity: 3,
          connectedAt: 0,
          lastHeartbeatAt: 0,
          heartbeatAgeMs: 0,
          startedAt: 0,
          capabilities: {},
          health: 'active',
        },
        {
          id: 'w2',
          queue: 'orders',
          activities: ['charge'],
          concurrency: 4,
          inFlight: 1,
          availableCapacity: 3,
          connectedAt: 0,
          lastHeartbeatAt: 0,
          heartbeatAgeMs: 0,
          startedAt: 0,
          capabilities: {},
          health: 'active',
        },
      ],
      queueEntries: [
        {
          queue: 'orders',
          backlog: 3,
          oldestEnqueuedAt: 100,
          waitingPollers: 1,
          schedulingPolicy: 'fifo',
        },
      ],
      schedulingPolicy: 'priority',
    });
    expect(merged).toEqual([
      {
        queue: 'orders',
        backlog: 3,
        oldestEnqueuedAt: 100,
        oldestQueuedAgeMs: 400,
        waitingPollers: 1,
        schedulingPolicy: 'fifo',
        inFlight: 3,
        connectedWorkers: 2,
      },
    ]);
  });

  it('uses the fallback scheduling policy for queues sourced only from worker registrations', () => {
    const merged = mergeQueueHealth({
      now: 100,
      workerSummaries: [
        {
          id: 'w1',
          queue: 'idle',
          activities: ['x'],
          concurrency: 1,
          inFlight: 0,
          availableCapacity: 1,
          connectedAt: 0,
          lastHeartbeatAt: 0,
          heartbeatAgeMs: 0,
          startedAt: 0,
          capabilities: {},
          health: 'active',
        },
      ],
      queueEntries: [],
      schedulingPolicy: 'lifo',
    });
    expect(merged).toEqual([
      {
        queue: 'idle',
        backlog: 0,
        oldestEnqueuedAt: null,
        oldestQueuedAgeMs: null,
        waitingPollers: 0,
        schedulingPolicy: 'lifo',
        inFlight: 0,
        connectedWorkers: 1,
      },
    ]);
  });
});
