import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting, waitForCondition } from '../testing/fake-timers.test-support.ts';

import { decode, encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../worker/protocol.ts';
import { manifestForActivities } from '../worker/registry-fixtures.test-support.ts';
import type { WeftServer } from './index.ts';
import { serve } from './index.ts';
import type { InflightRecord, QueuedRecord, ResolvedRecord } from './task-state.ts';
import {
  getExclusiveTaskState,
  getTaskState,
  markInflight,
  markQueued,
  transitionInflightToQueued,
  transitionInflightToResolved,
  transitionQueuedToInflight,
} from './task-state.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueuedRecord(overrides: Partial<QueuedRecord> = {}): QueuedRecord {
  return {
    operationId: 'op-1',
    activityName: 'charge',
    input: { amount: 100 },
    queue: 'default',
    attempt: 1,
    visibilityTimeout: 30_000,
    queuedAt: Date.now(),
    ...overrides,
  };
}

function makeInflightRecord(overrides: Partial<InflightRecord> = {}): InflightRecord {
  return {
    operationId: 'op-1',
    workerId: 'worker-1',
    deadline: Date.now() + 30_000,
    activityName: 'charge',
    queue: 'default',
    input: { amount: 100 },
    attempt: 1,
    visibilityTimeout: 30_000,
    attemptToken: 'attempt-token',
    ...overrides,
  };
}

class GetCountingStorage extends MemoryStorage {
  readonly getCounts = new Map<string, number>();
  readonly readKeys: string[] = [];
  activeReads = 0;
  maxConcurrentReads = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    this.getCounts.set(key, (this.getCounts.get(key) ?? 0) + 1);
    this.readKeys.push(key);
    this.activeReads += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
    await Promise.resolve();
    try {
      return await super.get(key);
    } finally {
      this.activeReads -= 1;
    }
  }

  getCount(key: string): number {
    return this.getCounts.get(key) ?? 0;
  }

  resetReadTracking(): void {
    this.getCounts.clear();
    this.readKeys.length = 0;
    this.maxConcurrentReads = 0;
  }
}

function taskStateKey(state: 'inflight' | 'queued' | 'resolved', operationId: string): string {
  if (state === 'inflight') return KEYS.operationInflight(operationId);
  if (state === 'queued') return KEYS.operationQueued(operationId);
  return KEYS.operationResolved(operationId);
}

function createEngine(storage?: MemoryStorage): Engine {
  const s = storage ?? new MemoryStorage();
  const engine = new Engine({ storage: s });
  engine.register(echoWorkflow);
  return engine;
}

async function connectAndRegisterWorker(
  wsServer: WeftServer,
  options: { workerId: string; activities: string[]; concurrency?: number; queue?: string },
): Promise<WebSocket> {
  const queue = options.queue ?? 'default';
  const wsUrl = wsServer.url.replace('http://', 'ws://');
  const ws = new WebSocket(`${wsUrl}/v1/tasks/${encodeURIComponent(queue)}/stream`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
  });
  ws.send(
    JSON.stringify({
      type: 'register',
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerId: options.workerId,
      manifest: manifestForActivities(options.activities),
      concurrency: options.concurrency ?? 10,
    }),
  );
  await waitForCondition(() => wsServer.registry.getWorker(options.workerId) !== undefined, {
    timeoutMs: 5000,
    intervalMs: 25,
    label: `worker "${options.workerId}" to register`,
  });
  return ws;
}

// ---------------------------------------------------------------------------
// Unit tests: getTaskState and transitions
// ---------------------------------------------------------------------------

