import { afterEach, describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { WeftServer } from './index.ts';
import { serve } from './index.ts';
import type { InflightRecord, QueuedRecord } from './task-state.ts';
import {
  getExclusiveTaskState,
  getTaskState,
  markInflight,
  markQueued,
  transitionInflightToQueued,
  transitionInflightToResolved,
  transitionQueuedToInflight,
} from './task-state.ts';

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
    ...overrides,
  };
}

function createEngine(storage?: MemoryStorage): Engine {
  const s = storage ?? new MemoryStorage();
  const engine = new Engine({ storage: s });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
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
      workerId: options.workerId,
      activities: options.activities,
      concurrency: options.concurrency ?? 10,
    }),
  );
  await Bun.sleep(50);
  return ws;
}

// ---------------------------------------------------------------------------
// Unit tests: getTaskState and transitions
// ---------------------------------------------------------------------------

describe('getTaskState', () => {
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

  it('inflight → resolved is atomic (inflight key deleted, resolved key written)', async () => {
    const storage = new MemoryStorage();
    await markInflight(storage, makeInflightRecord());

    await transitionInflightToResolved(storage, 'op-1', 'completed');

    expect(await storage.get(KEYS.operationInflight('op-1'))).toBeNull();
    expect(await storage.get(KEYS.operationResolved('op-1'))).not.toBeNull();
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
});

// ---------------------------------------------------------------------------
// Integration: task state through server dispatch lifecycle
// ---------------------------------------------------------------------------

describe('task state invariant (server integration)', () => {
  let engine: Engine;
  let storage: MemoryStorage;
  let server: WeftServer;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  function setup(): void {
    storage = new MemoryStorage();
    engine = createEngine(storage);
    server = serve({ engine, port: 0 });
  }

  it('task dispatched to a WebSocket worker is in inflight state', async () => {
    setup();
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w1',
      activities: ['charge'],
    });

    server.dispatchTask({ operationId: 'ws-op-1', activityName: 'charge', input: null });
    await Bun.sleep(50);

    const state = await getExclusiveTaskState(storage, 'ws-op-1');
    expect(state).toBe('inflight');

    ws.close();
    await Bun.sleep(50);
  });

  it('task dispatched with no workers is in queued state (durable)', async () => {
    setup();

    // No workers connected — task falls through to long-poll queue
    server.dispatchTask({ operationId: 'lp-op-1', activityName: 'charge', input: { amount: 50 } });
    await Bun.sleep(50);

    const state = await getExclusiveTaskState(storage, 'lp-op-1');
    expect(state).toBe('queued');
  });

  it('task completed via WebSocket transitions to resolved state', async () => {
    setup();
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w1',
      activities: ['charge'],
    });

    // Auto-respond with a completed result
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: 42,
          }),
        );
      }
    });

    server.dispatchTask({ operationId: 'ws-resolve-1', activityName: 'charge', input: null });
    await Bun.sleep(150);

    const state = await getExclusiveTaskState(storage, 'ws-resolve-1');
    expect(state).toBe('resolved');

    ws.close();
    await Bun.sleep(50);
  });

  it('task is never in two states simultaneously after WS dispatch', async () => {
    setup();
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w1',
      activities: ['charge'],
    });

    server.dispatchTask({ operationId: 'excl-op-1', activityName: 'charge', input: null });
    await Bun.sleep(50);

    // Task should be in exactly one state (inflight)
    const [queued, inflight, resolved] = await Promise.all([
      storage.get(KEYS.operationQueued('excl-op-1')),
      storage.get(KEYS.operationInflight('excl-op-1')),
      storage.get(KEYS.operationResolved('excl-op-1')),
    ]);

    const activeStates = [queued !== null, inflight !== null, resolved !== null].filter(Boolean);
    expect(activeStates).toHaveLength(1);

    ws.close();
    await Bun.sleep(50);
  });

  it('long-poll claimed task transitions from queued to inflight', async () => {
    setup();

    // Dispatch with no workers — goes to queued state
    server.dispatchTask({ operationId: 'lp-claim-1', activityName: 'charge', input: { x: 1 } });
    await Bun.sleep(50);

    expect(await getExclusiveTaskState(storage, 'lp-claim-1')).toBe('queued');

    // Long-poll worker claims the task
    const response = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=1000`);
    const task = (await response.json()) as { operationId: string } | null;

    expect(task).not.toBeNull();
    expect(task!.operationId).toBe('lp-claim-1');
    await Bun.sleep(50);

    // After claiming, the task should be inflight
    const state = await getExclusiveTaskState(storage, 'lp-claim-1');
    expect(state).toBe('inflight');
  });

  it('long-poll completed task transitions to resolved', async () => {
    setup();

    // Dispatch → queued
    server.dispatchTask({ operationId: 'lp-done-1', activityName: 'charge', input: null });
    await Bun.sleep(50);

    // Claim via long-poll → inflight
    await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=1000`);
    await Bun.sleep(50);

    // Complete via POST → resolved
    await fetch(`${server.url}/v1/tasks/default/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'lp-done-1',
        status: 'completed',
        value: 'done',
      }),
    });
    await Bun.sleep(50);

    const state = await getExclusiveTaskState(storage, 'lp-done-1');
    expect(state).toBe('resolved');
  });

  it('worker disconnect requeues inflight task back to queued state', async () => {
    setup();
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w-disconnect',
      activities: ['charge'],
    });

    server.dispatchTask({ operationId: 'dc-op-1', activityName: 'charge', input: null });
    await Bun.sleep(50);

    expect(await getTaskState(storage, 'dc-op-1')).toBe('inflight');

    // Disconnect the worker — task should be requeued
    ws.close();
    await Bun.sleep(150);

    // Task should no longer be inflight (requeued or dispatched to another worker)
    const inflight = await storage.get(KEYS.operationInflight('dc-op-1'));
    expect(inflight).toBeNull();
  });

  it('no task is lost: dispatched task is always findable in at least one state', async () => {
    setup();

    // Test both paths: WS dispatch and long-poll dispatch
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w-find',
      activities: ['ship'],
    });

    // WS task
    server.dispatchTask({ operationId: 'find-ws-1', activityName: 'ship', input: null });
    // Long-poll task (no WS worker for 'charge')
    server.dispatchTask({ operationId: 'find-lp-1', activityName: 'charge', input: null });
    await Bun.sleep(50);

    const wsState = await getTaskState(storage, 'find-ws-1');
    const lpState = await getTaskState(storage, 'find-lp-1');

    expect(wsState).not.toBeNull();
    expect(lpState).not.toBeNull();

    ws.close();
    await Bun.sleep(50);
  });
});
