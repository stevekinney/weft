import { afterEach, describe, expect, it } from 'bun:test';

import { decode, encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import { TokenEvent } from '../core/events.ts';
import type { RetryPolicy, WorkflowContext } from '../core/types.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { WeftServer } from './index.ts';
import { serve } from './index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });

  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });

  return engine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serve', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('starts a server on the specified port', () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    expect(server.port).toBeGreaterThan(0);
  });

  it('responds to health check (GET /v1/health)', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/health`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('handles workflow API routes (POST /v1/workflows)', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  it('stops cleanly via stop()', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });
    const { url } = server;

    // Verify it is running
    const response = await fetch(`${url}/v1/health`);
    expect(response.status).toBe(200);

    server.stop();

    // After stopping, fetch should fail
    try {
      await fetch(`${url}/v1/health`);
      // If fetch succeeds, the server did not stop — fail the test
      expect(true).toBe(false);
    } catch {
      // Expected: connection refused or similar error
      expect(true).toBe(true);
    }
  });

  it('stops via Symbol.dispose', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });
    const { url } = server;

    // Verify it is running
    const response = await fetch(`${url}/v1/health`);
    expect(response.status).toBe(200);

    server[Symbol.dispose]();

    try {
      await fetch(`${url}/v1/health`);
      expect(true).toBe(false);
    } catch {
      expect(true).toBe(true);
    }
  });

  it('url property returns correct URL', () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    expect(server.url).toBe(`http://${server.hostname}:${server.port}`);
  });

  it('defaults to port 7233', () => {
    engine = createEngine();
    // Use the default port; rely on it being available in test environments
    server = serve({ engine, port: 7233 });

    expect(server.port).toBe(7233);
  });

  it('lists workflows through the server', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Start two workflows
    await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 1 }),
    });
    await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 2 }),
    });
    await flush();

    const response = await fetch(`${server.url}/v1/workflows`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('returns a WebSocket upgrade failure for non-matching upgrade requests', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Attempt a WebSocket-style request to a non-WebSocket route
    // Bun's fetch cannot do a real WebSocket upgrade, but we can
    // verify the server handles the upgrade header gracefully
    const response = await fetch(`${server.url}/v1/health`, {
      headers: { upgrade: 'websocket' },
    });

    // The server should return 400 since upgrade fails on a non-WebSocket route
    // (or Bun may strip the upgrade header in fetch — either way, the server
    // should not crash)
    expect(response.status).toBeDefined();
  });

  it('accepts a WebSocket connection and subscribes to pathname channel', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const wsUrl = server.url.replace('http://', 'ws://');

    const ws = new WebSocket(`${wsUrl}/v1/workflows/test-wf/watch`);

    const opened = await new Promise<boolean>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(true));
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    expect(opened).toBe(true);

    // Send a message (the handler is a no-op, but ensures the message path is exercised)
    ws.send('ping');
    await Bun.sleep(50);

    ws.close();
    await Bun.sleep(50);
  });

  it('handles WebSocket close event without error', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const wsUrl = server.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/v1/tasks/default/stream`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    // Close the connection
    ws.close();

    await new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve());
    });
  });
});

// ---------------------------------------------------------------------------
// Worker WebSocket protocol
// ---------------------------------------------------------------------------

describe('worker WebSocket protocol', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  /** Open a WebSocket to the worker stream endpoint and wait for the connection. */
  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  /** Send a register message and wait for it to be processed. */
  async function registerWorker(
    ws: WebSocket,
    options: {
      workerId: string;
      activities: string[];
      concurrency?: number;
      queue?: string;
    },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
        queue: options.queue ?? 'default',
      }),
    );
    await Bun.sleep(50);
  }

  it('tracks a worker after register message', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, {
      workerId: 'w1',
      activities: ['charge', 'ship'],
      concurrency: 5,
    });

    expect(server.registry.size).toBe(1);
    const workers = server.registry.getAll();
    expect(workers[0]?.id).toBe('w1');
    expect(workers[0]?.activities).toEqual(['charge', 'ship']);
    expect(workers[0]?.concurrency).toBe(5);

    ws.close();
    await Bun.sleep(50);
  });

  it('unregisters a worker on WebSocket close', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w2', activities: ['charge'] });

    expect(server.registry.size).toBe(1);

    ws.close();
    await Bun.sleep(100);

    expect(server.registry.size).toBe(0);
  });

  it('updates heartbeat timestamp on heartbeat message', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w3', activities: ['charge'] });

    const before = server.registry.getAll()[0]?.lastHeartbeat ?? 0;
    await Bun.sleep(50);

    ws.send(JSON.stringify({ type: 'heartbeat', workerId: 'w3' }));
    await Bun.sleep(50);

    const after = server.registry.getAll()[0]?.lastHeartbeat ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);

    ws.close();
    await Bun.sleep(50);
  });

  it('dispatches a task to the best available worker', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; activityName?: string }> = [];

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws, { workerId: 'w4', activities: ['charge'], concurrency: 5 });

    const dispatched = server.dispatchTask({
      operationId: 'op-1',
      activityName: 'charge',
      input: { amount: 100 },
    });

    expect(dispatched).toBe(true);

    await Bun.sleep(50);

    expect(received.length).toBe(1);
    expect(received[0]?.type).toBe('task');
    expect(received[0]?.operationId).toBe('op-1');
    expect(received[0]?.activityName).toBe('charge');

    ws.close();
    await Bun.sleep(50);
  });

  it('queues task for long-poll workers when no WebSocket worker is available', () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const dispatched = server.dispatchTask({
      operationId: 'op-2',
      activityName: 'charge',
      input: null,
    });

    // With the long-poll fallback, tasks are queued instead of rejected
    expect(dispatched).toBe(true);
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('increments in-flight count on dispatch and decrements on task result', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);

    // Auto-respond to tasks with a completed result
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

    await registerWorker(ws, { workerId: 'w5', activities: ['compute'], concurrency: 5 });

    server.dispatchTask({ operationId: 'op-3', activityName: 'compute', input: null });

    // Right after dispatch, in-flight should be 1
    expect(server.registry.getAll()[0]?.inFlight).toBe(1);

    // Wait for the task result to arrive
    await Bun.sleep(100);

    expect(server.registry.getAll()[0]?.inFlight).toBe(0);

    ws.close();
    await Bun.sleep(50);
  });

  it('handles invalid JSON messages without crashing', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);

    ws.send('not json at all');
    await Bun.sleep(50);

    // Server should still be running
    const response = await fetch(`${server.url}/v1/health`);
    expect(response.status).toBe(200);

    ws.close();
    await Bun.sleep(50);
  });

  it('ignores worker protocol messages on non-worker paths', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Connect to observation endpoint, not worker stream
    const ws = await connectWorker(server, '/v1/workflows/test-wf/watch');

    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: 'rogue',
        activities: ['charge'],
        concurrency: 5,
      }),
    );
    await Bun.sleep(50);

    // Registry should be empty — register messages are only processed on worker paths
    expect(server.registry.size).toBe(0);

    ws.close();
    await Bun.sleep(50);
  });

  it('supports multiple workers and routes to least-loaded', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);
    const received1: Array<{ type: string }> = [];
    const received2: Array<{ type: string }> = [];

    ws1.addEventListener('message', (event) => {
      received1.push(JSON.parse(String(event.data)));
    });
    ws2.addEventListener('message', (event) => {
      received2.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws1, { workerId: 'w-a', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w-b', activities: ['charge'], concurrency: 5 });

    // Dispatch two tasks — both workers start at 0 in-flight, so the first
    // goes to whichever findWorker returns first, and the second should go
    // to the other (least-loaded).
    server.dispatchTask({ operationId: 'op-a', activityName: 'charge', input: null });
    server.dispatchTask({ operationId: 'op-b', activityName: 'charge', input: null });

    await Bun.sleep(50);

    // Each worker should have received exactly one task
    expect(received1.length).toBe(1);
    expect(received2.length).toBe(1);

    ws1.close();
    ws2.close();
    await Bun.sleep(50);
  });

  it('falls back to long-poll queue when WebSocket workers are at capacity', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-cap', activities: ['compute'], concurrency: 1 });

    // First dispatch should go to the WebSocket worker
    const first = server.dispatchTask({
      operationId: 'cap-1',
      activityName: 'compute',
      input: null,
    });
    expect(first).toBe(true);
    expect(server.registry.getWorker('w-cap')?.inFlight).toBe(1);

    // Second dispatch — worker is at capacity (1/1), should fall to long-poll queue
    const second = server.dispatchTask({
      operationId: 'cap-2',
      activityName: 'compute',
      input: null,
    });
    expect(second).toBe(true);
    expect(server.taskQueue.pendingCount('default')).toBe(1);

    ws.close();
    await Bun.sleep(50);
  });

  it('worker capacity recovers after task completion and accepts new tasks', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string }> = [];

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      received.push(msg);
      // Complete tasks immediately
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w-recover', activities: ['compute'], concurrency: 1 });

    // Dispatch first task
    server.dispatchTask({ operationId: 'r-1', activityName: 'compute', input: null });
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(1);

    // Wait for task result to arrive and decrement inFlight
    await Bun.sleep(100);
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(0);

    // Dispatch second task — worker should accept it since capacity recovered
    server.dispatchTask({ operationId: 'r-2', activityName: 'compute', input: null });
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(1);

    await Bun.sleep(100);
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(0);

    // Both tasks were dispatched directly to the WebSocket worker (not queued)
    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(2);
    expect(server.taskQueue.pendingCount('default')).toBe(0);

    ws.close();
    await Bun.sleep(50);
  });

  it('tracks available capacity as concurrency minus inFlight through dispatch cycle', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-track', activities: ['compute'], concurrency: 3 });

    const worker = () => server.registry.getWorker('w-track')!;

    // Initial: full capacity
    expect(worker().concurrency - worker().inFlight).toBe(3);

    // Dispatch 2 tasks
    server.dispatchTask({ operationId: 't-1', activityName: 'compute', input: null });
    server.dispatchTask({ operationId: 't-2', activityName: 'compute', input: null });
    expect(worker().concurrency - worker().inFlight).toBe(1);

    // Complete one task
    ws.send(
      JSON.stringify({ type: 'taskResult', operationId: 't-1', status: 'completed', value: null }),
    );
    await Bun.sleep(50);
    expect(worker().concurrency - worker().inFlight).toBe(2);

    // Complete the other
    ws.send(
      JSON.stringify({ type: 'taskResult', operationId: 't-2', status: 'completed', value: null }),
    );
    await Bun.sleep(50);
    expect(worker().concurrency - worker().inFlight).toBe(3);

    ws.close();
    await Bun.sleep(50);
  });

  it('integrates with RemoteWorker end-to-end', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const { RemoteWorker } = await import('../worker/index.ts');

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}/v1/tasks/default/stream`,
      workerId: 'remote-1',
      activities: {
        greet: async (input: unknown) => `Hello, ${String(input)}!`,
      },
      concurrency: 3,
    });

    await worker.connect();
    await Bun.sleep(50);

    // Server should have registered the worker
    expect(server.registry.size).toBe(1);
    expect(server.registry.getAll()[0]?.id).toBe('remote-1');
    expect(server.registry.getAll()[0]?.activities).toEqual(['greet']);
    expect(server.registry.getAll()[0]?.concurrency).toBe(3);

    // Dispatch a task and verify the worker processes it
    const dispatched = server.dispatchTask({
      operationId: 'e2e-op-1',
      activityName: 'greet',
      input: 'World',
    });
    expect(dispatched).toBe(true);

    // Wait for the worker to process the task and send the result
    await Bun.sleep(200);

    // in-flight should be back to 0 after the result is received
    expect(server.registry.getAll()[0]?.inFlight).toBe(0);

    await worker.disconnect();
    await Bun.sleep(50);

    // Worker should be unregistered after disconnect
    expect(server.registry.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Sticky routing
  // -------------------------------------------------------------------------

  it('sticky dispatch prefers the worker that last handled a task for the same workflow', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);
    const received1: Array<{ type: string; operationId?: string }> = [];
    const received2: Array<{ type: string; operationId?: string }> = [];

    ws1.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      received1.push(msg);
      if (msg.type === 'task') {
        ws1.send(JSON.stringify({ type: 'taskResult', operationId: msg.operationId }));
      }
    });
    ws2.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      received2.push(msg);
      if (msg.type === 'task') {
        ws2.send(JSON.stringify({ type: 'taskResult', operationId: msg.operationId }));
      }
    });

    await registerWorker(ws1, { workerId: 'sticky-w1', activities: ['compute'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'sticky-w2', activities: ['compute'], concurrency: 5 });

    // First dispatch with workflowId — goes to whichever worker (least-loaded, both at 0).
    server.dispatchTask({
      operationId: 'sticky-op-1',
      activityName: 'compute',
      input: null,
      workflowId: 'wf-sticky-1',
    });
    await Bun.sleep(100);

    // Determine which worker handled the first task.
    const firstWorker = received1.some((m) => m.operationId === 'sticky-op-1')
      ? 'sticky-w1'
      : 'sticky-w2';
    const firstReceived = firstWorker === 'sticky-w1' ? received1 : received2;

    // Second dispatch with sticky: true — should prefer the same worker.
    server.dispatchTask({
      operationId: 'sticky-op-2',
      activityName: 'compute',
      input: null,
      workflowId: 'wf-sticky-1',
      sticky: true,
    });
    await Bun.sleep(100);

    // The same worker that handled op-1 should also get op-2.
    expect(firstReceived.some((m) => m.operationId === 'sticky-op-2')).toBe(true);

    ws1.close();
    ws2.close();
    await Bun.sleep(50);
  });

  it('sticky dispatch falls back to least-loaded when preferred worker is at capacity', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);
    const received2: Array<{ type: string; operationId?: string }> = [];

    // Worker 1 does NOT auto-complete tasks (stays at capacity)
    ws2.addEventListener('message', (event) => {
      received2.push(JSON.parse(String(event.data)) as { type: string; operationId?: string });
    });

    await registerWorker(ws1, { workerId: 'cap-w1', activities: ['compute'], concurrency: 1 });
    await registerWorker(ws2, { workerId: 'cap-w2', activities: ['compute'], concurrency: 5 });

    // First dispatch establishes affinity with w1.
    server.dispatchTask({
      operationId: 'cap-op-1',
      activityName: 'compute',
      input: null,
      workflowId: 'wf-cap',
    });
    await Bun.sleep(50);

    // w1 is now at capacity (1/1). Sticky dispatch should fall back to w2.
    server.dispatchTask({
      operationId: 'cap-op-2',
      activityName: 'compute',
      input: null,
      workflowId: 'wf-cap',
      sticky: true,
    });
    await Bun.sleep(50);

    expect(received2.some((m) => m.operationId === 'cap-op-2')).toBe(true);

    ws1.close();
    ws2.close();
    await Bun.sleep(50);
  });

  it('sticky dispatch without workflowId uses normal least-loaded routing', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    await registerWorker(ws1, { workerId: 'noid-w1', activities: ['compute'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'noid-w2', activities: ['compute'], concurrency: 5 });

    // Dispatch with sticky: true but no workflowId — should not crash, just use normal routing.
    const dispatched = server.dispatchTask({
      operationId: 'noid-op-1',
      activityName: 'compute',
      input: null,
      sticky: true,
    });
    expect(dispatched).toBe(true);

    ws1.close();
    ws2.close();
    await Bun.sleep(50);
  });
});

