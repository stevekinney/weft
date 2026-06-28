import { afterEach, describe, expect, it } from 'bun:test';
import type { ActivityInterceptor } from '../core/interceptor.ts';
import {
  restoreRealTimers,
  sleepForTesting,
  waitForCondition,
} from '../testing/fake-timers.test-support.ts';
import { RemoteWorker } from './index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal WebSocket server for testing. */
function createTestServer(options?: {
  onMessage?: (ws: any, message: string) => void;
  autoRegisterAck?: boolean;
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: undefined })) return undefined;
      return new Response('ok');
    },
    websocket: {
      message(ws, message) {
        const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
        const autoRegisterAck = options?.autoRegisterAck ?? true;
        if (autoRegisterAck) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.type === 'register') {
              ws.send(
                JSON.stringify({
                  type: 'registerAck',
                  protocolVersion: 2,
                  workerId: parsed.workerId,
                  queue: parsed.queue ?? 'default',
                  activities: parsed.activities,
                  concurrency: parsed.concurrency ?? 10,
                }),
              );
            }
          } catch {
            // Test helper ignores malformed client frames.
          }
        }
        options?.onMessage?.(ws, text);
      },
      open(_ws) {},
      close(_ws) {},
    },
  });
}

async function waitForTaskResult(messages: any[], label: string): Promise<any> {
  await waitForCondition(() => messages.some((message) => message.type === 'taskResult'), {
    timeoutMs: 1_000,
    label,
  });

  const taskResult = messages.find((message) => message.type === 'taskResult');
  expect(taskResult).toBeDefined();
  return taskResult;
}

/**
 * Wrap a flat `activityName → executor` map in the `workflows` shape the
 * RemoteWorker constructor now requires. The worker advertises and dispatches
 * each activity under the qualified name `${type}.${activityName}`, so tests
 * that assert on advertised names or dispatch by name use that qualified form
 * (e.g. `orders.processOrder`).
 *
 * `type` defaults to `'orders'`: a test-convenience token with no domain
 * meaning. Every assertion on an advertised/dispatched name in this file is
 * written against that default prefix; pass an explicit `type` only when a test
 * needs a distinct workflow namespace.
 */