describe('getTaskState', () => {
  it('reads each state key once concurrently for every lookup shape', async () => {
    const storage = new GetCountingStorage();
    const keys = [
      KEYS.operationInflight('read-shape'),
      KEYS.operationQueued('read-shape'),
      KEYS.operationResolved('read-shape'),
    ];

    const cases = [
      { records: [], expected: null },
      { records: ['inflight'], expected: 'inflight' },
      { records: ['queued'], expected: 'queued' },
      { records: ['resolved'], expected: 'resolved' },
      { records: ['queued', 'resolved'], expected: 'queued' },
      { records: ['inflight', 'queued', 'resolved'], expected: 'inflight' },
    ] as const;

    for (const testCase of cases) {
      await storage.clear();
      for (const state of testCase.records) {
        await storage.put(taskStateKey(state, 'read-shape'), new Uint8Array([1]));
      }
      storage.resetReadTracking();

      await expect(getTaskState(storage, 'read-shape')).resolves.toBe(testCase.expected);
      expect(storage.readKeys).toEqual(keys);
      expect(storage.maxConcurrentReads).toBe(3);
      expect(storage.readKeys.every((key) => storage.getCount(key) === 1)).toBe(true);
    }
  });

  it('returns null for an unknown operation', async () => {
    const storage = new MemoryStorage();

    const state = await getTaskState(storage, 'nonexistent');

    expect(state).toBeNull();
  });

  it('returns "queued" when only a queued record exists', async () => {
    const storage = new MemoryStorage();
    await markQueued(storage, makeQueuedRecord());

    const state = await getTaskState(storage, 'op-1');

    expect(state).toBe('queued');
  });

  it('returns "inflight" when only an inflight record exists', async () => {
    const storage = new MemoryStorage();
    await markInflight(storage, makeInflightRecord());

    const state = await getTaskState(storage, 'op-1');

    expect(state).toBe('inflight');
  });

  it('returns "resolved" when only a resolved record exists', async () => {
    const storage = new MemoryStorage();
    await markInflight(storage, makeInflightRecord());
    await transitionInflightToResolved(storage, 'op-1', 'completed');

    const state = await getTaskState(storage, 'op-1');

    expect(state).toBe('resolved');
  });
});

describe('getExclusiveTaskState', () => {
  it('uses the same three-key snapshot for absent, single, partial, and all states', async () => {
    const storage = new GetCountingStorage();
    const cases = [
      { records: [], expected: null },
      { records: ['inflight'], expected: 'inflight' },
      { records: ['queued', 'resolved'], error: 'multiple states simultaneously' },
      { records: ['inflight', 'queued', 'resolved'], error: 'multiple states simultaneously' },
    ] as const;

    for (const testCase of cases) {
      await storage.clear();
      for (const state of testCase.records) {
        const key =
          state === 'inflight'
            ? KEYS.operationInflight('exclusive-read-shape')
            : state === 'queued'
              ? KEYS.operationQueued('exclusive-read-shape')
              : KEYS.operationResolved('exclusive-read-shape');
        await storage.put(key, new Uint8Array([1]));
      }
      storage.resetReadTracking();

      const lookup = getExclusiveTaskState(storage, 'exclusive-read-shape');
      if ('error' in testCase) {
        await expect(lookup).rejects.toThrow(testCase.error);
      } else {
        await expect(lookup).resolves.toBe(testCase.expected);
      }
      expect(storage.readKeys).toEqual([
        KEYS.operationInflight('exclusive-read-shape'),
        KEYS.operationQueued('exclusive-read-shape'),
        KEYS.operationResolved('exclusive-read-shape'),
      ]);
      expect(storage.maxConcurrentReads).toBe(3);
      expect(storage.readKeys.every((key) => storage.getCount(key) === 1)).toBe(true);
    }
  });

  it('returns null for an unknown operation', async () => {
    const storage = new MemoryStorage();

    const state = await getExclusiveTaskState(storage, 'nonexistent');

    expect(state).toBeNull();
  });

  it('throws when a task occupies multiple states', async () => {
    const storage = new MemoryStorage();
    // Manually write both queued and inflight records (simulating a bug)
    await storage.put(
      KEYS.operationQueued('op-bad'),
      encode(makeQueuedRecord({ operationId: 'op-bad' })),
    );
    await storage.put(
      KEYS.operationInflight('op-bad'),
      encode(makeInflightRecord({ operationId: 'op-bad' })),
    );

    expect(getExclusiveTaskState(storage, 'op-bad')).rejects.toThrow(
      'multiple states simultaneously',
    );
  });
});

// ---------------------------------------------------------------------------
// Atomic state transitions
// ---------------------------------------------------------------------------

