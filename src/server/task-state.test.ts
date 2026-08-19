import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting, waitForCondition } from '../testing/fake-timers.test-support.ts';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../worker/protocol.ts';
import { manifestForActivities } from '../worker/registry-fixtures.test-support.ts';
import type { WeftServer } from './index.ts';
import { serve } from './index.ts';
import { decodeRemoteTaskRecord, taskLedgerKey } from './task-ledger.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  // Post-cutover (WFT-22), a task's current state lives at exactly one
  // durable key — `task-ledger:<operationId>` — rather than across the three
  // legacy `op:queued:` / `op:inflight:` / `op:resolved:` keys `getTaskState`
  // and `getExclusiveTaskState` still read for pre-cutover records. This
  // helper reads the ledger directly and maps its state to the same
  // vocabulary the old tests asserted against, so this suite still proves
  // the same lifecycle invariant against the current write path.
  async function readLedgerState(
    ledgerStorage: MemoryStorage,
    operationId: string,
  ): Promise<'queued' | 'inflight' | 'resolved' | null> {
    const record = decodeRemoteTaskRecord(await ledgerStorage.get(taskLedgerKey(operationId)));
    if (record === null) return null;
    if (record.state === 'queued') return 'queued';
    if (record.state === 'leased' || record.state === 'completing') return 'inflight';
    if (record.state === 'terminal') return 'resolved';
    return null;
  }

  it('task dispatched to a WebSocket worker is in inflight state', async () => {
    setup();
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w1',
      activities: ['test.charge'],
    });

    await server.dispatchTask({
      operationId: 'ws-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    await sleepForTesting(50);

    const state = await readLedgerState(storage, 'ws-op-1');
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
      workflowType: 'testWorkflow',
      input: { amount: 50 },
    });
    await sleepForTesting(50);

    const state = await readLedgerState(storage, 'lp-op-1');
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
      workflowType: 'test',
      input: null,
    });

    await waitForCondition(
      async () => (await readLedgerState(storage, 'ws-resolve-1')) === 'resolved',
      { timeoutMs: 5000, intervalMs: 25, label: 'ws-resolve-1 to reach resolved' },
    );

    const state = await readLedgerState(storage, 'ws-resolve-1');
    expect(state).toBe('resolved');

    ws.close();
    await sleepForTesting(50);
  });

  it('task never writes a legacy op:* key after WS dispatch — the ledger is the sole authority', async () => {
    setup();
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w1',
      activities: ['test.charge'],
    });

    await server.dispatchTask({
      operationId: 'excl-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    await sleepForTesting(50);

    // The current dispatch path writes exactly one key — the ledger record
    // — never the legacy queued/inflight/resolved keys.
    const [queued, inflight, resolved] = await Promise.all([
      storage.get(KEYS.operationQueued('excl-op-1')),
      storage.get(KEYS.operationInflight('excl-op-1')),
      storage.get(KEYS.operationResolved('excl-op-1')),
    ]);
    expect([queued, inflight, resolved]).toEqual([null, null, null]);
    expect(await readLedgerState(storage, 'excl-op-1')).toBe('inflight');

    ws.close();
    await sleepForTesting(50);
  });

  it('long-poll claimed task transitions from queued to inflight', async () => {
    setup();

    // Dispatch with no workers — goes to queued state
    await server.dispatchTask({
      operationId: 'lp-claim-1',
      activityName: 'charge',
      workflowType: 'testWorkflow',
      input: { x: 1 },
    });
    await sleepForTesting(50);

    expect(await readLedgerState(storage, 'lp-claim-1')).toBe('queued');

    // Long-poll worker claims the task
    const response = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=1000`);
    const task = (await response.json()) as { operationId: string } | null;

    expect(task).not.toBeNull();
    expect(task!.operationId).toBe('lp-claim-1');
    await sleepForTesting(50);

    // After claiming, the task should be inflight
    const state = await readLedgerState(storage, 'lp-claim-1');
    expect(state).toBe('inflight');
  });

  it('long-poll completed task transitions to resolved', async () => {
    setup();

    // Dispatch → queued
    await server.dispatchTask({
      operationId: 'lp-done-1',
      activityName: 'charge',
      workflowType: 'testWorkflow',
      input: null,
    });
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

    const state = await readLedgerState(storage, 'lp-done-1');
    expect(state).toBe('resolved');
  });

  it('worker disconnect requeues inflight task back to queued state', async () => {
    setup({ workerReconnectGracePeriodMs: 100 });
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w-disconnect',
      activities: ['test.charge'],
    });

    await server.dispatchTask({
      operationId: 'dc-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    await sleepForTesting(50);

    expect(await readLedgerState(storage, 'dc-op-1')).toBe('inflight');

    // Disconnect the worker — task should be requeued
    ws.close();
    await waitForCondition(async () => (await readLedgerState(storage, 'dc-op-1')) === 'queued', {
      label: 'worker disconnect to requeue the ledger record',
      timeoutMs: 1_000,
      intervalMs: 5,
    });
  });

  it('no task is lost: dispatched task is always findable in at least one state', async () => {
    setup();

    // Test both paths: WS dispatch and long-poll dispatch
    const ws = await connectAndRegisterWorker(server, {
      workerId: 'w-find',
      activities: ['test.ship'],
    });

    // WS task
    await server.dispatchTask({
      operationId: 'find-ws-1',
      activityName: 'test.ship',
      workflowType: 'test',
      input: null,
    });
    // Long-poll task (no WS worker for 'charge')
    await server.dispatchTask({
      operationId: 'find-lp-1',
      activityName: 'charge',
      workflowType: 'testWorkflow',
      input: null,
    });
    await sleepForTesting(50);

    const wsState = await readLedgerState(storage, 'find-ws-1');
    const lpState = await readLedgerState(storage, 'find-lp-1');

    expect(wsState).not.toBeNull();
    expect(lpState).not.toBeNull();

    ws.close();
    await sleepForTesting(50);
  });
});