function workflowsOf(
  activities: Record<string, (input: any, context?: any) => Promise<unknown>>,
  type = 'orders',
): Record<string, { name: string; activities: typeof activities }> {
  return { [type]: { name: type, activities } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteWorker', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    restoreRealTimers();

    if (server) {
      server.stop(true);
      server = undefined;
    }
  });

  it('constructor stores options with defaults', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    // Verify it was created without throwing
    expect(worker).toBeDefined();

    // Clean up
    worker[Symbol.dispose]();
  });

  it('connected is false before connect', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    expect(worker.connected).toBe(false);

    worker[Symbol.dispose]();
  });

  it('inFlight starts at 0', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    expect(worker.inFlight).toBe(0);

    worker[Symbol.dispose]();
  });

  it('[Symbol.dispose] is callable', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    expect(() => worker[Symbol.dispose]()).not.toThrow();
  });

  it('[Symbol.dispose] is idempotent', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    worker[Symbol.dispose]();
    expect(() => worker[Symbol.dispose]()).not.toThrow();
  });

  it('connect() establishes a WebSocket connection and sends register message', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(_ws, message) {
        messages.push(JSON.parse(message));
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'test-worker-1',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
      concurrency: 5,
      queue: 'test-queue',
    });

    await worker.connect();

    expect(worker.connected).toBe(true);

    // Give time for the register message to arrive. The previous fixed
    // 50ms sleep flaked on slow CI runners; poll up to 2s instead.
    let registerMessage: any;
    for (let attempt = 0; attempt < 40 && registerMessage === undefined; attempt++) {
      await sleepForTesting(50);
      registerMessage = messages.find((m) => m.type === 'register');
    }
    expect(registerMessage).toBeDefined();
    expect(registerMessage.protocolVersion).toBe(2);
    expect(registerMessage.workerId).toBe('test-worker-1');
    expect(registerMessage.activities).toEqual(['orders.processOrder']);
    expect(registerMessage.concurrency).toBe(5);
    expect(registerMessage.queue).toBe('test-queue');

    await worker.disconnect();
  });

  it('sends deployment identity and capabilities in the register message when configured', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(_ws, message) {
        messages.push(JSON.parse(message));
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'identity-worker',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
      deploymentName: 'payments',
      buildId: 'build-2026-05-12',
      runtimeVersion: 'bun-1.2.13',
      gitSha: '0123456789abcdef',
      startedAt: 1_778_608_000_000,
      capabilities: {
        region: 'us-west',
        canary: true,
      },
    });

    await worker.connect();

    await waitForCondition(() => messages.some((message) => message.type === 'register'), {
      timeoutMs: 1_000,
      label: 'identity register message',
    });
    const registerMessage = messages.find((message) => message.type === 'register');
    expect(registerMessage).toMatchObject({
      type: 'register',
      workerId: 'identity-worker',
      deploymentName: 'payments',
      buildId: 'build-2026-05-12',
      runtimeVersion: 'bun-1.2.13',
      gitSha: '0123456789abcdef',
      startedAt: 1_778_608_000_000,
      capabilities: {
        region: 'us-west',
        canary: true,
      },
    });

    await worker.disconnect();
  });

  it('connect() rejects when registration is rejected', async () => {
    server = createTestServer({
      autoRegisterAck: false,
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'registerError',
              code: 'unsupported_protocol_version',
              message: 'Unsupported protocol',
              supportedProtocolVersions: [2],
              requestedProtocolVersion: 99,
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'rejected-worker',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await expect(worker.connect()).rejects.toThrow('Unsupported protocol');
    worker[Symbol.dispose]();
  });

  it('connect() rejects when the socket closes before registerAck', async () => {
    server = createTestServer({
      autoRegisterAck: false,
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        if (parsed.type === 'register') {
          ws.close();
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'close-before-ack-worker',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await expect(worker.connect()).rejects.toThrow(
      'WebSocket closed before worker registration completed',
    );
    worker[Symbol.dispose]();
  });

  it('[Symbol.dispose] rejects a pending connect() before registerAck', async () => {
    let registerReceived = false;
    server = createTestServer({
      autoRegisterAck: false,
      onMessage(_ws, message) {
        const parsed = JSON.parse(message);
        if (parsed.type === 'register') registerReceived = true;
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'dispose-before-ack-worker',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    const connectPromise = worker.connect();
    await waitForCondition(() => registerReceived, {
      timeoutMs: 1_000,
      label: 'register before dispose',
    });

    worker[Symbol.dispose]();

    const pendingTimeout = sleepForTesting(250).then(() => {
      throw new Error('connect() remained pending after worker disposal');
    });

    await expect(Promise.race([connectPromise, pendingTimeout])).rejects.toThrow(
      'Worker disposed before worker registration completed',
    );
  });

  it('starts heartbeats only after registerAck', async () => {
    const messages: any[] = [];
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let nextIntervalHandle = 0;
    let serverSocket: any;

    server = createTestServer({
      autoRegisterAck: false,
      onMessage(ws, message) {
        serverSocket = ws;
        messages.push(JSON.parse(message));
      },
    });

    globalThis.setInterval = ((callback: TimerHandler) => {
      const handle = ++nextIntervalHandle;
      queueMicrotask(() => {
        if (typeof callback === 'function') {
          callback();
        }
      });
      return handle as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((
      _handle: ReturnType<typeof setInterval>,
    ) => {}) as typeof clearInterval;

    try {
      const worker = new RemoteWorker({
        serverUrl: `ws://localhost:${server.port}`,
        workerId: 'ack-gated-heartbeat-worker',
        workflows: workflowsOf({
          processOrder: async (input) => input,
        }),
      });

      const connectPromise = worker.connect();
      await waitForCondition(() => messages.some((message) => message.type === 'register'), {
        timeoutMs: 1_000,
        label: 'register before ack',
      });
      await sleepForTesting(0);
      expect(messages.some((message) => message.type === 'heartbeat')).toBe(false);

      serverSocket.send(
        JSON.stringify({
          type: 'registerAck',
          protocolVersion: 2,
          workerId: 'ack-gated-heartbeat-worker',
          queue: 'default',
          activities: ['orders.processOrder'],
          concurrency: 10,
        }),
      );
      await connectPromise;
      await waitForCondition(() => messages.some((message) => message.type === 'heartbeat'), {
        timeoutMs: 1_000,
        label: 'heartbeat after ack',
      });

      await worker.disconnect();
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it('connect() rejects when connection fails', async () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:1',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await expect(worker.connect()).rejects.toThrow();
    worker[Symbol.dispose]();
  });

  it('disconnect() closes the WebSocket connection', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    await worker.disconnect();
    expect(worker.connected).toBe(false);
  });

  it('disconnect() is safe to call when not connected', async () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    // Should not throw
    await worker.disconnect();
    worker[Symbol.dispose]();
  });

  it('handles a task message and sends back a completed result', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        // After registration, send a task
        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-1',
              activityName: 'orders.processOrder',
              input: { orderId: 123 },
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'test-worker-2',
      workflows: workflowsOf({
        processOrder: async (input: any) => ({ processed: true, orderId: input.orderId }),
      }),
    });

    await worker.connect();

    const taskResult = await waitForTaskResult(messages, 'completed task result');
    expect(taskResult.operationId).toBe('op-1');
    expect(taskResult.status).toBe('completed');
    expect(taskResult.value).toEqual({ processed: true, orderId: 123 });

    await worker.disconnect();
  });

  it('handles a task for an unknown activity and sends failed result', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-2',
              activityName: 'nonExistentActivity',
              input: null,
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'test-worker-3',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await worker.connect();

    const taskResult = await waitForTaskResult(messages, 'unknown activity task result');
    expect(taskResult.operationId).toBe('op-2');
    expect(taskResult.status).toBe('failed');
    expect(taskResult.error).toContain('Unknown activity');

    await worker.disconnect();
  });

  it('handles a task that throws and sends failed result', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-3',
              activityName: 'orders.failingActivity',
              input: null,
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'test-worker-4',
      workflows: workflowsOf({
        failingActivity: async () => {
          throw new Error('activity crashed');
        },
      }),
    });

    await worker.connect();

    const taskResult = await waitForTaskResult(messages, 'throwing activity task result');
    expect(taskResult.operationId).toBe('op-3');
    expect(taskResult.status).toBe('failed');
    expect(taskResult.error).toBe('activity crashed');

    await worker.disconnect();
  });

  it('handles a non-Error throw and sends stringified error', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-4',
              activityName: 'orders.stringThrow',
              input: null,
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'test-worker-5',
      workflows: workflowsOf({
        stringThrow: async () => {
          throw 'string error';
        },
      }),
    });

    await worker.connect();

    const taskResult = await waitForTaskResult(messages, 'non-error throw task result');
    expect(taskResult.status).toBe('failed');
    expect(taskResult.error).toBe('string error');

    await worker.disconnect();
  });

  it('tracks inFlight count during task execution', async () => {
    let resolveActivity: (() => void) | undefined;
    const activityPromise = new Promise<void>((resolve) => {
      resolveActivity = resolve;
    });

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-5',
              activityName: 'orders.slowActivity',
              input: null,
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({
        slowActivity: async () => {
          await activityPromise;
          return 'done';
        },
      }),
    });

    await worker.connect();
    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 1_000,
      label: 'worker inFlight increment',
    });

    // Activity should be in-flight
    expect(worker.inFlight).toBe(1);

    // Resolve the activity
    resolveActivity!();
    await waitForCondition(() => worker.inFlight === 0, {
      timeoutMs: 1_000,
      label: 'worker inFlight drain',
    });

    expect(worker.inFlight).toBe(0);

    await worker.disconnect();
  });

  it('close event resets ws and stops heartbeat', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    // Stop the server, which will trigger the close event
    server.stop(true);
    server = undefined;
    await waitForCondition(() => !worker.connected, {
      timeoutMs: 1_000,
      label: 'worker close event disconnect',
    });

    expect(worker.connected).toBe(false);
    worker[Symbol.dispose]();
  });

  it('ignores non-task messages', async () => {
    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);

        if (parsed.type === 'register') {
          // Send a non-task message
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await worker.connect();
    await sleepForTesting(100);

    // Worker should still be connected and working fine
    expect(worker.connected).toBe(true);
    expect(worker.inFlight).toBe(0);

    await worker.disconnect();
  });

  it('sendMessage is a no-op when not connected (disposed before heartbeat fires)', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    // Dispose the worker (sets ws to null via close)
    worker[Symbol.dispose]();

    // Worker should no longer be connected
    expect(worker.connected).toBe(false);
  });

  it('sends heartbeat messages periodically', async () => {
    const messages: any[] = [];
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let nextIntervalHandle = 0;

    server = createTestServer({
      onMessage(_ws, message) {
        messages.push(JSON.parse(message));
      },
    });

    globalThis.setInterval = ((callback: TimerHandler) => {
      const handle = ++nextIntervalHandle;
      queueMicrotask(() => {
        if (typeof callback === 'function') {
          callback();
        }
      });
      return handle as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((
      _handle: ReturnType<typeof setInterval>,
    ) => {}) as typeof clearInterval;

    try {
      const worker = new RemoteWorker({
        serverUrl: `ws://localhost:${server.port}`,
        workerId: 'heartbeat-test',
        workflows: {},
      });

      await worker.connect();
      // Wait for both messages to actually arrive at the server rather
      // than racing the WebSocket round-trip with a fixed 50ms sleep.
      // The fake `setInterval` calls back via `queueMicrotask`, so the
      // heartbeat fires synchronously after the register handshake
      // completes — but the register itself depends on real socket I/O.
      await waitForCondition(
        () =>
          messages.some((message) => message.type === 'register') &&
          messages.some((message) => message.type === 'heartbeat'),
        { timeoutMs: 1_000, label: 'register and heartbeat both received' },
      );

      expect(messages.some((message) => message.type === 'register')).toBe(true);
      expect(messages.some((message) => message.type === 'heartbeat')).toBe(true);

      await worker.disconnect();
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it('shuttingDown is false initially', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    expect(worker.shuttingDown).toBe(false);
    worker[Symbol.dispose]();
  });

  it('handles shutdown message and gracefully shuts down', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          // Send a shutdown message
          ws.send(JSON.stringify({ type: 'shutdown' }));
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'shutdown-test',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    await waitForCondition(() => worker.shuttingDown && !worker.connected, {
      timeoutMs: 500,
      label: 'worker shutdown state transition',
    });

    expect(worker.shuttingDown).toBe(true);
    expect(worker.connected).toBe(false);

    worker[Symbol.dispose]();
  });

  it('graceful shutdown waits for in-flight tasks before closing', async () => {
    let resolveActivity: (() => void) | undefined;
    const activityPromise = new Promise<void>((resolve) => {
      resolveActivity = resolve;
    });
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          // Send a task first
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-shutdown-1',
              activityName: 'orders.slowActivity',
              input: null,
            }),
          );

          // Then send shutdown after a brief delay
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'shutdown' }));
          }, 50);
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'graceful-shutdown-test',
      workflows: workflowsOf({
        slowActivity: async () => {
          await activityPromise;
          return 'done';
        },
      }),
    });

    await worker.connect();
    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 500,
      label: 'slow activity to start',
    });

    // Task should be in-flight
    expect(worker.inFlight).toBe(1);

    await waitForCondition(() => worker.shuttingDown, {
      timeoutMs: 500,
      label: 'shutdown message',
    });
    expect(worker.shuttingDown).toBe(true);

    // Worker should still be connected (waiting for in-flight task)
    // The connection might be in process of closing, but inFlight > 0

    // Resolve the activity so the graceful shutdown can complete
    resolveActivity!();
    await waitForCondition(() => worker.inFlight === 0 && !worker.connected, {
      timeoutMs: 500,
      label: 'graceful shutdown completion',
    });

    expect(worker.inFlight).toBe(0);
    expect(worker.connected).toBe(false);

    // Verify the task result was sent
    const taskResult = messages.find((m) => m.type === 'taskResult');
    expect(taskResult).toBeDefined();
    expect(taskResult.status).toBe('completed');

    worker[Symbol.dispose]();
  });

  it('ignores task messages when shutting down', async () => {
    const messages: any[] = [];
    let tasksSentCount = 0;

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          // Send shutdown first
          ws.send(JSON.stringify({ type: 'shutdown' }));

          // Then try to send a task after shutdown is received
          setTimeout(() => {
            tasksSentCount++;
            ws.send(
              JSON.stringify({
                type: 'task',
                operationId: 'op-post-shutdown',
                activityName: 'orders.processOrder',
                input: null,
              }),
            );
          }, 100);
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'ignore-post-shutdown-test',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await worker.connect();
    await waitForCondition(() => tasksSentCount === 1, {
      timeoutMs: 500,
      label: 'post-shutdown task dispatch',
    });

    // Verify the task was sent by the server
    expect(tasksSentCount).toBe(1);

    // But no taskResult should have been produced for the post-shutdown task
    const taskResults = messages.filter((m) => m.type === 'taskResult');
    expect(taskResults.length).toBe(0);

    worker[Symbol.dispose]();
  });

  it('disconnect resolves after timeout when tasks are still in-flight', async () => {
    // A task that never resolves — it holds the in-flight counter at 1 forever
    const neverResolves = new Promise<never>(() => {});

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-timeout-1',
              activityName: 'orders.hangingActivity',
              input: null,
            }),
          );
        }
      },
    });

    const disconnectTimeoutMs = 200;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'disconnect-timeout-test',
      workflows: workflowsOf({
        hangingActivity: async () => {
          await neverResolves;
        },
      }),
      disconnectTimeoutMs,
    });

    await worker.connect();

    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 500,
      label: 'disconnect inFlight increment',
    });
    expect(worker.inFlight).toBe(1);

    const startTime = Date.now();

    // disconnect() must not hang — it should break out of the polling loop after the timeout
    await worker.disconnect();

    const elapsed = Date.now() - startTime;

    // Should have resolved within the timeout plus generous tolerance for CI jitter
    expect(elapsed).toBeLessThan(disconnectTimeoutMs + 500);

    // The connection should be closed even though a task is still technically "in-flight"
    expect(worker.connected).toBe(false);
  });

  it('graceful shutdown resolves after timeout when tasks are still in-flight', async () => {
    // A task that never resolves
    const neverResolves = new Promise<never>(() => {});

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);

        if (parsed.type === 'register') {
          // Dispatch a task that will never finish
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-shutdown-timeout-1',
              activityName: 'orders.hangingActivity',
              input: null,
            }),
          );

          // Send the shutdown command shortly after so the worker starts draining
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'shutdown' }));
          }, 50);
        }
      },
    });

    const disconnectTimeoutMs = 200;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'graceful-shutdown-timeout-test',
      workflows: workflowsOf({
        hangingActivity: async () => {
          await neverResolves;
        },
      }),
      disconnectTimeoutMs,
    });

    await worker.connect();

    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 500,
      label: 'hanging activity to start',
    });
    expect(worker.inFlight).toBe(1);

    await waitForCondition(() => worker.shuttingDown, {
      timeoutMs: 500,
      label: 'shutdown acknowledgement',
    });
    expect(worker.shuttingDown).toBe(true);

    const startTime = Date.now();

    const shutdownTimeoutMs = disconnectTimeoutMs + 500;
    await waitForCondition(() => !worker.connected, {
      timeoutMs: shutdownTimeoutMs,
      label: 'shutdown timeout completion',
    });

    const elapsed = Date.now() - startTime;

    // Should have closed within the timeout plus generous tolerance
    expect(elapsed).toBeLessThan(shutdownTimeoutMs);
    expect(worker.connected).toBe(false);

    worker[Symbol.dispose]();
  });

  it('[Symbol.dispose] closes connection when ws is open', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: {},
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    worker[Symbol.dispose]();
    expect(worker.connected).toBe(false);

    // Calling dispose again should not throw
    worker[Symbol.dispose]();
  });

  it('can reconnect after disconnect (AbortController is replaced)', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    await worker.disconnect();
    expect(worker.connected).toBe(false);

    // Reconnect — this would hang forever if the AbortController was not replaced
    await worker.connect();
    expect(worker.connected).toBe(true);

    await worker.disconnect();
  });

  it('can reconnect after graceful shutdown and accept new tasks', async () => {
    const messages: any[] = [];
    let connectionCount = 0;

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          connectionCount++;

          if (connectionCount === 1) {
            // First connection: trigger a graceful shutdown
            ws.send(JSON.stringify({ type: 'shutdown' }));
          } else if (connectionCount === 2) {
            // Second connection: send a task to prove messages are not dropped
            ws.send(
              JSON.stringify({
                type: 'task',
                operationId: 'op-post-reconnect',
                activityName: 'orders.processOrder',
                input: { orderId: 42 },
              }),
            );
          }
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'reconnect-after-shutdown-test',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    // First connection — server triggers shutdown
    await worker.connect();
    await waitForCondition(() => worker.shuttingDown && !worker.connected, {
      timeoutMs: 1_000,
      label: 'graceful shutdown before reconnect',
    });
    expect(worker.shuttingDown).toBe(true);
    expect(worker.connected).toBe(false);

    // Reconnect — connect() should reset #shuttingDown so tasks are accepted
    await worker.connect();
    expect(worker.shuttingDown).toBe(false);
    await waitForCondition(() => messages.some((message) => message.type === 'taskResult'), {
      timeoutMs: 1_000,
      label: 'post-reconnect task result',
    });

    // The task sent on the second connection should have been processed
    const taskResult = await waitForTaskResult(messages, 'post-reconnect task result');
    expect(taskResult.operationId).toBe('op-post-reconnect');
    expect(taskResult.status).toBe('completed');

    await worker.disconnect();
  });

  it('connect() rejects after dispose (disposal is terminal)', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    worker[Symbol.dispose]();
    expect(worker.connected).toBe(false);

    // Disposal is terminal: a disposed worker cannot be revived. Reconnection
    // is supported only via disconnect() + connect(), not after dispose.
    await expect(worker.connect()).rejects.toThrow(
      'RemoteWorker has been disposed and cannot reconnect',
    );
    expect(worker.connected).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Interceptor support tests
  // ---------------------------------------------------------------------------

  it('interceptor wraps activity execution', async () => {
    const messages: any[] = [];
    const interceptorCalls: string[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-intercept-1',
              activityName: 'orders.greet',
              input: 'world',
            }),
          );
        }
      },
    });

    const interceptor: ActivityInterceptor = {
      execute(context, next) {
        interceptorCalls.push(`before:${context.activityName}`);
        const result = next(context);
        interceptorCalls.push(`after:${context.activityName}`);
        return result;
      },
    };

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'interceptor-test',
      workflows: workflowsOf({
        greet: async (input: unknown) => `hello ${String(input)}`,
      }),
      interceptors: [interceptor],
    });

    await worker.connect();
    const taskResult = await waitForTaskResult(messages, 'intercepted task result');

    expect(interceptorCalls).toEqual(['before:orders.greet', 'after:orders.greet']);

    expect(taskResult.status).toBe('completed');
    expect(taskResult.value).toBe('hello world');

    await worker.disconnect();
  });

  it('interceptor can modify input', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-modify-input',
              activityName: 'orders.echo',
              input: 'original',
            }),
          );
        }
      },
    });

    const interceptor: ActivityInterceptor = {
      execute(context, next) {
        return next({ ...context, input: 'modified' });
      },
    };

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'modify-input-test',
      workflows: workflowsOf({
        echo: async (input: unknown) => input,
      }),
      interceptors: [interceptor],
    });

    await worker.connect();

    const taskResult = await waitForTaskResult(messages, 'modified input task result');
    expect(taskResult.status).toBe('completed');
    expect(taskResult.value).toBe('modified');

    await worker.disconnect();
  });

  it('interceptor receives propagated headers', async () => {
    const messages: any[] = [];
    let capturedHeaders: Map<string, string> | undefined;

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-headers',
              activityName: 'orders.echo',
              input: 'data',
              headers: { 'x-trace-id': 'trace-abc', 'x-auth': 'token-xyz' },
            }),
          );
        }
      },
    });

    const interceptor: ActivityInterceptor = {
      execute(context, next) {
        capturedHeaders = context.headers;
        return next(context);
      },
    };

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'headers-test',
      workflows: workflowsOf({
        echo: async (input: unknown) => input,
      }),
      interceptors: [interceptor],
    });

    await worker.connect();
    await waitForCondition(() => capturedHeaders !== undefined, {
      timeoutMs: 500,
      label: 'interceptor headers',
    });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.get('x-trace-id')).toBe('trace-abc');
    expect(capturedHeaders!.get('x-auth')).toBe('token-xyz');

    await worker.disconnect();
  });

  it('zero overhead without interceptors — activity runs directly', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-no-interceptor',
              activityName: 'orders.double',
              input: 21,
            }),
          );
        }
      },
    });

    // No interceptors configured
    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'no-interceptor-test',
      workflows: workflowsOf({
        double: async (input: unknown) => (input as number) * 2,
      }),
    });

    await worker.connect();

    const taskResult = await waitForTaskResult(messages, 'direct activity task result');
    expect(taskResult.status).toBe('completed');
    expect(taskResult.value).toBe(42);

    await worker.disconnect();
  });

  it('interceptor context includes operationId and signal', async () => {
    const messages: any[] = [];
    let capturedOperationId: string | undefined;
    let capturedSignal: AbortSignal | undefined;

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-context-check',
              activityName: 'orders.echo',
              input: 'test',
            }),
          );
        }
      },
    });

    const interceptor: ActivityInterceptor = {
      execute(context, next) {
        capturedOperationId = context.operationId;
        capturedSignal = context.signal;
        return next(context);
      },
    };

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'context-check-test',
      workflows: workflowsOf({
        echo: async (input: unknown) => input,
      }),
      interceptors: [interceptor],
    });

    await worker.connect();
    await waitForCondition(() => capturedOperationId !== undefined, {
      timeoutMs: 500,
      label: 'interceptor context',
    });

    expect(capturedOperationId).toBe('op-context-check');
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);

    await worker.disconnect();
  });

  // ---------------------------------------------------------------------------
  // Cancel support tests
  // ---------------------------------------------------------------------------

  it('handles cancel message and aborts in-flight task', async () => {
    const messages: any[] = [];
    let taskStarted = false;

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          // Send a task that will block until cancelled
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-cancel-1',
              activityName: 'orders.cancellableActivity',
              input: null,
            }),
          );

          // After a brief delay, send a cancel message
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'cancel', operationId: 'op-cancel-1' }));
          }, 100);
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'cancel-test-worker',
      workflows: workflowsOf({
        cancellableActivity: async (_input: unknown, context) => {
          taskStarted = true;
          // Wait indefinitely — the cancel should abort this via the signal
          return new Promise((_resolve, reject) => {
            context?.signal.addEventListener('abort', () => {
              reject(new Error('Aborted'));
            });
          });
        },
      }),
    });

    await worker.connect();

    await waitForCondition(() => messages.some((message) => message.type === 'taskResult'), {
      timeoutMs: 1_000,
      label: 'cancelled task result',
    });

    expect(taskStarted).toBe(true);

    const taskResult = messages.find((m) => m.type === 'taskResult');
    expect(taskResult).toBeDefined();
    expect(taskResult.operationId).toBe('op-cancel-1');
    expect(taskResult.status).toBe('cancelled');
    expect(taskResult.cancelled).toBe(true);

    await worker.disconnect();
  });

  it('cancel for unknown operationId is a no-op', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          // Send a cancel for a non-existent operationId
          ws.send(JSON.stringify({ type: 'cancel', operationId: 'non-existent-op' }));
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'cancel-noop-test',
      workflows: workflowsOf({
        processOrder: async (input) => input,
      }),
    });

    await worker.connect();
    await sleepForTesting(100);

    // Worker should still be connected and no taskResult should have been sent
    expect(worker.connected).toBe(true);
    expect(worker.inFlight).toBe(0);
    const taskResults = messages.filter((m) => m.type === 'taskResult');
    expect(taskResults.length).toBe(0);

    await worker.disconnect();
  });

  it('activity function receives AbortSignal via context', async () => {
    let receivedSignal: AbortSignal | undefined;
    let receivedWorkflowExecutionToken: string | undefined;
    let receivedActivityAttemptToken: string | undefined;
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-signal-check',
              activityName: 'orders.signalInspector',
              input: null,
              workflowExecutionToken: 'workflow-token-remote',
              attemptToken: 'attempt-token-remote',
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'signal-check-worker',
      workflows: workflowsOf({
        signalInspector: async (_input: unknown, context) => {
          receivedSignal = context?.signal;
          receivedWorkflowExecutionToken = context?.workflowExecutionToken;
          receivedActivityAttemptToken = context?.activityAttemptToken;
          return 'done';
        },
      }),
    });

    await worker.connect();
    const taskResult = await waitForTaskResult(messages, 'signal context task result');

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal!.aborted).toBe(false);
    expect(receivedWorkflowExecutionToken).toBe('workflow-token-remote');
    expect(receivedActivityAttemptToken).toBe('attempt-token-remote');

    expect(taskResult.status).toBe('completed');

    await worker.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle hazards: connect() re-entrancy + taskResult resend on reconnect