describe('state transitions', () => {
  it('queued → inflight is atomic (queued key deleted, inflight key written)', async () => {
    const storage = new MemoryStorage();
    await markQueued(storage, makeQueuedRecord());

    await transitionQueuedToInflight(storage, 'op-1', makeInflightRecord());

    expect(await storage.get(KEYS.operationQueued('op-1'))).toBeNull();
    expect(await storage.get(KEYS.operationInflight('op-1'))).not.toBeNull();
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('inflight');
  });

  it('uses a provided queued record without rereading storage', async () => {
    const storage = new GetCountingStorage();
    const queuedRecord = makeQueuedRecord({
      firstQueuedAt: 1_000,
      lastQueuedAt: 1_000,
      retryCount: 2,
      requeueCount: 1,
    });
    await markQueued(storage, queuedRecord);

    const transitionedRecord = await transitionQueuedToInflight(
      storage,
      'op-1',
      makeInflightRecord(),
      {
        queuedRecord,
      },
    );

    expect(storage.getCount(KEYS.operationQueued('op-1'))).toBe(0);
    expect(transitionedRecord.firstQueuedAt).toBe(1_000);
    expect(transitionedRecord.retryCount).toBe(2);
    expect(transitionedRecord.requeueCount).toBe(1);
    const inflightRecord = decode(
      (await storage.get(KEYS.operationInflight('op-1')))!,
    ) as InflightRecord;
    expect(inflightRecord.firstQueuedAt).toBe(1_000);
    expect(inflightRecord.retryCount).toBe(2);
    expect(inflightRecord.requeueCount).toBe(1);
  });

  it('inflight → resolved is atomic (inflight key deleted, resolved key written)', async () => {
    const storage = new MemoryStorage();
    await markInflight(storage, makeInflightRecord());

    await transitionInflightToResolved(storage, 'op-1', 'completed');

    expect(await storage.get(KEYS.operationInflight('op-1'))).toBeNull();
    const resolvedValue = await storage.get(KEYS.operationResolved('op-1'));
    expect(resolvedValue).not.toBeNull();
    const resolvedRecord = decode(resolvedValue!) as ResolvedRecord;
    expect(
      await storage.get(KEYS.operationResolvedByTime(resolvedRecord.resolvedAt, 'op-1')),
    ).not.toBeNull();
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('resolved');
  });

  it('inflight → queued is atomic (inflight key deleted, queued key written)', async () => {
    const storage = new MemoryStorage();
    await markInflight(storage, makeInflightRecord());

    await transitionInflightToQueued(storage, 'op-1', makeQueuedRecord({ attempt: 2 }));

    expect(await storage.get(KEYS.operationInflight('op-1'))).toBeNull();
    expect(await storage.get(KEYS.operationQueued('op-1'))).not.toBeNull();
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('queued');
  });

  it('keeps retryable requeue distinct from terminal resolution', async () => {
    const storage = new MemoryStorage();
    await markInflight(storage, makeInflightRecord({ attempt: 2 }));

    await transitionInflightToQueued(storage, 'op-1', makeQueuedRecord({ attempt: 3 }));

    expect(await storage.get(KEYS.operationResolved('op-1'))).toBeNull();
    expect(await storage.get(KEYS.operationQueued('op-1'))).not.toBeNull();
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('queued');
  });

  it('full lifecycle: queued → inflight → resolved', async () => {
    const storage = new MemoryStorage();

    await markQueued(storage, makeQueuedRecord());
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('queued');

    await transitionQueuedToInflight(storage, 'op-1', makeInflightRecord());
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('inflight');

    await transitionInflightToResolved(storage, 'op-1', 'completed');
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('resolved');
  });

  it('requeue lifecycle: queued → inflight → queued → inflight → resolved', async () => {
    const storage = new MemoryStorage();

    await markQueued(storage, makeQueuedRecord());
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('queued');

    await transitionQueuedToInflight(storage, 'op-1', makeInflightRecord());
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('inflight');

    // Requeue (e.g., worker disconnected)
    await transitionInflightToQueued(storage, 'op-1', makeQueuedRecord({ attempt: 2 }));
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('queued');

    // Claimed again
    await transitionQueuedToInflight(
      storage,
      'op-1',
      makeInflightRecord({ workerId: 'worker-2', attempt: 2 }),
    );
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('inflight');

    await transitionInflightToResolved(storage, 'op-1', 'completed');
    expect(await getExclusiveTaskState(storage, 'op-1')).toBe('resolved');
  });

  it('failed resolution records the failure status', async () => {
    const storage = new MemoryStorage();
    await markInflight(storage, makeInflightRecord());

    await transitionInflightToResolved(storage, 'op-1', 'failed');

    const state = await getTaskState(storage, 'op-1');
    expect(state).toBe('resolved');
  });

  it('preserves lifecycle timings and retry counters through requeue and resolution', async () => {
    const storage = new MemoryStorage();
    const firstQueuedAt = 1_000;

    await markQueued(
      storage,
      makeQueuedRecord({
        operationId: 'metadata-op',
        queuedAt: firstQueuedAt,
        firstQueuedAt,
        lastQueuedAt: firstQueuedAt,
        retryCount: 0,
        requeueCount: 0,
      }),
    );

    await transitionQueuedToInflight(
      storage,
      'metadata-op',
      makeInflightRecord({
        operationId: 'metadata-op',
        firstQueuedAt,
        lastQueuedAt: firstQueuedAt,
        lastDispatchedAt: 1_100,
        startedAt: 1_120,
        lastHeartbeatAt: 1_180,
        retryCount: 0,
        requeueCount: 0,
      }),
    );

    await transitionInflightToQueued(
      storage,
      'metadata-op',
      makeQueuedRecord({
        operationId: 'metadata-op',
        attempt: 2,
        queuedAt: 1_300,
        firstQueuedAt,
        lastQueuedAt: 1_300,
        lastDispatchedAt: 1_100,
        startedAt: 1_120,
        retryCount: 1,
        requeueCount: 1,
        lastRequeueReason: 'visibility-timeout',
      }),
    );

    const queued = decode(
      (await storage.get(KEYS.operationQueued('metadata-op')))!,
    ) as QueuedRecord;
    expect(queued.firstQueuedAt).toBe(firstQueuedAt);
    expect(queued.lastQueuedAt).toBe(1_300);
    expect(queued.lastDispatchedAt).toBe(1_100);
    expect(queued.startedAt).toBe(1_120);
    expect(queued.lastHeartbeatAt).toBeUndefined();
    expect(queued.retryCount).toBe(1);
    expect(queued.requeueCount).toBe(1);
    expect(queued.lastRequeueReason).toBe('visibility-timeout');

    await transitionQueuedToInflight(
      storage,
      'metadata-op',
      makeInflightRecord({
        operationId: 'metadata-op',
        workerId: 'worker-2',
        attempt: 2,
        firstQueuedAt,
        lastQueuedAt: 1_300,
        lastDispatchedAt: 1_500,
        startedAt: 1_520,
        retryCount: 1,
        requeueCount: 1,
        lastRequeueReason: 'visibility-timeout',
      }),
    );

    await transitionInflightToResolved(storage, 'metadata-op', 'completed', {
      resolutionReason: 'completed',
      resolvedAt: 1_900,
    });

    const resolved = decode(
      (await storage.get(KEYS.operationResolved('metadata-op')))!,
    ) as ResolvedRecord;
    expect(await storage.get(KEYS.operationResolvedByTime(1_900, 'metadata-op'))).not.toBeNull();
    expect(resolved.firstQueuedAt).toBe(firstQueuedAt);
    expect(resolved.lastQueuedAt).toBe(1_300);
    expect(resolved.lastDispatchedAt).toBe(1_500);
    expect(resolved.startedAt).toBe(1_520);
    expect(resolved.completedAt).toBe(1_900);
    expect(resolved.lastHeartbeatAt).toBeUndefined();
    expect(resolved.retryCount).toBe(1);
    expect(resolved.requeueCount).toBe(1);
    expect(resolved.resolutionReason).toBe('completed');
    expect(resolved.queueLatencyMs).toBe(200);
    expect(resolved.executionLatencyMs).toBe(380);
  });
});