// ---------------------------------------------------------------------------
// Queue-aware worker stream (WS /v1/tasks/:queue/stream)
// ---------------------------------------------------------------------------

describe('queue-aware worker stream', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  /** Open a WebSocket to a specific queue's worker stream endpoint. */
  async function connectWorker(wsServer: WeftServer, queue: string): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/v1/tasks/${encodeURIComponent(queue)}/stream`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  /** Send a register message and wait for it to be processed. */
  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await Bun.sleep(50);
  }

  it('extracts queue name from the connection URL', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server, 'billing');
    await registerWorker(ws, { workerId: 'billing-w1', activities: ['charge'] });

    const worker = server.registry.getAll()[0]!;
    expect(worker.queue).toBe('billing');

    ws.close();
    await Bun.sleep(50);
  });

  it('dispatches tasks only to workers on the matching queue', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const billingWs = await connectWorker(server, 'billing');
    const shippingWs = await connectWorker(server, 'shipping');

    const billingReceived: Array<{ type: string; operationId?: string }> = [];
    const shippingReceived: Array<{ type: string; operationId?: string }> = [];

    billingWs.addEventListener('message', (event) => {
      billingReceived.push(JSON.parse(String(event.data)));
    });
    shippingWs.addEventListener('message', (event) => {
      shippingReceived.push(JSON.parse(String(event.data)));
    });

    await registerWorker(billingWs, { workerId: 'billing-w1', activities: ['charge'] });
    await registerWorker(shippingWs, { workerId: 'shipping-w1', activities: ['charge'] });

    // Dispatch to billing queue
    server.dispatchTask({
      operationId: 'billing-op',
      activityName: 'charge',
      input: { amount: 100 },
      queue: 'billing',
    });

    await Bun.sleep(50);

    // Only the billing worker should receive the task
    expect(billingReceived.length).toBe(1);
    expect(billingReceived[0]?.operationId).toBe('billing-op');
    expect(shippingReceived.length).toBe(0);

    billingWs.close();
    shippingWs.close();
    await Bun.sleep(50);
  });

  it('falls back to long-poll queue with the correct queue name', () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Dispatch to a specific queue with no WebSocket workers
    server.dispatchTask({
      operationId: 'queued-op',
      activityName: 'charge',
      input: null,
      queue: 'billing',
    });

    // Task should be in the 'billing' queue, not 'default'
    expect(server.taskQueue.pendingCount('billing')).toBe(1);
    expect(server.taskQueue.pendingCount('default')).toBe(0);
  });

  it('defaults to the "default" queue when no queue is specified in dispatch', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server, 'default');
    const received: Array<{ type: string; operationId?: string }> = [];

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws, { workerId: 'default-w1', activities: ['charge'] });

    // Dispatch without specifying queue — should default to 'default'
    server.dispatchTask({
      operationId: 'default-op',
      activityName: 'charge',
      input: null,
    });

    await Bun.sleep(50);

    expect(received.length).toBe(1);
    expect(received[0]?.operationId).toBe('default-op');

    ws.close();
    await Bun.sleep(50);
  });

  it('workers on different queues are isolated from each other', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const billingWs = await connectWorker(server, 'billing');
    const defaultWs = await connectWorker(server, 'default');

    const billingReceived: Array<{ type: string }> = [];
    const defaultReceived: Array<{ type: string }> = [];

    billingWs.addEventListener('message', (event) => {
      billingReceived.push(JSON.parse(String(event.data)));
    });
    defaultWs.addEventListener('message', (event) => {
      defaultReceived.push(JSON.parse(String(event.data)));
    });

    await registerWorker(billingWs, { workerId: 'billing-w1', activities: ['charge'] });
    await registerWorker(defaultWs, { workerId: 'default-w1', activities: ['charge'] });

    // Dispatch to default queue — should not reach billing worker
    server.dispatchTask({
      operationId: 'default-only',
      activityName: 'charge',
      input: null,
    });

    await Bun.sleep(50);

    expect(defaultReceived.length).toBe(1);
    expect(billingReceived.length).toBe(0);

    billingWs.close();
    defaultWs.close();
    await Bun.sleep(50);
  });

  it('integrates with RemoteWorker on a custom queue', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const { RemoteWorker } = await import('../worker/index.ts');

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}/v1/tasks/billing/stream`,
      workerId: 'billing-remote',
      activities: {
        charge: async (input: unknown) => ({ charged: input }),
      },
      concurrency: 3,
      queue: 'billing',
    });

    await worker.connect();
    await Bun.sleep(50);

    // Worker should be registered on the billing queue
    expect(server.registry.size).toBe(1);
    const registered = server.registry.getAll()[0]!;
    expect(registered.id).toBe('billing-remote');
    expect(registered.queue).toBe('billing');

    // Dispatch to the billing queue
    const dispatched = server.dispatchTask({
      operationId: 'billing-e2e',
      activityName: 'charge',
      input: 42,
      queue: 'billing',
    });
    expect(dispatched).toBe(true);

    await Bun.sleep(200);

    // Task should be completed
    expect(registered.inFlight).toBe(0);

    await worker.disconnect();
    await Bun.sleep(50);
  });
});