// ---------------------------------------------------------------------------

/**
 * Server harness that tracks every upgraded socket and the close count, and
 * captures worker→server frames per connection. Lets re-entrancy tests assert
 * that a superseded socket was actually closed and that no extra socket opened.
 */
function createTrackingServer(options?: {
  autoRegisterAck?: boolean;
  onMessage?: (ws: any, message: any, connectionIndex: number) => void;
}): {
  server: ReturnType<typeof Bun.serve>;
  sockets: any[];
  closeCount: () => number;
  messages: any[];
} {
  const sockets: any[] = [];
  const messages: any[] = [];
  let closes = 0;

  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request, { data: undefined })) return undefined;
      return new Response('ok');
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
      },
      message(ws, message) {
        const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
        const connectionIndex = sockets.indexOf(ws);
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        messages.push(parsed);
        const autoRegisterAck = options?.autoRegisterAck ?? true;
        if (autoRegisterAck && parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'registerAck',
              protocolVersion: 2,
              workerId: parsed.workerId,
              queue: parsed.queue ?? 'default',
              activities: parsed.activities,
              concurrency: parsed.concurrency ?? 10,
            }),
          );
        }
        options?.onMessage?.(ws, parsed, connectionIndex);
      },
      close(_ws) {
        closes += 1;
      },
    },
  });

  return { server, sockets, closeCount: () => closes, messages };
}