// ---------------------------------------------------------------------------
// Integration: task state through server dispatch lifecycle
// ---------------------------------------------------------------------------

describe('task state invariant (server integration)', () => {
  let engine: Engine;
  let storage: MemoryStorage;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  function setup(options: { workerReconnectGracePeriodMs?: number } = {}): void {
    storage = new MemoryStorage();
    engine = createEngine(storage);
    server = serve({ engine, port: 0, workerShutdownTimeoutMs: 50, ...options });
  }

  it('task dispatched to a WebSocket worker is in inflight state', async () => {
    setup();
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w1',
      activities: ['test.charge'],
    });

    await server.dispatchTask({ operationId: 'ws-op-1', activityName: 'test.charge', input: null });
    await sleepForTesting(50);

    const state = await getExclusiveTaskState(storage, 'ws-op-1');
    expect(state).toBe('inflight');

    ws.close();
    await sleepForTesting(50);
  });

  it('task dispatched with no workers is in queued state (durable)', async () => {
    setup();

    // No workers connected — task falls through to long-poll queue
    await server.dispatchTask({
      operationId: 'lp-op-1',
      activityName: 'charge',
      input: { amount: 50 },
    });
    await sleepForTesting(50);

    const state = await getExclusiveTaskState(storage, 'lp-op-1');
    expect(state).toBe('queued');
  });

  it('task completed via WebSocket transitions to resolved state', async () => {
    setup();
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w1',
      activities: ['test.charge'],
    });

    // Auto-respond with a completed result
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            attemptToken: msg.attemptToken,
            status: 'completed',
            value: 42,
          }),
        );
      }
    });

    await server.dispatchTask({
      operationId: 'ws-resolve-1',
      activityName: 'test.charge',
      input: null,
    });

    await waitForCondition(
      async () => (await getExclusiveTaskState(storage, 'ws-resolve-1')) === 'resolved',
      { timeoutMs: 5000, intervalMs: 25, label: 'ws-resolve-1 to reach resolved' },
    );

    const state = await getExclusiveTaskState(storage, 'ws-resolve-1');
    expect(state).toBe('resolved');

    ws.close();
    await sleepForTesting(50);
  });

  it('task is never in two states simultaneously after WS dispatch', async () => {
    setup();
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w1',
      activities: ['test.charge'],
    });

    await server.dispatchTask({
      operationId: 'excl-op-1',
      activityName: 'test.charge',
      input: null,
    });
    await sleepForTesting(50);

    // Task should be in exactly one state (inflight)
    const [queued, inflight, resolved] = await Promise.all([
      storage.get(KEYS.operationQueued('excl-op-1')),
      storage.get(KEYS.operationInflight('excl-op-1')),
      storage.get(KEYS.operationResolved('excl-op-1')),
    ]);

    const activeStates = [queued !== null, inflight !== null, resolved !== null].filter(Boolean);
    expect(activeStates).toHaveLength(1);

    ws.close();
    await sleepForTesting(50);
  });

  it('long-poll claimed task transitions from queued to inflight', async () => {
    setup();

    // Dispatch with no workers — goes to queued state
    await server.dispatchTask({
      operationId: 'lp-claim-1',
      activityName: 'charge',
      input: { x: 1 },
    });
    await sleepForTesting(50);

    expect(await getExclusiveTaskState(storage, 'lp-claim-1')).toBe('queued');

    // Long-poll worker claims the task
    const response = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=1000`);
    const task = (await response.json()) as { operationId: string } | null;

    expect(task).not.toBeNull();
    expect(task!.operationId).toBe('lp-claim-1');
    await sleepForTesting(50);

    // After claiming, the task should be inflight
    const state = await getExclusiveTaskState(storage, 'lp-claim-1');
    expect(state).toBe('inflight');
  });

  it('long-poll completed task transitions to resolved', async () => {
    setup();

    // Dispatch → queued
    await server.dispatchTask({ operationId: 'lp-done-1', activityName: 'charge', input: null });
    await sleepForTesting(50);

    // Claim via long-poll → inflight
    const claimResponse = await fetch(
      `${server.url}/v1/tasks/default?activity=charge&timeout=1000`,
    );
    const task = (await claimResponse.json()) as { workerId: string; attemptToken: string };
    await sleepForTesting(50);

    // Complete via POST → resolved
    await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'lp-done-1',
        workerId: task.workerId,
        attemptToken: task.attemptToken,
        status: 'completed',
        value: 'done',
      }),
    });
    await sleepForTesting(50);

    const state = await getExclusiveTaskState(storage, 'lp-done-1');
    expect(state).toBe('resolved');
  });

  it('worker disconnect requeues inflight task back to queued state', async () => {
    setup({ workerReconnectGracePeriodMs: 100 });
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w-disconnect',
      activities: ['test.charge'],
    });

    await server.dispatchTask({ operationId: 'dc-op-1', activityName: 'test.charge', input: null });
    await sleepForTesting(50);

    expect(await getTaskState(storage, 'dc-op-1')).toBe('inflight');

    // Disconnect the worker — task should be requeued
    ws.close();
    await waitForCondition(
      async () => (await storage.get(KEYS.operationInflight('dc-op-1'))) === null,
      {
        label: 'worker disconnect to clear the inflight task record',
        timeoutMs: 1_000,
        intervalMs: 5,
      },
    );
  });

  it('no task is lost: dispatched task is always findable in at least one state', async () => {
    setup();

    // Test both paths: WS dispatch and long-poll dispatch
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w-find',
      activities: ['test.ship'],
    });

    // WS task
    await server.dispatchTask({ operationId: 'find-ws-1', activityName: 'test.ship', input: null });
    // Long-poll task (no WS worker for 'charge')
    await server.dispatchTask({ operationId: 'find-lp-1', activityName: 'charge', input: null });
    await sleepForTesting(50);

    const wsState = await getTaskState(storage, 'find-ws-1');
    const lpState = await getTaskState(storage, 'find-lp-1');

    expect(wsState).not.toBeNull();
    expect(lpState).not.toBeNull();

    ws.close();
    await sleepForTesting(50);
  });
});