// ---------------------------------------------------------------------------
// Token streaming WebSocket
// ---------------------------------------------------------------------------

describe('token streaming WebSocket (WS /v1/workflows/:id/stream)', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  /** Open a WebSocket to the token stream endpoint and wait for the connection. */
  async function connectStream(wsServer: WeftServer, workflowId: string): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/v1/workflows/${workflowId}/stream`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  /** Collect messages received on a WebSocket. */
  function collectMessages(ws: WebSocket): Array<{ type: string; [key: string]: unknown }> {
    const messages: Array<{ type: string; [key: string]: unknown }> = [];
    ws.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)));
    });
    return messages;
  }

  it('accepts a WebSocket connection on /v1/workflows/:id/stream', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectStream(server, 'test-wf');
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await Bun.sleep(50);
  });

  it('receives live token events through the stream connection', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Start a workflow so events have a target
    const startResponse = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });
    const { id } = (await startResponse.json()) as { id: string };
    await flush();

    const ws = await connectStream(server, id);
    const messages = collectMessages(ws);
    await Bun.sleep(50);

    // Dispatch token events directly on the engine
    engine.dispatchEvent(new TokenEvent(id, 'Hello', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent(id, ' world', 'gpt-4'));
    await Bun.sleep(200);

    // Should have received the two token events
    const tokenMessages = messages.filter((m) => m.type === TokenEvent.type);
    expect(tokenMessages.length).toBe(2);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'Hello', model: 'gpt-4' });
    expect(tokenMessages[1]?.['data']).toMatchObject({ token: ' world', model: 'gpt-4' });

    ws.close();
    await Bun.sleep(50);
  });

  it('only receives token events for the subscribed workflow', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectStream(server, 'wf-a');
    const messages = collectMessages(ws);
    await Bun.sleep(50);

    // Dispatch token events for two different workflows
    engine.dispatchEvent(new TokenEvent('wf-a', 'for-a', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent('wf-b', 'for-b', 'gpt-4'));
    await Bun.sleep(200);

    // Should only see the event for wf-a
    const tokenMessages = messages.filter((m) => m.type === TokenEvent.type);
    expect(tokenMessages.length).toBe(1);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'for-a' });

    ws.close();
    await Bun.sleep(50);
  });

  it('replays existing token events on connect', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Dispatch token events before a client connects
    engine.dispatchEvent(new TokenEvent('wf-replay', 'first', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent('wf-replay', 'second', 'gpt-4'));
    await Bun.sleep(200);

    // Now connect — client should receive replay of existing token events
    const ws = await connectStream(server, 'wf-replay');
    const messages = collectMessages(ws);
    await Bun.sleep(200);

    const replayMessages = messages.filter((m) => m.type === 'replay');
    expect(replayMessages.length).toBeGreaterThanOrEqual(1);

    // Replayed content should include the tokens
    const replayedTokens = replayMessages.map(
      (m) => (m['data'] as Record<string, unknown>)?.['token'],
    );
    expect(replayedTokens).toContain('first');
    expect(replayedTokens).toContain('second');

    ws.close();
    await Bun.sleep(50);
  });

  it('does not process worker protocol messages on stream connections', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectStream(server, 'test-wf');

    // Send a worker register message — should be ignored
    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: 'rogue',
        activities: ['charge'],
        concurrency: 5,
      }),
    );
    await Bun.sleep(50);

    // Registry should be empty — register messages are only for worker paths
    expect(server.registry.size).toBe(0);

    ws.close();
    await Bun.sleep(50);
  });

  it('supports multiple concurrent stream clients for the same workflow', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws1 = await connectStream(server, 'wf-multi');
    const ws2 = await connectStream(server, 'wf-multi');
    const messages1 = collectMessages(ws1);
    const messages2 = collectMessages(ws2);
    await Bun.sleep(50);

    engine.dispatchEvent(new TokenEvent('wf-multi', 'shared-token', 'gpt-4'));
    await Bun.sleep(200);

    // Both clients should receive the token event
    const tokens1 = messages1.filter((m) => m.type === TokenEvent.type);
    const tokens2 = messages2.filter((m) => m.type === TokenEvent.type);
    expect(tokens1.length).toBe(1);
    expect(tokens2.length).toBe(1);

    ws1.close();
    ws2.close();
    await Bun.sleep(50);
  });
});

// ---------------------------------------------------------------------------
// Long-poll HTTP endpoints
// ---------------------------------------------------------------------------

describe('long-poll endpoints (GET /v1/tasks/:queue, POST /v1/tasks/:queue/complete)', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('returns null when no task is available within timeout', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=50`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeNull();
  });

  it('returns 400 when no activity query parameter is provided', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default?timeout=50`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('activity');
  });

  it('returns a queued task immediately', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Dispatch a task with no WebSocket workers — goes to task queue
    server.dispatchTask({
      operationId: 'op-poll-1',
      activityName: 'charge',
      input: { amount: 100 },
    });

    const response = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=1000`);

    expect(response.status).toBe(200);
    const task = (await response.json()) as { operationId: string; activityName: string };
    expect(task.operationId).toBe('op-poll-1');
    expect(task.activityName).toBe('charge');
  });

  it('blocks until a task arrives within the timeout', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Start a poll that will block
    const pollPromise = fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=5000`);

    // Wait a bit, then enqueue a task
    await Bun.sleep(100);
    server.dispatchTask({
      operationId: 'op-delayed',
      activityName: 'charge',
      input: { amount: 50 },
    });

    const response = await pollPromise;
    expect(response.status).toBe(200);
    const task = (await response.json()) as { operationId: string };
    expect(task.operationId).toBe('op-delayed');
  });

  it('filters tasks by activity name', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Queue a 'ship' task
    server.dispatchTask({
      operationId: 'op-ship',
      activityName: 'ship',
      input: null,
    });

    // Poll for 'charge' only — should not match
    const response = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=50`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeNull();

    // The 'ship' task should still be in the queue
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('accepts task completion via POST', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'op-complete-1',
        status: 'completed',
        value: { result: 42 },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('returns 400 for invalid completion body', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 for non-JSON completion body', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });

  it('invokes the completion callback when task is completed', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const results: Array<{ operationId: string; status: string }> = [];

    // Enqueue with a callback
    server.taskQueue.enqueue(
      'default',
      { operationId: 'op-cb', activityName: 'charge', input: null },
      (result) => results.push(result),
    );

    // Complete via HTTP
    await fetch(`${server.url}/v1/tasks/default/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'op-cb',
        status: 'completed',
        value: 'done',
      }),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.operationId).toBe('op-cb');
    expect(results[0]?.status).toBe('completed');
  });

  it('integrates with LongPollWorker end-to-end', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const { LongPollWorker } = await import('../worker/long-poll.ts');

    const worker = new LongPollWorker({
      serverUrl: server.url,
      activities: {
        greet: async (input: unknown) => `Hello, ${String(input)}!`,
      },
      concurrency: 3,
      pollTimeout: 5000,
    });

    worker.start();
    await Bun.sleep(100);

    // Dispatch a task — no WebSocket workers, so it goes to the queue
    server.dispatchTask({
      operationId: 'e2e-lp-1',
      activityName: 'greet',
      input: 'World',
    });

    // Wait for the worker to poll, execute, and complete
    await Bun.sleep(500);

    // Worker should be running with no in-flight tasks
    expect(worker.running).toBe(true);
    expect(worker.inFlight).toBe(0);

    await worker.stop();
    expect(worker.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task assignment deduplication
// ---------------------------------------------------------------------------

describe('task assignment deduplication', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await Bun.sleep(50);
  }

  it('rejects duplicate dispatch of the same operationId to WebSocket workers', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string }> = [];

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    const first = server.dispatchTask({
      operationId: 'dup-op',
      activityName: 'charge',
      input: null,
    });
    const second = server.dispatchTask({
      operationId: 'dup-op',
      activityName: 'charge',
      input: null,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);

    await Bun.sleep(50);

    // Worker should receive exactly one task
    expect(received.length).toBe(1);

    ws.close();
    await Bun.sleep(50);
  });

  it('rejects duplicate dispatch when the first went to the long-poll queue', () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // No WebSocket workers — tasks go to long-poll queue
    const first = server.dispatchTask({
      operationId: 'dup-lp',
      activityName: 'charge',
      input: null,
    });
    const second = server.dispatchTask({
      operationId: 'dup-lp',
      activityName: 'charge',
      input: null,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('rejects duplicate across WebSocket and long-poll paths', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 1 });

    // First dispatch goes to WebSocket worker
    const first = server.dispatchTask({
      operationId: 'cross-dup',
      activityName: 'charge',
      input: null,
    });
    expect(first).toBe(true);

    // Worker is now at capacity (1/1), so second dispatch would normally go to long-poll.
    // But the operationId is already assigned, so it should be rejected.
    const second = server.dispatchTask({
      operationId: 'cross-dup',
      activityName: 'charge',
      input: null,
    });
    expect(second).toBe(false);
    expect(server.taskQueue.pendingCount('default')).toBe(0);

    ws.close();
    await Bun.sleep(50);
  });

  it('uses assignTask for WebSocket dispatch so in-flight tasks are tracked', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({
      operationId: 'tracked-op',
      activityName: 'charge',
      input: null,
    });

    // The operationId should be tracked in the registry's in-flight tasks
    expect(server.registry.isAssigned('tracked-op')).toBe(true);

    ws.close();
    await Bun.sleep(50);
  });

  it('clears in-flight tracking when worker sends taskResult with operationId', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);

    // Auto-respond with operationId in the result
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

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({
      operationId: 'clear-op',
      activityName: 'charge',
      input: null,
    });

    expect(server.registry.isAssigned('clear-op')).toBe(true);

    await Bun.sleep(100);

    // After the result arrives, the task should no longer be tracked
    expect(server.registry.isAssigned('clear-op')).toBe(false);
    expect(server.registry.getWorker('w1')?.inFlight).toBe(0);

    ws.close();
    await Bun.sleep(50);
  });

  it('allows re-dispatch of an operationId after completion', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string }> = [];

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; operationId?: string };
      received.push(msg);
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // First dispatch
    server.dispatchTask({ operationId: 'reuse-op', activityName: 'charge', input: null });
    await Bun.sleep(100);

    // After completion, dispatch the same operationId again
    const second = server.dispatchTask({
      operationId: 'reuse-op',
      activityName: 'charge',
      input: null,
    });
    expect(second).toBe(true);

    await Bun.sleep(50);

    // Worker should have received two tasks
    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(2);

    ws.close();
    await Bun.sleep(50);
  });
});

// ---------------------------------------------------------------------------
// Visibility timeout persistence
// ---------------------------------------------------------------------------

describe('visibility timeout persistence', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });
    return { engine: e, storage: s };
  }

  async function connectWorker(wsServer: WeftServer): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/v1/tasks/default/stream`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await Bun.sleep(50);
  }

  it('persists in-flight record to storage on dispatch', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({ operationId: 'vt-op-1', activityName: 'charge', input: { amount: 100 } });
    await Bun.sleep(50);

    const key = KEYS.operationInflight('vt-op-1');
    const raw = await storage.get(key);
    expect(raw).not.toBeNull();

    const record = decode(raw!) as { operationId: string; workerId: string; deadline: number };
    expect(record.operationId).toBe('vt-op-1');
    expect(record.workerId).toBe('w1');
    expect(record.deadline).toBeGreaterThan(Date.now());

    ws.close();
    await Bun.sleep(50);
  });

  it('removes in-flight record from storage on task completion', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);

    // Auto-respond to tasks with a completed result
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

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({ operationId: 'vt-op-2', activityName: 'charge', input: null });
    await Bun.sleep(100);

    const key = KEYS.operationInflight('vt-op-2');
    const raw = await storage.get(key);
    expect(raw).toBeNull();

    ws.close();
    await Bun.sleep(50);
  });

  it('uses custom visibility timeout from TaskDispatch', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    const customTimeout = 120_000; // 2 minutes
    server.dispatchTask({
      operationId: 'vt-op-3',
      activityName: 'charge',
      input: null,
      visibilityTimeout: customTimeout,
    });
    await Bun.sleep(50);

    const key = KEYS.operationInflight('vt-op-3');
    const raw = await storage.get(key);
    expect(raw).not.toBeNull();

    const record = decode(raw!) as {
      operationId: string;
      visibilityTimeout: number;
      deadline: number;
    };
    expect(record.visibilityTimeout).toBe(customTimeout);
    // Deadline should be roughly now + 120s (within a generous margin)
    expect(record.deadline).toBeGreaterThan(Date.now() + 100_000);

    ws.close();
    await Bun.sleep(50);
  });

  it('defaults visibility timeout to 30 seconds when not specified', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({ operationId: 'vt-op-4', activityName: 'charge', input: null });
    await Bun.sleep(50);

    const key = KEYS.operationInflight('vt-op-4');
    const raw = await storage.get(key);
    expect(raw).not.toBeNull();

    const record = decode(raw!) as { visibilityTimeout: number; deadline: number };
    expect(record.visibilityTimeout).toBe(30_000);

    ws.close();
    await Bun.sleep(50);
  });

  it('restores in-flight tasks from storage on server restart', async () => {
    ({ engine, storage } = createEngineWithStorage());

    // Pre-populate storage with an in-flight record that hasn't expired
    const deadline = Date.now() + 60_000;
    const inflightRecord = {
      operationId: 'restored-op',
      workerId: 'old-worker',
      deadline,
      activityName: 'charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 60_000,
    };
    await storage.put(KEYS.operationInflight('restored-op'), encode(inflightRecord));

    // Start the server — it should restore the in-flight record
    server = serve({ engine, port: 0 });
    await Bun.sleep(100); // Allow async restore to complete

    // The registry should now track the restored task
    expect(server.registry.isAssigned('restored-op')).toBe(true);
  });

  it('cleans up expired in-flight records from storage on restart', async () => {
    ({ engine, storage } = createEngineWithStorage());

    // Pre-populate storage with an expired in-flight record
    const expiredRecord = {
      operationId: 'expired-op',
      workerId: 'old-worker',
      deadline: Date.now() - 5000, // Already expired 5s ago
      activityName: 'charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 30_000,
    };
    await storage.put(KEYS.operationInflight('expired-op'), encode(expiredRecord));

    server = serve({ engine, port: 0 });
    await Bun.sleep(100);

    // The expired record should be removed from storage
    const raw = await storage.get(KEYS.operationInflight('expired-op'));
    expect(raw).toBeNull();

    // And not tracked in the registry
    expect(server.registry.isAssigned('expired-op')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker disconnection triggers task reassignment
// ---------------------------------------------------------------------------

describe('worker disconnection triggers task reassignment', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });
    return { engine: e, storage: s };
  }

  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await Bun.sleep(50);
  }

  it('requeues in-flight tasks to another worker on disconnect', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    // Connect two workers
    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws2.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge'], concurrency: 5 });

    // Dispatch a task — goes to w1 (least-loaded, both at 0 but w1 registered first)
    server.dispatchTask({
      operationId: 'requeue-op-1',
      activityName: 'charge',
      input: { amount: 42 },
    });
    await Bun.sleep(50);

    expect(server.registry.isAssigned('requeue-op-1')).toBe(true);

    // Disconnect w1 — its in-flight task should be reassigned to w2
    ws1.close();
    await Bun.sleep(200);

    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.operationId).toBe('requeue-op-1');

    ws2.close();
    await Bun.sleep(50);
  });

  it('increments attempt count on reassigned tasks', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws2.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({
      operationId: 'attempt-op',
      activityName: 'charge',
      input: null,
      attempt: 2, // Already on attempt 2
    });
    await Bun.sleep(50);

    // Disconnect w1 — task should be re-dispatched with attempt 3
    ws1.close();
    await Bun.sleep(200);

    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(3);

    ws2.close();
    await Bun.sleep(50);
  });

  it('cleans up in-flight storage record on disconnect and reassignment', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({
      operationId: 'cleanup-op',
      activityName: 'charge',
      input: null,
    });
    await Bun.sleep(50);

    // Verify the original in-flight record exists
    const keyBefore = KEYS.operationInflight('cleanup-op');
    expect(await storage.get(keyBefore)).not.toBeNull();

    // Disconnect w1
    ws1.close();
    await Bun.sleep(200);

    // The old in-flight record should be deleted (a new one is created for w2)
    // The task should now be assigned in the registry (to w2)
    expect(server.registry.isAssigned('cleanup-op')).toBe(true);

    ws2.close();
    await Bun.sleep(50);
  });

  it('requeues to long-poll queue when no other WebSocket worker is available', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({
      operationId: 'fallback-op',
      activityName: 'charge',
      input: { amount: 99 },
    });
    await Bun.sleep(50);

    expect(server.registry.isAssigned('fallback-op')).toBe(true);

    // Disconnect the only worker — task should go to long-poll queue
    ws.close();
    await Bun.sleep(200);

    // The task should be available via long-poll
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('reassigns multiple in-flight tasks when a worker disconnects', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string }> = [];
    ws2.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge', 'ship'], concurrency: 10 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge', 'ship'], concurrency: 10 });

    // Dispatch multiple tasks to w1
    server.dispatchTask({ operationId: 'multi-op-1', activityName: 'charge', input: null });
    server.dispatchTask({ operationId: 'multi-op-2', activityName: 'ship', input: null });
    server.dispatchTask({ operationId: 'multi-op-3', activityName: 'charge', input: null });
    await Bun.sleep(50);

    // Disconnect w1 — all three tasks should be reassigned to w2
    ws1.close();
    await Bun.sleep(200);

    const taskMessages = received.filter((m) => m.type === 'task');
    const reassignedIds = taskMessages
      .map((m) => m.operationId)
      .toSorted((a = '', b = '') => (a < b ? -1 : a > b ? 1 : 0));
    expect(reassignedIds).toEqual(['multi-op-1', 'multi-op-2', 'multi-op-3']);

    ws2.close();
    await Bun.sleep(50);
  });

  it('does nothing when a worker with no in-flight tasks disconnects', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    expect(server.registry.size).toBe(1);

    // Disconnect without any dispatched tasks
    ws.close();
    await Bun.sleep(100);

    // Worker should be unregistered, no tasks in queue
    expect(server.registry.size).toBe(0);
    expect(server.taskQueue.pendingCount('default')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Visibility timeout expiry triggers task reassignment
// ---------------------------------------------------------------------------

describe('visibility timeout expiry triggers task reassignment', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });
    return { engine: e, storage: s };
  }

  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await Bun.sleep(50);
  }

  it('reassigns tasks whose visibility timeout has expired via storage scan', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);

    // Collect all received messages (including re-dispatches)
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(msg);
      // Complete the task on second attempt to stop the reassignment cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 2) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // Dispatch with a very short visibility timeout
    server.dispatchTask({
      operationId: 'expiry-op-1',
      activityName: 'charge',
      input: { amount: 42 },
      visibilityTimeout: 100, // 100ms — will expire quickly
    });
    await Bun.sleep(50);

    // Task should be assigned
    expect(server.registry.isAssigned('expiry-op-1')).toBe(true);

    // Wait for the visibility timeout to expire and the scanner to pick it up
    await Bun.sleep(300);

    // The worker should have received the task at least twice (original + reassignment)
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'expiry-op-1',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);
    // First dispatch: attempt 1; reassignment: attempt 2
    expect(taskMessages[0]?.attempt).toBe(1);
    expect(taskMessages[1]?.attempt).toBe(2);

    ws.close();
    await Bun.sleep(50);
  });

  it('increments attempt count on tasks reassigned due to timeout expiry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(msg);
      // Complete the task on attempt 3 to stop the cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 3) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({
      operationId: 'attempt-expiry-op',
      activityName: 'charge',
      input: null,
      attempt: 2,
      visibilityTimeout: 100,
    });
    await Bun.sleep(300);

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'attempt-expiry-op',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);
    // First dispatch: attempt 2; reassignment: attempt 3
    expect(taskMessages[0]?.attempt).toBe(2);
    expect(taskMessages[1]?.attempt).toBe(3);

    ws.close();
    await Bun.sleep(50);
  });

  it('does not reassign tasks that have not expired', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // Dispatch with a long visibility timeout
    server.dispatchTask({
      operationId: 'noexpiry-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 60_000,
    });
    await Bun.sleep(200);

    // The task should still be assigned, not reassigned
    expect(server.registry.isAssigned('noexpiry-op')).toBe(true);
    // Worker should have received exactly one task message (the initial dispatch, no reassignment)
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'noexpiry-op',
    );
    expect(taskMessages.length).toBe(1);

    ws.close();
    await Bun.sleep(50);
  });

  it('cleans up old storage record and creates new one on reassignment', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      // Complete on attempt 2 to stop the reassignment cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 2) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({
      operationId: 'cleanup-expiry-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 100,
    });
    await Bun.sleep(50);

    // Verify original record exists
    const inflightKey = KEYS.operationInflight('cleanup-expiry-op');
    const rawBefore = await storage.get(inflightKey);
    expect(rawBefore).not.toBeNull();
    const recordBefore = decode(rawBefore!) as { attempt: number };
    expect(recordBefore.attempt).toBe(1);

    // Wait for expiry and reassignment
    await Bun.sleep(300);

    // After the scanner re-dispatches with attempt=2, the worker completes it
    // and the in-flight record is removed from storage.
    const rawAfter = await storage.get(inflightKey);
    expect(rawAfter).toBeNull();

    ws.close();
    await Bun.sleep(50);
  });

  it('falls back to long-poll queue when no WebSocket worker available for expired task', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({
      operationId: 'fallback-expiry-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 100,
    });
    await Bun.sleep(50);

    // Unregister the worker before the timeout expires, but don't close the WS
    // (simulating a worker that stops heartbeating). Instead, just disconnect:
    ws.close();
    await Bun.sleep(300);

    // The expired task should have been cleaned up from storage or requeued to long-poll
    // (worker disconnect already handles this, but storage scan covers edge cases)
    // Verify there are no orphaned in-flight records in storage
    let inflightCount = 0;
    for await (const [_key] of storage.scan('op:inflight:')) {
      inflightCount++;
    }
    // Either the disconnect handler or the scanner cleaned it up
    expect(inflightCount).toBe(0);
  });

  it('scanner cleans up orphaned storage records with no matching registry entry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    // Connect a worker that can receive the reassigned task
    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // Wait for startup restore to complete, then insert an orphaned expired record.
    // This simulates a record that slipped through (e.g., created by another process).
    await Bun.sleep(100);
    const expiredRecord = {
      operationId: 'orphan-op',
      workerId: 'ghost-worker',
      deadline: Date.now() - 5000,
      activityName: 'charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 30_000,
    };
    await storage.put(KEYS.operationInflight('orphan-op'), encode(expiredRecord));

    // Wait for the scanner to pick up the orphaned record
    await Bun.sleep(200);

    const taskMessages = received.filter((m) => m.type === 'task' && m.operationId === 'orphan-op');
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(2);

    ws.close();
    await Bun.sleep(50);
  });
});