/**
 * A single long-lived server that acks every registration and routes frames by
 * registration index (0-based, in order of `register` receipt). The supplied
 * `onRegister` hook can deliver tasks and decide when to close a worker socket,
 * so reconnect tests never have to stop/restart the listener (which races on
 * port reuse). Frames other than `register` are recorded per registration index.
 */
function createReconnectServer(onRegister?: (ws: any, index: number) => void): {
  server: ReturnType<typeof Bun.serve>;
  /** Frames received on the Nth registration (always an array, even if empty). */
  framesFor: (index: number) => any[];
  /** Every frame across every registration. */
  allFrames: () => any[];
  /** The server-side socket for the Nth registration (for test-driven close). */
  socketFor: (index: number) => any;
  registerCount: () => number;
} {
  const messagesByRegistration: any[][] = [];
  const socketsByRegistration: any[] = [];
  let registers = 0;

  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request, { data: undefined })) return undefined;
      return new Response('ok');
    },
    websocket: {
      message(ws, message) {
        const parsed = JSON.parse(String(message));
        if (parsed.type === 'register') {
          const idx = registers++;
          (ws as any).__index = idx;
          messagesByRegistration[idx] = messagesByRegistration[idx] ?? [];
          socketsByRegistration[idx] = ws;
          ws.send(
            JSON.stringify({
              type: 'registerAck',
              protocolVersion: 2,
              workerId: parsed.workerId,
              queue: 'default',
              activities: parsed.activities,
              concurrency: 10,
            }),
          );
          onRegister?.(ws, idx);
        } else {
          const idx = (ws as any).__index as number;
          messagesByRegistration[idx] = messagesByRegistration[idx] ?? [];
          messagesByRegistration[idx].push(parsed);
        }
      },
      close(_ws) {},
    },
  });

  return {
    server,
    framesFor: (index: number) => messagesByRegistration[index] ?? [],
    allFrames: () => messagesByRegistration.flat(),
    socketFor: (index: number) => socketsByRegistration[index],
    registerCount: () => registers,
  };
}

describe('RemoteWorker — connect() re-entrancy', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    restoreRealTimers();
    if (server) {
      server.stop(true);
      server = undefined;
    }
  });

  it('a second connect() while registration is pending settles the first promise', async () => {
    let registerCount = 0;
    let ackSocket: any;
    const tracking = createTrackingServer({
      autoRegisterAck: false,
      onMessage(ws, parsed) {
        if (parsed.type === 'register') {
          registerCount += 1;
          // Only ack the *second* registration so the first connect() is left
          // pending until it is superseded.
          if (registerCount === 2) ackSocket = ws;
        }
      },
    });
    server = tracking.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({ processOrder: async (input) => input }),
    });

    const first = worker.connect();
    await waitForCondition(() => registerCount === 1, {
      timeoutMs: 1_000,
      label: 'first register received',
    });

    const second = worker.connect();

    // The first promise must settle (reject) rather than hang forever.
    const firstHang = sleepForTesting(250).then(() => {
      throw new Error('first connect() remained pending after supersession');
    });
    await expect(Promise.race([first, firstHang])).rejects.toThrow(
      'Superseded by a new connect() call',
    );

    await waitForCondition(() => registerCount === 2 && ackSocket !== undefined, {
      timeoutMs: 1_000,
      label: 'second register received',
    });
    ackSocket.send(
      JSON.stringify({
        type: 'registerAck',
        protocolVersion: 2,
        workerId: 'reentrancy-worker',
        queue: 'default',
        activities: [],
        concurrency: 10,
      }),
    );

    await expect(second).resolves.toBeUndefined();
    expect(worker.connected).toBe(true);

    await worker.disconnect();
  });

  it('a second connect() from a pending state closes the prior socket', async () => {
    let registerCount = 0;
    const tracking = createTrackingServer({
      autoRegisterAck: false,
      onMessage(ws, parsed) {
        if (parsed.type === 'register') {
          registerCount += 1;
          // Ack only the second registration.
          if (registerCount === 2) {
            ws.send(
              JSON.stringify({
                type: 'registerAck',
                protocolVersion: 2,
                workerId: parsed.workerId,
                queue: 'default',
                activities: parsed.activities,
                concurrency: 10,
              }),
            );
          }
        }
      },
    });
    server = tracking.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({ processOrder: async (input) => input }),
    });

    const first = worker.connect();
    await waitForCondition(() => registerCount === 1, {
      timeoutMs: 1_000,
      label: 'first register',
    });
    first.catch(() => {});

    await worker.connect();
    expect(worker.connected).toBe(true);

    // The prior socket must have been closed by the re-entrancy teardown.
    await waitForCondition(() => tracking.closeCount() >= 1, {
      timeoutMs: 1_000,
      label: 'prior socket closed',
    });
    expect(tracking.closeCount()).toBeGreaterThanOrEqual(1);

    await worker.disconnect();
  });

  it('a redundant connect() on an already-connected worker is a no-op', async () => {
    const tracking = createTrackingServer();
    server = tracking.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({ processOrder: async (input) => input }),
    });

    await worker.connect();
    expect(worker.connected).toBe(true);
    expect(tracking.sockets.length).toBe(1);

    // Redundant connect() must not open a second socket or close the live one.
    await expect(worker.connect()).resolves.toBeUndefined();
    // Give any stray socket activity a chance to surface.
    await sleepForTesting(50);
    expect(tracking.sockets.length).toBe(1);
    expect(tracking.closeCount()).toBe(0);
    expect(worker.connected).toBe(true);

    await worker.disconnect();
  });

  it('a late registerAck from a superseded socket fires no handler', async () => {
    let registerCount = 0;
    let firstSocket: any;
    let secondSocket: any;
    const tracking = createTrackingServer({
      autoRegisterAck: false,
      onMessage(ws, parsed) {
        if (parsed.type === 'register') {
          registerCount += 1;
          if (registerCount === 1) firstSocket = ws;
          if (registerCount === 2) secondSocket = ws;
        }
      },
    });
    server = tracking.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({ processOrder: async (input) => input }),
    });

    const first = worker.connect();
    await waitForCondition(() => firstSocket !== undefined, {
      timeoutMs: 1_000,
      label: 'first socket',
    });
    first.catch(() => {});

    const second = worker.connect();
    await waitForCondition(() => secondSocket !== undefined, {
      timeoutMs: 1_000,
      label: 'second socket',
    });

    // Deliver a late ack on the SUPERSEDED first socket. Its listeners were
    // detached by the abort-before-attach teardown, so this must not resolve
    // the second pending registration. The second connect() promise must still
    // be pending after the stale ack.
    let secondSettled = false;
    void second.then(
      () => (secondSettled = true),
      () => (secondSettled = true),
    );

    firstSocket.send(
      JSON.stringify({
        type: 'registerAck',
        protocolVersion: 2,
        workerId: 'late',
        queue: 'default',
        activities: [],
        concurrency: 10,
      }),
    );
    await sleepForTesting(50);
    expect(secondSettled).toBe(false);

    // The second (current) socket's ack still works normally.
    secondSocket.send(
      JSON.stringify({
        type: 'registerAck',
        protocolVersion: 2,
        workerId: 'current',
        queue: 'default',
        activities: [],
        concurrency: 10,
      }),
    );
    await expect(second).resolves.toBeUndefined();
    expect(worker.connected).toBe(true);

    await worker.disconnect();
  });
});