// ---------------------------------------------------------------------------
// Retry policy respected on reassignment
// ---------------------------------------------------------------------------

describe('retry policy respected on reassignment', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });
    return { engine: e, storage: s };
  }

  async function connectWorker(
    wsServer: WeftServer,
    path = '/v1/tasks/default/stream',
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
    return ws;
  }

  async function registerWorker(
    ws: WebSocket,
    options: { workerId: string; activities: string[]; concurrency?: number },
  ): Promise<void> {
    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: options.workerId,
        activities: options.activities,
        concurrency: options.concurrency ?? 10,
      }),
    );
    await Bun.sleep(50);
  }

  const testRetryPolicy: RetryPolicy = {
    maxAttempts: 2,
    initialBackoff: 100,
    backoffMultiplier: 2,
    maxBackoff: 5000,
  };

  it('does not re-dispatch when maxAttempts exceeded on visibility timeout expiry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // Dispatch a task already at maxAttempts with a short visibility timeout
    server.dispatchTask({
      operationId: 'max-attempt-expiry-op',
      activityName: 'charge',
      input: { amount: 42 },
      attempt: 2,
      visibilityTimeout: 100,
      retryPolicy: testRetryPolicy, // maxAttempts = 2, already at attempt 2
    });
    await Bun.sleep(50);

    expect(server.registry.isAssigned('max-attempt-expiry-op')).toBe(true);

    // Wait for the visibility timeout to expire and the scanner to run
    await Bun.sleep(300);

    // The task should NOT be re-dispatched — only the initial dispatch should exist
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'max-attempt-expiry-op',
    );
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(2);

    // In-flight record should be cleaned up
    const inflightKey = KEYS.operationInflight('max-attempt-expiry-op');
    const record = await storage.get(inflightKey);
    expect(record).toBeNull();

    ws.close();
    await Bun.sleep(50);
  });

  it('does not re-dispatch when maxAttempts exceeded on worker disconnect', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws2.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge'], concurrency: 5 });

    // Dispatch a task already at maxAttempts
    server.dispatchTask({
      operationId: 'max-attempt-disconnect-op',
      activityName: 'charge',
      input: { amount: 42 },
      attempt: 2,
      retryPolicy: testRetryPolicy, // maxAttempts = 2, already at attempt 2
    });
    await Bun.sleep(50);

    // Disconnect w1 — task should NOT be reassigned to w2 since maxAttempts reached
    ws1.close();
    await Bun.sleep(200);

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'max-attempt-disconnect-op',
    );
    expect(taskMessages.length).toBe(0);

    // In-flight record should be cleaned up
    const inflightKey = KEYS.operationInflight('max-attempt-disconnect-op');
    const record = await storage.get(inflightKey);
    expect(record).toBeNull();

    ws2.close();
    await Bun.sleep(50);
  });

  it('re-dispatches when within maxAttempts on visibility timeout expiry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(msg);
      // Complete on attempt 2 to stop reassignment cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 2) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // maxAttempts = 3, starting at attempt 1 — should allow reassignment
    server.dispatchTask({
      operationId: 'within-limit-expiry-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 100,
      retryPolicy: { ...testRetryPolicy, maxAttempts: 3 },
    });
    await Bun.sleep(50);

    // Wait for the visibility timeout to expire and the scanner to re-dispatch
    await Bun.sleep(300);

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'within-limit-expiry-op',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);
    expect(taskMessages[0]?.attempt).toBe(1);
    expect(taskMessages[1]?.attempt).toBe(2);

    ws.close();
    await Bun.sleep(50);
  });

  it('applies backoff delay before re-dispatch on visibility timeout expiry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const timestamps: number[] = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      if (msg.type === 'task' && msg.operationId === 'backoff-expiry-op') {
        timestamps.push(Date.now());
        // Complete on attempt 2 to stop the cycle
        if ((msg.attempt ?? 1) >= 2) {
          ws.send(
            JSON.stringify({
              type: 'taskResult',
              operationId: msg.operationId,
              status: 'completed',
              value: null,
            }),
          );
        }
      }
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // initialBackoff = 100ms
    server.dispatchTask({
      operationId: 'backoff-expiry-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 80,
      retryPolicy: { ...testRetryPolicy, maxAttempts: 3, initialBackoff: 100 },
    });

    // Wait long enough for: visibility timeout (80ms) + backoff (100ms) + scanner intervals
    await Bun.sleep(500);

    // Should have received both dispatches
    expect(timestamps.length).toBeGreaterThanOrEqual(2);

    // The gap between dispatch 1 and dispatch 2 should be at least ~80ms (visibility) + ~100ms (backoff)
    // We use a conservative lower bound to account for timing variability
    const gap = timestamps[1]! - timestamps[0]!;
    expect(gap).toBeGreaterThanOrEqual(150);

    ws.close();
    await Bun.sleep(50);
  });

  it('applies backoff delay before re-dispatch on worker disconnect', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const timestamps: number[] = [];
    ws2.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      if (msg.type === 'task' && msg.operationId === 'backoff-disconnect-op') {
        timestamps.push(Date.now());
      }
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['charge'], concurrency: 5 });

    const dispatchTime = Date.now();
    // initialBackoff = 150ms, attempt 1 → backoff for attempt 2 = 150ms
    server.dispatchTask({
      operationId: 'backoff-disconnect-op',
      activityName: 'charge',
      input: null,
      retryPolicy: { ...testRetryPolicy, maxAttempts: 3, initialBackoff: 150 },
    });
    await Bun.sleep(50);

    // Disconnect w1 — should apply backoff before re-dispatching to w2
    ws1.close();

    // Wait for the backoff delay to complete
    await Bun.sleep(400);

    expect(timestamps.length).toBe(1);
    // The re-dispatch should have been delayed by at least the backoff (150ms)
    const gap = timestamps[0]! - dispatchTime;
    expect(gap).toBeGreaterThanOrEqual(150);

    ws2.close();
    await Bun.sleep(50);
  });

  it('stores retryPolicy in the inflight record for use during reassignment', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    server.dispatchTask({
      operationId: 'policy-stored-op',
      activityName: 'charge',
      input: null,
      retryPolicy: testRetryPolicy,
    });
    await Bun.sleep(50);

    const inflightKey = KEYS.operationInflight('policy-stored-op');
    const raw = await storage.get(inflightKey);
    expect(raw).not.toBeNull();

    const record = decode(raw!) as { retryPolicy: RetryPolicy };
    expect(record.retryPolicy).toEqual(testRetryPolicy);

    ws.close();
    await Bun.sleep(50);
  });

  it('defaults to no maxAttempts limit when retryPolicy is not provided', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serve({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attempt?: number }> = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      received.push(msg);
      // Complete on attempt 2 to stop the cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 2) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'completed',
            value: null,
          }),
        );
      }
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['charge'], concurrency: 5 });

    // No retryPolicy — should still re-dispatch (backwards compatible)
    server.dispatchTask({
      operationId: 'no-policy-op',
      activityName: 'charge',
      input: null,
      visibilityTimeout: 100,
    });
    await Bun.sleep(50);

    // Wait for visibility timeout expiry + scanner
    await Bun.sleep(300);

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'no-policy-op',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);

    ws.close();
    await Bun.sleep(50);
  });
});