describe('RemoteWorker — taskResult resend on reconnect', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    restoreRealTimers();
    globalThis.WebSocket = originalWebSocket;
    if (server) {
      server.stop(true);
      server = undefined;
    }
  });

  it('buffers a result produced while the socket is down and flushes it on reconnect', async () => {
    let resolveActivity: ((value: string) => void) | undefined;
    const activityPromise = new Promise<string>((resolve) => {
      resolveActivity = resolve;
    });

    // Keep the server listening across the disconnect; close only the worker's
    // socket so reconnect to the same URL succeeds.
    const harness = createReconnectServer((ws, idx) => {
      if (idx === 0) {
        ws.send(
          JSON.stringify({
            type: 'task',
            operationId: 'op-buffer',
            activityName: 'orders.slow',
            input: null,
          }),
        );
      }
    });
    server = harness.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({
        slow: async () => activityPromise,
      }),
    });

    await worker.connect();
    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 1_000,
      label: 'activity in flight',
    });

    // Deterministically close the worker's socket now that the activity is
    // confirmed in flight (no timer race).
    harness.socketFor(0).close();
    await waitForCondition(() => !worker.connected, {
      timeoutMs: 1_000,
      label: 'socket down',
    });

    // Complete the activity while the socket is down → result must be buffered.
    resolveActivity!('buffered-value');
    await waitForCondition(() => worker.inFlight === 0, {
      timeoutMs: 1_000,
      label: 'activity drained',
    });
    expect(harness.framesFor(0).some((m) => m.type === 'taskResult')).toBe(false);

    // Reconnect to the same still-listening server.
    await worker.connect();
    await waitForCondition(() => harness.framesFor(1).some((m) => m.type === 'taskResult'), {
      timeoutMs: 1_000,
      label: 'buffered result flushed on reconnect',
    });

    const flushed = harness.framesFor(1).find((m) => m.type === 'taskResult');
    expect(flushed.operationId).toBe('op-buffer');
    expect(flushed.status).toBe('completed');
    expect(flushed.value).toBe('buffered-value');

    await worker.disconnect();
  });

  it('sends a result immediately when connected and registered (no later duplicate)', async () => {
    const allFrames: any[] = [];
    // Deliver the task only on the first registration so a later reconnect
    // cannot re-deliver it; any second taskResult would have to come from the
    // outbox re-flushing an already-sent result.
    const harness = createReconnectServer((ws, idx) => {
      if (idx === 0) {
        ws.send(
          JSON.stringify({
            type: 'task',
            operationId: 'op-immediate',
            activityName: 'orders.echo',
            input: 'hi',
          }),
        );
      }
    });
    server = harness.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({ echo: async (input) => input }),
    });

    await worker.connect();
    await waitForCondition(() => harness.framesFor(0).some((m) => m.type === 'taskResult'), {
      timeoutMs: 1_000,
      label: 'immediate result',
    });
    allFrames.push(...harness.allFrames());
    const count = allFrames.filter((m) => m.type === 'taskResult').length;
    expect(count).toBe(1);

    // A subsequent reconnect must not re-flush an already-sent result.
    await worker.disconnect();
    await worker.connect();
    await sleepForTesting(50);
    const total = harness.allFrames().filter((m) => m.type === 'taskResult').length;
    expect(total).toBe(1);

    await worker.disconnect();
  });

  it('buffers a failed result and flushes it on reconnect', async () => {
    let resolveBlock: (() => void) | undefined;
    const blockPromise = new Promise<void>((resolve) => {
      resolveBlock = resolve;
    });

    const harness = createReconnectServer((ws, idx) => {
      if (idx === 0) {
        ws.send(
          JSON.stringify({
            type: 'task',
            operationId: 'op-fail',
            activityName: 'orders.boom',
            input: null,
          }),
        );
      }
    });
    server = harness.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({
        boom: async () => {
          await blockPromise;
          throw new Error('activity blew up');
        },
      }),
    });

    await worker.connect();
    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 1_000,
      label: 'boom in flight',
    });
    harness.socketFor(0).close();
    await waitForCondition(() => !worker.connected, {
      timeoutMs: 1_000,
      label: 'socket down before failure',
    });

    resolveBlock!();
    await waitForCondition(() => worker.inFlight === 0, {
      timeoutMs: 1_000,
      label: 'boom drained',
    });
    expect(harness.framesFor(0).some((m) => m.type === 'taskResult')).toBe(false);

    await worker.connect();
    await waitForCondition(() => harness.framesFor(1).some((m) => m.type === 'taskResult'), {
      timeoutMs: 1_000,
      label: 'failed result flushed',
    });

    const flushed = harness.framesFor(1).find((m) => m.type === 'taskResult');
    expect(flushed.operationId).toBe('op-fail');
    expect(flushed.status).toBe('failed');
    expect(flushed.error).toBe('activity blew up');

    await worker.disconnect();
  });

  it('does not enter the outbox when an activity resolves after dispose', async () => {
    let resolveActivity: ((value: string) => void) | undefined;
    const activityPromise = new Promise<string>((resolve) => {
      resolveActivity = resolve;
    });

    const harness = createReconnectServer((ws, idx) => {
      if (idx === 0) {
        ws.send(
          JSON.stringify({
            type: 'task',
            operationId: 'op-after-dispose',
            activityName: 'orders.slow',
            input: null,
          }),
        );
      }
    });
    server = harness.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({ slow: async () => activityPromise }),
    });

    await worker.connect();
    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 1_000,
      label: 'slow in flight before dispose',
    });
    harness.socketFor(0).close();
    await waitForCondition(() => !worker.connected, {
      timeoutMs: 1_000,
      label: 'socket down before dispose',
    });

    worker[Symbol.dispose]();
    // Activity resolves AFTER disposal — its result must be dropped, not buffered.
    resolveActivity!('too-late');
    await sleepForTesting(50);

    // Post-dispose connect() rejects (terminal contract); nothing flushes.
    await expect(worker.connect()).rejects.toThrow(
      'RemoteWorker has been disposed and cannot reconnect',
    );
    await sleepForTesting(50);
    expect(harness.framesFor(1).some((m) => m.type === 'taskResult')).toBe(false);
  });
});

describe('RemoteWorker — send-failure recovery and backpressure', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    restoreRealTimers();
    globalThis.WebSocket = originalWebSocket;
    if (server) {
      server.stop(true);
      server = undefined;
    }
  });

  /**
   * Patch the global WebSocket with a wrapper whose `send()` throws once on
   * demand while `readyState` still reports OPEN — the real "socket died in the
   * gap after the readyState check" race, made deterministic.
   */
  function installSendThrottle(): { armThrow: () => void } {
    const control = { shouldThrow: false };
    class ThrowingWebSocket extends originalWebSocket {
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        // Only sabotage taskResult frames so register/heartbeat sends still
        // succeed; the race we model is a result send failing mid-flight.
        const isTaskResult = typeof data === 'string' && data.includes('"type":"taskResult"');
        if (control.shouldThrow && isTaskResult) {
          control.shouldThrow = false;
          throw new Error('simulated send failure');
        }
        super.send(data as any);
      }
    }
    globalThis.WebSocket = ThrowingWebSocket as unknown as typeof WebSocket;
    return { armThrow: () => (control.shouldThrow = true) };
  }

  it('recovers a result when send() throws in #sendTaskResult while OPEN', async () => {
    const { armThrow } = installSendThrottle();

    let resolveActivity: ((v: string) => void) | undefined;
    const activityPromise = new Promise<string>((resolve) => (resolveActivity = resolve));

    const harness = createReconnectServer((ws, idx) => {
      if (idx === 0) {
        ws.send(
          JSON.stringify({
            type: 'task',
            operationId: 'op-throw',
            activityName: 'orders.slow',
            input: null,
          }),
        );
      }
    });
    server = harness.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({ slow: async () => activityPromise }),
    });

    await worker.connect();
    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 1_000,
      label: 'slow in flight',
    });

    // Arm the throw so the upcoming taskResult send fails while OPEN.
    armThrow();
    resolveActivity!('recovered-value');

    // The send failure must fail the socket (worker becomes disconnected).
    await waitForCondition(() => !worker.connected, {
      timeoutMs: 1_000,
      label: 'socket failed after send throw',
    });
    expect(harness.framesFor(0).some((m) => m.type === 'taskResult')).toBe(false);

    // Reconnect flushes the buffered result — no external trigger beyond connect().
    await worker.connect();
    await waitForCondition(() => harness.framesFor(1).some((m) => m.type === 'taskResult'), {
      timeoutMs: 1_000,
      label: 'result flushed after send-throw recovery',
    });
    const flushed = harness.framesFor(1).find((m) => m.type === 'taskResult');
    expect(flushed.operationId).toBe('op-throw');
    expect(flushed.status).toBe('completed');
    expect(flushed.value).toBe('recovered-value');

    await worker.disconnect();
  });

  it('rejects connect() when send() throws during the registerAck flush, then recovers', async () => {
    const { armThrow } = installSendThrottle();

    let resolveActivity: ((v: string) => void) | undefined;
    const activityPromise = new Promise<string>((resolve) => (resolveActivity = resolve));

    const harness = createReconnectServer((ws, idx) => {
      if (idx === 0) {
        ws.send(
          JSON.stringify({
            type: 'task',
            operationId: 'op-flush-throw',
            activityName: 'orders.slow',
            input: null,
          }),
        );
      }
    });
    server = harness.server;

    // Registration 0: deliver task, then drop so the result buffers.
    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({ slow: async () => activityPromise }),
    });
    await worker.connect();
    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 1_000,
      label: 'flush-throw in flight',
    });
    harness.socketFor(0).close();
    await waitForCondition(() => !worker.connected, {
      timeoutMs: 1_000,
      label: 'socket down (flush-throw)',
    });
    resolveActivity!('flush-value');
    await waitForCondition(() => worker.inFlight === 0, {
      timeoutMs: 1_000,
      label: 'flush-throw drained',
    });

    // Registration 1: ack arrives, but the flush send throws → connect() rejects.
    armThrow();
    await expect(worker.connect()).rejects.toThrow(
      'reconnect required: result flush failed during registration',
    );
    expect(worker.connected).toBe(false);
    expect(harness.framesFor(1).some((m) => m.type === 'taskResult')).toBe(false);

    // Registration 2: a fresh connect() re-registers and flushes the survivor.
    await worker.connect();
    await waitForCondition(() => harness.framesFor(2).some((m) => m.type === 'taskResult'), {
      timeoutMs: 1_000,
      label: 'survivor flushed on retry',
    });
    const flushed = harness.framesFor(2).find((m) => m.type === 'taskResult');
    expect(flushed.operationId).toBe('op-flush-throw');
    expect(flushed.status).toBe('completed');

    await worker.disconnect();
  });

  it('does not send a result before registration completes (open but not acked)', async () => {
    const messagesByRegistration: any[][] = [];
    let registers = 0;
    let resolveActivity: ((v: string) => void) | undefined;
    const activityPromise = new Promise<string>((resolve) => (resolveActivity = resolve));
    let ackSecond: (() => void) | undefined;
    let firstSocket: any;

    // One long-lived server. Registration 0 is acked immediately and gets a
    // task; registration 1's ack is withheld until the test triggers it, so we
    // can observe the open-but-not-acked window.
    server = Bun.serve({
      port: 0,
      fetch(request, srv) {
        if (srv.upgrade(request, { data: undefined })) return undefined;
        return new Response('ok');
      },
      websocket: {
        message(ws, message) {
          const parsed = JSON.parse(String(message));
          if (parsed.type === 'register') {
            const idx = registers++;
            (ws as any).__index = idx;
            messagesByRegistration[idx] = messagesByRegistration[idx] ?? [];
            if (idx === 0) {
              firstSocket = ws;
              ws.send(
                JSON.stringify({
                  type: 'registerAck',
                  protocolVersion: 2,
                  workerId: parsed.workerId,
                  queue: 'default',
                  activities: parsed.activities,
                  concurrency: 10,
                }),
              );
              ws.send(
                JSON.stringify({
                  type: 'task',
                  operationId: 'op-preack',
                  activityName: 'orders.slow',
                  input: null,
                }),
              );
            } else {
              ackSecond = () =>
                ws.send(
                  JSON.stringify({
                    type: 'registerAck',
                    protocolVersion: 2,
                    workerId: parsed.workerId,
                    queue: 'default',
                    activities: parsed.activities,
                    concurrency: 10,
                  }),
                );
            }
          } else {
            const idx = (ws as any).__index as number;
            messagesByRegistration[idx] = messagesByRegistration[idx] ?? [];
            messagesByRegistration[idx].push(parsed);
          }
        },
        close(_ws) {},
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({ slow: async () => activityPromise }),
    });
    await worker.connect();
    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 1_000,
      label: 'preack in flight',
    });
    firstSocket.close();
    await waitForCondition(() => !worker.connected, {
      timeoutMs: 1_000,
      label: 'socket down (preack)',
    });
    resolveActivity!('preack-value');
    await waitForCondition(() => worker.inFlight === 0, {
      timeoutMs: 1_000,
      label: 'preack drained',
    });

    const connectPromise = worker.connect();
    await waitForCondition(() => ackSecond !== undefined, {
      timeoutMs: 1_000,
      label: 'second register received (pre-ack)',
    });

    const framesFor = (index: number): any[] => messagesByRegistration[index] ?? [];

    // The socket is OPEN but not yet acked — no taskResult may have been sent.
    await sleepForTesting(50);
    expect(framesFor(1).some((m) => m.type === 'taskResult')).toBe(false);

    // Now ack → the buffered result flushes.
    ackSecond!();
    await connectPromise;
    await waitForCondition(() => framesFor(1).some((m) => m.type === 'taskResult'), {
      timeoutMs: 1_000,
      label: 'preack result flushed after ack',
    });
    const flushed = framesFor(1).find((m) => m.type === 'taskResult');
    expect(flushed.operationId).toBe('op-preack');

    await worker.disconnect();
  });

  it('declines a task without executing or emitting a frame when the buffer is full', async () => {
    // A zero-capacity outbox is full from construction (isOutboxFull(0, 0) is
    // true), so #executeTask hits the backpressure branch on the very first
    // task — over a healthy, registered socket, with no flush and no timer
    // race. This pins the decline branch itself (not a listener-detachment
    // side effect): the activity body must never run, no taskResult frame is
    // emitted, and the socket is failed so the server can redeliver.
    let declinedRan = false;
    const harness = createReconnectServer((ws, idx) => {
      if (idx === 0) {
        ws.send(
          JSON.stringify({
            type: 'task',
            operationId: 'op-declined',
            activityName: 'orders.declined',
            input: null,
          }),
        );
      }
    });
    server = harness.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      maxBufferedResults: 0,
      workflows: workflowsOf({
        declined: async () => {
          declinedRan = true;
          return 'should-not-run';
        },
      }),
    });

    await worker.connect();
    // The decline path fails the socket, so the worker disconnects without ever
    // running the activity. Waiting on that observable condition (not a sleep)
    // proves the branch fired.
    await waitForCondition(() => !worker.connected, {
      timeoutMs: 1_000,
      label: 'socket failed by backpressure decline',
    });

    expect(declinedRan).toBe(false);
    expect(worker.inFlight).toBe(0);
    expect(harness.allFrames().some((m) => m.type === 'taskResult')).toBe(false);
  });

  it('a frame on a failed socket cannot mutate the new connection state', async () => {
    const { armThrow } = installSendThrottle();
    let failedSocket: any;
    let resolveActivity: ((v: string) => void) | undefined;
    const activityPromise = new Promise<string>((resolve) => (resolveActivity = resolve));

    const harness = createReconnectServer((ws, idx) => {
      if (idx === 0) {
        failedSocket = ws;
        ws.send(
          JSON.stringify({
            type: 'task',
            operationId: 'op-failsock',
            activityName: 'orders.slow',
            input: null,
          }),
        );
      }
    });
    server = harness.server;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workflows: workflowsOf({ slow: async () => activityPromise }),
    });
    await worker.connect();
    await waitForCondition(() => worker.inFlight === 1, {
      timeoutMs: 1_000,
      label: 'failsock in flight',
    });

    armThrow();
    resolveActivity!('v');
    await waitForCondition(() => !worker.connected, {
      timeoutMs: 1_000,
      label: 'socket failed (failsock)',
    });

    // Reconnect to the same still-listening server.
    await worker.connect();
    await waitForCondition(() => worker.connected, {
      timeoutMs: 1_000,
      label: 'reconnected after failsock',
    });

    // The old (failed) socket's listeners were detached. A late `shutdown`
    // frame on it would, if a listener were still attached, drive a graceful
    // shutdown of the worker — so assert we stay connected.
    if (failedSocket) {
      try {
        failedSocket.send(JSON.stringify({ type: 'shutdown' }));
      } catch {
        // Socket already closed server-side — fine.
      }
    }
    await sleepForTesting(50);
    expect(worker.connected).toBe(true);

    await worker.disconnect();
  });
});
