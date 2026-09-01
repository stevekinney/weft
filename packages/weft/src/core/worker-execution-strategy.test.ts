import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  advanceTimersByTime,
  restoreRealTimers,
  sleepForTesting,
  useFakeTimers,
  waitForCondition,
} from '../testing/fake-timers.test-support.ts';

import { buildInternalRealmManifest } from '../worker/manifest/internal-realm.ts';
import type { WorkerPool } from '../workers/pool.ts';
import type { WorkerOutboundMessage } from './types.ts';
import { WorkerExecutionStrategy } from './worker-execution-strategy.ts';
import { WORKER_PROTOCOL_VERSION } from './worker-protocol.ts';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockWorker {
  postMessage: ReturnType<typeof mock>;
  terminate: ReturnType<typeof mock>;
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
  // Internal: stored listeners for test simulation
  _listeners: Map<string, Set<EventListener>>;
}

function createMockWorker(): MockWorker {
  const listeners = new Map<string, Set<EventListener>>();

  return {
    postMessage: mock(() => {}),
    terminate: mock(() => {}),
    addEventListener(type: string, listener: EventListener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    _listeners: listeners,
  };
}

/** Simulate dispatching an event to a mock worker's listeners. */
function dispatchToMockWorker(worker: MockWorker, type: string, event: Event): void {
  const typeListeners = worker._listeners.get(type);
  if (typeListeners) {
    for (const listener of typeListeners) {
      listener(event);
    }
  }
}

async function withMockBroadcastChannel(
  run: (harness: {
    latestListener: () => ((event: MessageEvent) => void) | undefined;
  }) => Promise<void>,
): Promise<void> {
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  let broadcastListener: ((event: MessageEvent) => void) | undefined;

  class MockBroadcastChannel {
    addEventListener(_type: string, listener: (event: MessageEvent) => void): void {
      broadcastListener = listener;
    }

    removeEventListener(): void {}

    close(): void {}
  }

  globalThis.BroadcastChannel = MockBroadcastChannel as unknown as typeof BroadcastChannel;

  try {
    await run({ latestListener: () => broadcastListener });
  } finally {
    globalThis.BroadcastChannel = originalBroadcastChannel;
  }
}

function createMockPool(workers: MockWorker[]): WorkerPool {
  const available = [...workers];
  const pending: Array<(worker: Worker) => void> = [];
  const specificPending = new Map<
    MockWorker,
    Array<{ resolve: (worker: Worker) => void; reject: (error: Error) => void }>
  >();
  const released: MockWorker[] = [];

  return {
    acquire: mock(async () => {
      const worker = available.shift();
      if (worker) {
        return worker as unknown as Worker;
      }
      if (workers.length === 0) {
        throw new Error('No more workers');
      }
      return new Promise<Worker>((resolve) => {
        pending.push(resolve);
      });
    }),
    acquireSpecificWorker: mock(async (worker: Worker) => {
      const mockWorker = worker as unknown as MockWorker;
      if (!workers.includes(mockWorker)) {
        throw new Error('Worker does not belong to this WorkerPool');
      }

      const availableIndex = available.indexOf(mockWorker);
      if (availableIndex >= 0) {
        available.splice(availableIndex, 1);
        return worker;
      }

      return new Promise<Worker>((resolve, reject) => {
        const waiters = specificPending.get(mockWorker) ?? [];
        waiters.push({ resolve, reject });
        specificPending.set(mockWorker, waiters);
      });
    }),
    release: mock((worker: Worker) => {
      const mockWorker = worker as unknown as MockWorker;
      released.push(mockWorker);
      const specificWaiters = specificPending.get(mockWorker);
      if (specificWaiters && specificWaiters.length > 0) {
        const nextSpecificWaiter = specificWaiters.shift();
        if (specificWaiters.length === 0) {
          specificPending.delete(mockWorker);
        }
        nextSpecificWaiter?.resolve(worker);
        return;
      }

      const next = pending.shift();
      if (next) {
        next(worker);
        return;
      }
      available.push(mockWorker);
    }),
    discard: mock((worker: Worker) => {
      const mockWorker = worker as unknown as MockWorker;
      const availableIndex = available.indexOf(mockWorker);
      if (availableIndex >= 0) {
        available.splice(availableIndex, 1);
      }
      const waiters = specificPending.get(mockWorker) ?? [];
      specificPending.delete(mockWorker);
      for (const waiter of waiters) {
        waiter.reject(new Error('Worker was discarded from this WorkerPool'));
      }
      mockWorker.terminate();
    }),
    get availableCount() {
      return available.length;
    },
    get totalCount() {
      return workers.length;
    },
    get pendingCount() {
      return pending.length;
    },
    [Symbol.dispose]() {},
    async [Symbol.asyncDispose]() {},
  } as unknown as WorkerPool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerExecutionStrategy', () => {
  let strategy: WorkerExecutionStrategy;
  let messages: WorkerOutboundMessage[];
  let mockWorkers: MockWorker[];
  let mockPool: WorkerPool;

  afterEach(() => {
    strategy?.[Symbol.dispose]();
    restoreRealTimers();
  });

  function setup(
    workerCount: number = 1,
    options?: ConstructorParameters<typeof WorkerExecutionStrategy>[1],
  ): void {
    mockWorkers = Array.from({ length: workerCount }, () => createMockWorker());
    mockPool = createMockPool(mockWorkers);
    strategy = new WorkerExecutionStrategy(mockPool, options);
    messages = [];
    strategy.onMessage((message) => {
      messages.push(message);
    });
  }

  /** Return the first mock worker, asserting it exists. */
  function firstWorker(): MockWorker {
    const worker = mockWorkers[0];
    expect(worker).toBeDefined();
    return worker!;
  }

  /** Return the first message, asserting it exists. */
  function firstMessage(): WorkerOutboundMessage {
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message).toBeDefined();
    return message!;
  }

  function lastMessage(): WorkerOutboundMessage {
    const message = messages.at(-1);
    expect(message).toBeDefined();
    return message!;
  }

  // -------------------------------------------------------------------------
  // startWorkflow
  // -------------------------------------------------------------------------

  describe('startWorkflow', () => {
    it('acquires a worker and sends a run message', async () => {
      setup();

      const checkpoint = new ArrayBuffer(8);
      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowExecutionToken: 'workflow-token-strategy',
        workflowType: 'test',
        input: { value: 42 },
        checkpoint,
      });

      // Allow the async acquire to complete
      await sleepForTesting(10);

      const worker = firstWorker();
      expect(mockPool.acquire).toHaveBeenCalled();
      expect(worker.postMessage).toHaveBeenCalledTimes(1);

      const sentMessage = worker.postMessage.mock.calls[0]![0];
      expect(sentMessage.type).toBe('run');
      expect(sentMessage.workflowId).toBe('wf-1');
      expect(sentMessage.workflowExecutionToken).toBe('workflow-token-strategy');
      expect(sentMessage.workflowType).toBe('test');
      expect(sentMessage.input).toEqual({ value: 42 });
    });

    it('wires up onmessage on the acquired worker', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();
      // Verify that message listeners were added to the worker
      expect(worker._listeners.get('message')?.size).toBeGreaterThan(0);
    });

    it('emits a failed message if pool acquisition fails', async () => {
      mockWorkers = [];
      mockPool = createMockPool([]);
      strategy = new WorkerExecutionStrategy(mockPool);
      messages = [];
      strategy.onMessage((message) => {
        messages.push(message);
      });

      strategy.startWorkflow({
        workflowId: 'wf-fail',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      expect(message.workflowId).toBe('wf-fail');
    });
  });

  describe('broadcast forwarding', () => {
    it('forwards signal:received messages from BroadcastChannel to the assigned worker', async () => {
      await withMockBroadcastChannel(async ({ latestListener }) => {
        setup();
        strategy[Symbol.dispose]();
        strategy = new WorkerExecutionStrategy(mockPool, { broadcastEvents: true });
        messages = [];
        strategy.onMessage((message) => {
          messages.push(message);
        });

        strategy.startWorkflow({
          workflowId: 'wf-broadcast',
          workflowType: 'test',
          input: null,
          checkpoint: new ArrayBuffer(0),
        });

        await sleepForTesting(10);

        const worker = firstWorker();
        const callsBefore = worker.postMessage.mock.calls.length;
        const broadcastListener = latestListener();
        expect(broadcastListener).toBeDefined();

        broadcastListener!(
          new MessageEvent('message', {
            data: { type: 'signal:received', workflowId: 'wf-broadcast', signalName: 'ready' },
          }),
        );

        expect(worker.postMessage.mock.calls.length).toBe(callsBefore + 1);
        expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual({
          type: 'signal:received',
          workflowId: 'wf-broadcast',
          signalName: 'ready',
        });
      });
    });

    it('forwards signal:received messages from BroadcastChannel to a parked worker', async () => {
      await withMockBroadcastChannel(async ({ latestListener }) => {
        setup();
        strategy[Symbol.dispose]();
        strategy = new WorkerExecutionStrategy(mockPool, { broadcastEvents: true });
        messages = [];
        strategy.onMessage((message) => {
          messages.push(message);
        });

        strategy.startWorkflow({
          workflowId: 'wf-parked-broadcast',
          workflowType: 'test',
          input: null,
          checkpoint: new ArrayBuffer(0),
        });

        await sleepForTesting(10);

        const worker = firstWorker();
        dispatchToMockWorker(
          worker,
          'message',
          new MessageEvent('message', {
            data: {
              type: 'checkpoint',
              workflowId: 'wf-parked-broadcast',
              checkpoint: new ArrayBuffer(0),
              operationRequest: {
                type: 'wait-signal',
                operationId: 'op-wait',
                signalName: 'ready',
              },
            } satisfies WorkerOutboundMessage,
          }),
        );

        const callsBefore = worker.postMessage.mock.calls.length;
        const broadcastListener = latestListener();
        expect(broadcastListener).toBeDefined();

        broadcastListener!(
          new MessageEvent('message', {
            data: {
              type: 'signal:received',
              workflowId: 'wf-parked-broadcast',
              signalName: 'ready',
            },
          }),
        );

        expect(worker.postMessage.mock.calls.length).toBe(callsBefore + 1);
        expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual({
          type: 'signal:received',
          workflowId: 'wf-parked-broadcast',
          signalName: 'ready',
        });
      });
    });

    it('ignores missing BroadcastChannel support when broadcastEvents is enabled', () => {
      const originalBroadcastChannel = globalThis.BroadcastChannel;

      const UnavailableBroadcastChannel = function (): never {
        throw new Error('BroadcastChannel unavailable');
      };
      globalThis.BroadcastChannel =
        UnavailableBroadcastChannel as unknown as typeof BroadcastChannel;

      try {
        expect(() => {
          strategy = new WorkerExecutionStrategy(createMockPool([]), { broadcastEvents: true });
        }).not.toThrow();
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Worker message forwarding
  // -------------------------------------------------------------------------

  describe('message forwarding', () => {
    it('forwards checkpoint messages from the worker', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();

      // Simulate worker sending a checkpoint message
      const checkpointMessage: WorkerOutboundMessage = {
        type: 'checkpoint',
        workflowId: 'wf-1',
        checkpoint: new ArrayBuffer(0),
        operationRequest: {
          id: 'op-1',
          workflowId: 'wf-1',
          kind: 'activity',
          queue: 'default',
          activityName: 'doSomething',
          attempt: 1,
          retryPolicy: {
            maxAttempts: 3,
            initialBackoff: 1000,
            backoffMultiplier: 2,
            maxBackoff: 30000,
          },
          scheduledAt: Date.now(),
        },
      };

      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', { data: checkpointMessage }),
      );

      const message = firstMessage();
      expect(message).toEqual(checkpointMessage);
    });

    it('releases the worker when a workflow parks on a signal checkpoint', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-park',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();
      const checkpointMessage: WorkerOutboundMessage = {
        type: 'checkpoint',
        workflowId: 'wf-park',
        checkpoint: new ArrayBuffer(0),
        operationRequest: {
          id: 'op-wait',
          workflowId: 'wf-park',
          kind: 'signal-wait',
          queue: 'default',
          attempt: 1,
          retryPolicy: {
            maxAttempts: 1,
            initialBackoff: 0,
            backoffMultiplier: 1,
            maxBackoff: 0,
          },
          scheduledAt: Date.now(),
          signalName: 'llm-resume',
        },
      };

      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', { data: checkpointMessage }),
      );

      expect(messages).toEqual([checkpointMessage]);
      expect(mockPool.release).toHaveBeenCalledTimes(1);
    });

    it('keeps the worker assigned when checkpoint handling fails before parking', async () => {
      setup();
      strategy.onMessage(async () => {
        throw new Error('checkpoint persistence failed');
      });

      strategy.startWorkflow({
        workflowId: 'wf-handler-fails',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            workflowId: 'wf-handler-fails',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              type: 'wait-signal',
              operationId: 'op-wait',
              signalName: 'llm-resume',
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      await sleepForTesting(10);

      expect(mockPool.release).not.toHaveBeenCalled();
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    it('does not park a signal checkpoint after a resume when another checkpoint interleaves', async () => {
      setup();

      let unblockSignalCheckpoint: (() => void) | undefined;
      strategy.onMessage(async (message) => {
        messages.push(message);
        if (
          message.type === 'checkpoint' &&
          'type' in message.operationRequest &&
          message.operationRequest.type === 'wait-signal'
        ) {
          await new Promise<void>((resolve) => {
            unblockSignalCheckpoint = resolve;
          });
        }
      });

      strategy.startWorkflow({
        workflowId: 'wf-interleaved-checkpoint',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            workflowId: 'wf-interleaved-checkpoint',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              type: 'wait-signal',
              operationId: 'op-wait',
              signalName: 'llm-resume',
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      expect(unblockSignalCheckpoint).toBeDefined();

      strategy.resumeWorkflow({
        workflowId: 'wf-interleaved-checkpoint',
        checkpoint: new ArrayBuffer(4),
        operationResult: { status: 'completed', value: 'resume payload' },
      });

      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            workflowId: 'wf-interleaved-checkpoint',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              id: 'op-activity',
              workflowId: 'wf-interleaved-checkpoint',
              kind: 'activity',
              queue: 'default',
              activityName: 'doSomething',
              attempt: 1,
              retryPolicy: {
                maxAttempts: 1,
                initialBackoff: 0,
                backoffMultiplier: 1,
                maxBackoff: 0,
              },
              scheduledAt: Date.now(),
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      unblockSignalCheckpoint!();
      await sleepForTesting(10);

      expect(mockPool.release).not.toHaveBeenCalled();
      expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        type: 'resume',
        workflowId: 'wf-interleaved-checkpoint',
      });
    });

    it('lets a second workflow use a concurrency-one worker while the first workflow is parked', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-parked',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            workflowId: 'wf-parked',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              type: 'wait-signal',
              operationId: 'op-wait',
              signalName: 'llm-resume',
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      strategy.startWorkflow({
        workflowId: 'wf-second',
        workflowType: 'test',
        input: 'second',
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      expect(worker.postMessage).toHaveBeenCalledTimes(2);
      expect(worker.postMessage.mock.calls[1]?.[0]).toMatchObject({
        type: 'run',
        workflowId: 'wf-second',
        input: 'second',
      });

      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'completed',
            workflowId: 'wf-second',
            result: 'second done',
          } satisfies WorkerOutboundMessage,
        }),
      );

      strategy.resumeWorkflow({
        workflowId: 'wf-parked',
        checkpoint: new ArrayBuffer(4),
        operationResult: { status: 'completed', value: 'resume payload' },
      });

      await sleepForTesting(10);

      expect(worker.postMessage).toHaveBeenCalledTimes(3);
      expect(worker.postMessage.mock.calls[2]?.[0]).toMatchObject({
        type: 'resume',
        workflowId: 'wf-parked',
        operationResult: { status: 'completed', value: 'resume payload' },
      });

      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'completed',
            workflowId: 'wf-parked',
            result: 'first done',
          } satisfies WorkerOutboundMessage,
        }),
      );

      expect(
        messages.filter(
          (message) => message.type === 'completed' && message.workflowId === 'wf-parked',
        ),
      ).toHaveLength(1);
    });

    it('reacquires the parked worker even when another idle worker is available first', async () => {
      setup(2);

      strategy.startWorkflow({
        workflowId: 'wf-parked',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const parkedWorker = firstWorker();
      dispatchToMockWorker(
        parkedWorker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            workflowId: 'wf-parked',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              type: 'wait-signal',
              operationId: 'op-wait',
              signalName: 'llm-resume',
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      strategy.resumeWorkflow({
        workflowId: 'wf-parked',
        checkpoint: new ArrayBuffer(4),
        operationResult: { status: 'completed', value: 'resume payload' },
      });

      await sleepForTesting(10);

      expect(parkedWorker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        type: 'resume',
        workflowId: 'wf-parked',
      });
      expect(mockWorkers[1]?.postMessage).not.toHaveBeenCalled();
    });

    it('emits one failure when a parked worker crashes during queued resume', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-parked-crash',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            workflowId: 'wf-parked-crash',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              type: 'wait-signal',
              operationId: 'op-wait',
              signalName: 'llm-resume',
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      strategy.startWorkflow({
        workflowId: 'wf-second',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      strategy.resumeWorkflow({
        workflowId: 'wf-parked-crash',
        checkpoint: new ArrayBuffer(4),
        operationResult: { status: 'completed', value: 'resume payload' },
      });

      dispatchToMockWorker(
        worker,
        'error',
        new ErrorEvent('error', {
          message: 'parked worker crashed during resume',
        }),
      );

      await sleepForTesting(10);

      expect(
        messages.filter(
          (message) => message.type === 'failed' && message.workflowId === 'wf-parked-crash',
        ),
      ).toHaveLength(1);
    });

    it('releases the worker on completed messages', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();

      const completedMessage: WorkerOutboundMessage = {
        type: 'completed',
        workflowId: 'wf-1',
        result: 'done',
      };

      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', { data: completedMessage }),
      );

      const message = firstMessage();
      expect(message.type).toBe('completed');
      expect(mockPool.release).toHaveBeenCalledTimes(1);
    });

    it('releases the worker on failed messages', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();

      const failedMessage: WorkerOutboundMessage = {
        type: 'failed',
        workflowId: 'wf-1',
        error: 'something broke',
      };

      dispatchToMockWorker(worker, 'message', new MessageEvent('message', { data: failedMessage }));

      const message = firstMessage();
      expect(message.type).toBe('failed');
      expect(mockPool.release).toHaveBeenCalledTimes(1);
    });

    it('does not surface unhandled rejections when an async message handler fails', async () => {
      const script = String.raw`
        import { WorkerExecutionStrategy } from './src/core/worker-execution-strategy.ts';

        function createMockWorker() {
          const listeners = new Map();

          return {
            postMessage() {},
            terminate() {},
            addEventListener(type, listener) {
              if (!listeners.has(type)) {
                listeners.set(type, new Set());
              }

              listeners.get(type).add(listener);
            },
            removeEventListener(type, listener) {
              listeners.get(type)?.delete(listener);
            },
            listeners,
          };
        }

        const worker = createMockWorker();
        const pool = {
          acquire: async () => worker,
          release() {},
          get availableCount() {
            return 0;
          },
          get totalCount() {
            return 1;
          },
          get pendingCount() {
            return 0;
          },
          [Symbol.dispose]() {},
          async [Symbol.asyncDispose]() {},
        };

        const strategy = new WorkerExecutionStrategy(pool);

        process.on('unhandledRejection', (error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        });

        strategy.onMessage(async () => {
          throw new Error('handler failed');
        });

        // Deterministic readiness signal: spin the microtask queue until the
        // strategy has registered its 'message' listener, rather than guessing
        // a wall-clock delay (the old setTimeout(20) flaked under CI load).
        async function waitForMessageListener() {
          for (let attempt = 0; attempt < 10_000; attempt++) {
            if ((worker.listeners.get('message')?.size ?? 0) > 0) return;
            await Promise.resolve();
          }
          throw new Error('strategy never registered a message listener');
        }

        // Let any pending unhandled rejection surface before exit, without a
        // wall-clock guess: drain the nextTick + microtask queues, then take one
        // zero-delay macrotask turn — the real event-loop boundary at which an
        // unhandledRejection would fire, deterministic regardless of CPU load.
        async function settleRejections() {
          await new Promise((resolve) => process.nextTick(resolve));
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        strategy.startWorkflow({
          workflowId: 'wf-1',
          workflowType: 'test',
          input: null,
          checkpoint: new ArrayBuffer(0),
        });

        await waitForMessageListener();

        for (const listener of worker.listeners.get('message') ?? []) {
          listener(
            new MessageEvent('message', {
              data: {
                type: 'completed',
                workflowId: 'wf-1',
                result: 'done',
              },
            }),
          );
        }

        await settleRejections();
        strategy[Symbol.dispose]();
        process.exit(0);
      `;

      const childProcess = Bun.spawn(['bun', '-e', script], {
        cwd: globalThis.process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await childProcess.exited;
      const stdoutText = await new Response(childProcess.stdout).text();
      const stderrText = await new Response(childProcess.stderr).text();

      expect(exitCode).toBe(0);
      expect(stdoutText.trim()).toBe('');
      expect(stderrText.trim()).toBe('');
    });
  });

  describe('hardened worker turns', () => {
    it('times out a wedged run turn, discards that worker, and lets a later workflow use another worker', async () => {
      useFakeTimers();
      setup(2, {
        workflowTurnTimeoutMs: 5,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-timeout',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(0);
      await advanceTimersByTime(5);

      expect(mockPool.discard).toHaveBeenCalledWith(mockWorkers[0]);
      expect(firstMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-timeout',
        failureCategory: 'timeout',
      });

      strategy.startWorkflow({
        workflowId: 'wf-after-timeout',
        workflowType: 'test',
        input: 'ok',
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(0);

      expect(mockWorkers[1]?.postMessage).toHaveBeenCalledTimes(1);
      expect(mockWorkers[1]?.postMessage.mock.calls[0]?.[0]).toMatchObject({
        type: 'run',
        workflowId: 'wf-after-timeout',
      });
    });

    it('times out a wedged resume turn for an active workflow', async () => {
      useFakeTimers();
      setup(1, {
        workflowTurnTimeoutMs: 5,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-active-resume-timeout',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(0);
      await advanceTimersByTime(4);

      expect(messages).toHaveLength(0);
      expect(mockPool.discard).not.toHaveBeenCalled();

      strategy.resumeWorkflow({
        workflowId: 'wf-active-resume-timeout',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: null },
      });

      expect(firstWorker().postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        type: 'resume',
        workflowId: 'wf-active-resume-timeout',
      });

      await advanceTimersByTime(4);
      expect(messages).toHaveLength(0);
      expect(mockPool.discard).not.toHaveBeenCalled();

      await advanceTimersByTime(1);

      expect(mockPool.discard).toHaveBeenCalledWith(firstWorker());
      expect(firstMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-active-resume-timeout',
        failureCategory: 'timeout',
      });
    });

    it('times out a wedged resume turn after reacquiring a parked worker', async () => {
      useFakeTimers();
      setup(1, {
        workflowTurnTimeoutMs: 5,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-parked-resume-timeout',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(0);

      const worker = firstWorker();
      const runMessage = worker.postMessage.mock.calls[0]?.[0] as { turnId: number };
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            turnId: runMessage.turnId,
            workflowId: 'wf-parked-resume-timeout',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              type: 'wait-signal',
              operationId: 'op-wait',
              signalName: 'resume',
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      strategy.resumeWorkflow({
        workflowId: 'wf-parked-resume-timeout',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: null },
      });
      await sleepForTesting(0);

      expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        type: 'resume',
        workflowId: 'wf-parked-resume-timeout',
      });

      await advanceTimersByTime(5);

      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      expect(lastMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-parked-resume-timeout',
        failureCategory: 'timeout',
      });
    });

    it('rejects worker messages that do not echo the active protocol version and turn id', async () => {
      setup(1, {
        workflowTurnTimeoutMs: 100,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-protocol',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(10);

      dispatchToMockWorker(
        firstWorker(),
        'message',
        new MessageEvent('message', {
          data: {
            type: 'completed',
            workflowId: 'wf-protocol',
            result: 'spoofed',
          } satisfies WorkerOutboundMessage,
        }),
      );

      expect(firstMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-protocol',
        failureCategory: 'system',
      });
      expect(mockPool.discard).toHaveBeenCalledWith(firstWorker());
    });

    it('rejects malformed worker messages before forwarding to the engine', async () => {
      setup(1, {
        workflowTurnTimeoutMs: 100,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-malformed',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(10);

      const runMessage = firstWorker().postMessage.mock.calls[0]?.[0] as {
        turnId: number;
      };
      dispatchToMockWorker(
        firstWorker(),
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            turnId: runMessage.turnId,
            workflowId: 'wf-malformed',
            checkpoint: 'not-bytes',
            operationRequest: { type: 'wait-signal' },
          },
        }),
      );

      expect(firstMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-malformed',
        failureCategory: 'system',
      });
      expect(mockPool.discard).toHaveBeenCalledWith(firstWorker());
    });

    it('discards the worker when it emits a messageerror event', async () => {
      setup(1, {
        workflowTurnTimeoutMs: 100,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-messageerror',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(10);

      dispatchToMockWorker(firstWorker(), 'messageerror', new MessageEvent('messageerror'));

      expect(firstMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-messageerror',
        failureCategory: 'system',
      });
      expect(mockPool.discard).toHaveBeenCalledWith(firstWorker());
    });

    it('fails an oversized run message before acquiring a worker', async () => {
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-large-run',
        workflowType: 'test',
        input: { payload: 'x'.repeat(5_000) },
        checkpoint: new ArrayBuffer(0),
      });

      expect(mockPool.acquire).not.toHaveBeenCalled();
      expect(firstMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-large-run',
        failureCategory: 'resource',
      });
    });

    it('rejects oversized outbound worker messages before forwarding to the engine', async () => {
      setup(1, {
        workflowTurnTimeoutMs: 100,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-large-outbound',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(10);

      const runMessage = firstWorker().postMessage.mock.calls[0]?.[0] as {
        turnId: number;
      };
      dispatchToMockWorker(
        firstWorker(),
        'message',
        new MessageEvent('message', {
          data: {
            type: 'completed',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            turnId: runMessage.turnId,
            workflowId: 'wf-large-outbound',
            result: 'x'.repeat(5_000),
          } satisfies WorkerOutboundMessage,
        }),
      );

      expect(firstMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-large-outbound',
        failureCategory: 'resource',
      });
      expect(mockPool.discard).toHaveBeenCalledWith(firstWorker());
    });

    it('rejects oversized active resume messages and discards that worker', async () => {
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-large-active-resume',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(10);

      strategy.resumeWorkflow({
        workflowId: 'wf-large-active-resume',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'x'.repeat(5_000) },
      });

      expect(firstWorker().postMessage).toHaveBeenCalledTimes(1);
      expect(mockPool.discard).toHaveBeenCalledWith(firstWorker());
      expect(firstMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-large-active-resume',
        failureCategory: 'resource',
      });
    });

    it('clears the active turn and discards the worker when resume postMessage throws', async () => {
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-resume-postmessage-throws',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(10);

      firstWorker().postMessage.mockImplementationOnce(() => {
        throw new Error('resume postMessage failed');
      });

      strategy.resumeWorkflow({
        workflowId: 'wf-resume-postmessage-throws',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: null },
      });

      expect(mockPool.discard).toHaveBeenCalledWith(firstWorker());
      expect(firstMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-resume-postmessage-throws',
        failureCategory: 'system',
      });
    });

    it('rejects oversized parked resume messages and discards the parked worker', async () => {
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-large-parked-resume',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(10);

      const worker = firstWorker();
      const runMessage = worker.postMessage.mock.calls[0]?.[0] as { turnId: number };
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            turnId: runMessage.turnId,
            workflowId: 'wf-large-parked-resume',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              type: 'wait-signal',
              operationId: 'op-wait',
              signalName: 'resume',
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      strategy.resumeWorkflow({
        workflowId: 'wf-large-parked-resume',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'x'.repeat(5_000) },
      });
      await sleepForTesting(10);

      expect(worker.postMessage).toHaveBeenCalledTimes(1);
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      expect(lastMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-large-parked-resume',
        failureCategory: 'resource',
      });
    });
  });

  // -------------------------------------------------------------------------
  // resumeWorkflow
  // -------------------------------------------------------------------------

  describe('resumeWorkflow', () => {
    it('sends a resume message to the assigned worker', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();
      const checkpoint = new ArrayBuffer(16);
      strategy.resumeWorkflow({
        workflowId: 'wf-1',
        checkpoint,
        operationResult: { status: 'completed', value: 42 },
      });

      // The first call is the 'run' message, the second is 'resume'
      expect(worker.postMessage).toHaveBeenCalledTimes(2);

      const resumeMessage = worker.postMessage.mock.calls[1]![0];
      expect(resumeMessage.type).toBe('resume');
      expect(resumeMessage.workflowId).toBe('wf-1');
      expect(resumeMessage.operationResult).toEqual({ status: 'completed', value: 42 });
    });

    it('emits failed when no worker is assigned', () => {
      setup();

      strategy.resumeWorkflow({
        workflowId: 'wf-unknown',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: null },
      });

      const message = firstMessage();
      expect(message.type).toBe('failed');
      expect(message.workflowId).toBe('wf-unknown');
    });
  });

  // -------------------------------------------------------------------------
  // cancelWorkflow
  // -------------------------------------------------------------------------

  describe('cancelWorkflow', () => {
    it('sends a cancel message to the assigned worker', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      strategy.cancelWorkflow('wf-1');

      const worker = firstWorker();
      // First call is 'run', second is 'cancel'
      expect(worker.postMessage).toHaveBeenCalledTimes(2);

      const cancelMessage = worker.postMessage.mock.calls[1]![0];
      expect(cancelMessage.type).toBe('cancel');
      expect(cancelMessage.workflowId).toBe('wf-1');

      // Worker should have been released back to the pool
      expect(mockPool.release).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no worker is assigned', () => {
      setup();

      // Should not throw
      strategy.cancelWorkflow('wf-nonexistent');
    });

    it('cancels a parked workflow and prevents later resume attempts', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-parked-cancel',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            workflowId: 'wf-parked-cancel',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              type: 'wait-signal',
              operationId: 'op-wait',
              signalName: 'llm-resume',
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      strategy.cancelWorkflow('wf-parked-cancel');
      await sleepForTesting(10);

      expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual({
        type: 'cancel',
        workflowId: 'wf-parked-cancel',
      });

      strategy.resumeWorkflow({
        workflowId: 'wf-parked-cancel',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: null },
      });

      expect(messages).toHaveLength(1);
      expect(messages.at(-1)?.type).toBe('checkpoint');
    });

    it('discards the active worker on hardened cancellation without emitting a duplicate failure', async () => {
      setup(2, {
        discardOnCancel: true,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      strategy.startWorkflow({
        workflowId: 'wf-discard-on-cancel',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(10);

      const cancelledWorker = firstWorker();
      strategy.cancelWorkflow('wf-discard-on-cancel');

      expect(messages).toHaveLength(0);
      expect(mockPool.release).not.toHaveBeenCalled();
      expect(mockPool.discard).toHaveBeenCalledWith(cancelledWorker);

      strategy.startWorkflow({
        workflowId: 'wf-after-cancel-discard',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(10);

      expect(mockWorkers[1]?.postMessage).toHaveBeenCalledTimes(1);
      expect(mockWorkers[1]?.postMessage.mock.calls[0]?.[0]).toMatchObject({
        type: 'run',
        workflowId: 'wf-after-cancel-discard',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Worker errors
  // -------------------------------------------------------------------------

  describe('worker errors', () => {
    it('is a no-op when the worker was already released by a racing completion', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();

      // Step 1: simulate the worker sending a completed message, which triggers
      // #releaseWorker and removes the worker from the internal map.
      const completedMessage: WorkerOutboundMessage = {
        type: 'completed',
        workflowId: 'wf-1',
        result: 'done',
      };

      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', { data: completedMessage }),
      );

      // Step 2: now fire an error event for the same workflowId — the race
      // guard should detect the worker is already gone and return early.
      const errorEvent = new ErrorEvent('error', {
        message: 'Late crash after completion',
      });

      dispatchToMockWorker(worker, 'error', errorEvent);

      // Only the completed message should have been emitted; no failed message.
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('completed');

      // terminate() must not have been called — the worker was cleanly released,
      // not crashed.
      expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('emits a failed message when the worker crashes', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const worker = firstWorker();

      // Simulate worker crash
      const errorEvent = new ErrorEvent('error', {
        message: 'Worker crashed unexpectedly',
      });

      dispatchToMockWorker(worker, 'error', errorEvent);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      expect(message.workflowId).toBe('wf-1');

      if (message.type === 'failed') {
        expect(message.error).toContain('Worker crashed');
      }

      // Worker should NOT be released back to pool (it crashed)
      expect(mockPool.release).not.toHaveBeenCalled();
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
    });
  });

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  describe('disposal', () => {
    it('calls pool dispose on synchronous dispose', () => {
      setup();
      const poolDispose = mock(() => {});
      mockPool[Symbol.dispose] = poolDispose;

      strategy[Symbol.dispose]();

      expect(poolDispose).toHaveBeenCalledTimes(1);
    });

    it('calls pool asyncDispose on async dispose', async () => {
      setup();
      const poolAsyncDispose = mock(async () => {});
      mockPool[Symbol.asyncDispose] = poolAsyncDispose;

      await strategy[Symbol.asyncDispose]();

      expect(poolAsyncDispose).toHaveBeenCalledTimes(1);
    });

    it('clears parked workflows during synchronous disposal', async () => {
      setup();
      const poolDispose = mock(() => {});
      mockPool[Symbol.dispose] = poolDispose;

      strategy.startWorkflow({
        workflowId: 'wf-parked-dispose',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const acquireMock = mockPool.acquire as unknown as ReturnType<typeof mock>;
      const acquireCallsBeforeDispose = acquireMock.mock.calls.length;
      dispatchToMockWorker(
        firstWorker(),
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            workflowId: 'wf-parked-dispose',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              type: 'wait-signal',
              operationId: 'op-wait',
              signalName: 'llm-resume',
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      strategy[Symbol.dispose]();
      strategy.resumeWorkflow({
        workflowId: 'wf-parked-dispose',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: null },
      });

      expect(poolDispose).toHaveBeenCalledTimes(1);
      expect(mockPool.acquire).toHaveBeenCalledTimes(acquireCallsBeforeDispose);
    });
  });

  // -------------------------------------------------------------------------
  // worker host log routing (#529)
  // -------------------------------------------------------------------------

  describe('worker host log routing (#529)', () => {
    function logRecord(
      message: string,
      workflowId = 'wf-log',
    ): {
      level: 'info';
      message: string;
      workflowId: string;
      workflowType: string;
      timestamp: number;
    } {
      return {
        level: 'info',
        message,
        workflowId,
        workflowType: 'test',
        timestamp: 0,
      };
    }

    /** Dispatch a forwarded `ctx.log` message from the worker. */
    function dispatchLog(worker: MockWorker, record: unknown, envelopeWorkflowId = 'wf-log'): void {
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'log',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            workflowId: envelopeWorkflowId,
            record,
          } as unknown as WorkerOutboundMessage,
        }),
      );
    }

    /** Read the turnId the strategy stamped on a worker's run message (the first post). */
    function runTurnIdOf(worker: MockWorker): number {
      const runMessage = worker.postMessage.mock.calls[0]?.[0] as { turnId: number } | undefined;
      expect(runMessage).toBeDefined();
      return runMessage!.turnId;
    }

    /** Start a workflow and let its run message post so the worker owns it (active turn). */
    async function startOwned(workflowId = 'wf-log'): Promise<void> {
      strategy.startWorkflow({
        workflowId,
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      // startWorkflow acquires the worker asynchronously; let the run message post.
      await sleepForTesting(0);
    }

    it('tells the worker a host sink exists by stamping hostHasLogSink on run and resume', async () => {
      const sink = mock(() => {});
      setup(1, { maxProtocolMessageBytes: 4_096, requireProtocolVersion: true, onLog: sink });

      await startOwned();

      const runMessage = firstWorker().postMessage.mock.calls[0]?.[0];
      expect(runMessage).toMatchObject({ type: 'run', hostHasLogSink: true });

      strategy.resumeWorkflow({
        workflowId: 'wf-log',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: null },
      });
      await sleepForTesting(0);

      const resumeMessage = firstWorker().postMessage.mock.calls.at(-1)?.[0];
      expect(resumeMessage).toMatchObject({ type: 'resume', hostHasLogSink: true });
    });

    it('omits hostHasLogSink when no host sink is installed', async () => {
      setup(1, { maxProtocolMessageBytes: 4_096, requireProtocolVersion: true });

      await startOwned();

      const runMessage = firstWorker().postMessage.mock.calls[0]?.[0] as {
        hostHasLogSink?: boolean;
      };
      expect(runMessage.hostHasLogSink).toBeUndefined();
    });

    it('handles a log message without an onLog sink (no throw, no discard)', async () => {
      // A `log` can arrive even when the host installed no sink (e.g. a stale worker
      // from a prior config). The delivery helper must no-op gracefully on the
      // undefined-sink branch — never throw, never discard.
      setup(1, { maxProtocolMessageBytes: 4_096, requireProtocolVersion: true });

      await startOwned();
      dispatchLog(firstWorker(), logRecord('no-sink'));

      expect(mockPool.discard).not.toHaveBeenCalled();
    });

    it('delivers a worker log record to the host onLog sink', async () => {
      const received: Array<{ message: string }> = [];
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: (record) => received.push(record),
      });

      await startOwned();
      dispatchLog(firstWorker(), logRecord('hello from worker'));

      expect(received).toEqual([expect.objectContaining({ message: 'hello from worker' })]);
    });

    it('drops a log for a workflow the worker does not own (spoof) without delivering or discarding', async () => {
      // The trust boundary in the hardened worker path: a worker may forward logs only
      // for a workflow it owns. A worker that owns `wf-log` tries to forward a log for
      // `wf-victim` (owned by no one here) — the ownership gate DROPS it: no sink call,
      // no discard (a forged log is best-effort noise, not a protocol violation).
      const sink = mock(() => {});
      setup(1, { maxProtocolMessageBytes: 4_096, requireProtocolVersion: true, onLog: sink });

      await startOwned('wf-log');
      dispatchLog(firstWorker(), logRecord('spoofed', 'wf-victim'), 'wf-victim');

      expect(sink).not.toHaveBeenCalled();
      expect(mockPool.discard).not.toHaveBeenCalled();
    });

    it('drops a log forwarded by worker A for a workflow owned by worker B (cross-worker spoof)', async () => {
      // The teeth for the ownership gate's EQUALITY, not just existence: worker A owns
      // `wf-a`, worker B owns `wf-b`. Worker A forwards a log claiming `wf-b` (envelope
      // AND record). A weaker gate that only checked "wf-b has SOME owner" would deliver;
      // the real gate (`getTargetWorker(wf-b) === worker A`) is false, so it drops.
      const sink = mock(() => {});
      setup(2, { maxProtocolMessageBytes: 4_096, requireProtocolVersion: true, onLog: sink });

      strategy.startWorkflow({
        workflowId: 'wf-a',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      strategy.startWorkflow({
        workflowId: 'wf-b',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(0);

      const workerA = firstWorker();
      const workerB = mockWorkers[1]!;
      // Precondition: the two workflows landed on distinct workers.
      expect(workerA.postMessage.mock.calls[0]?.[0]).toMatchObject({ workflowId: 'wf-a' });
      expect(workerB.postMessage.mock.calls[0]?.[0]).toMatchObject({ workflowId: 'wf-b' });

      // Worker A forwards a log for wf-b (which it does NOT own).
      dispatchLog(workerA, logRecord('cross-worker-spoof', 'wf-b'), 'wf-b');

      expect(sink).not.toHaveBeenCalled();
      expect(mockPool.discard).not.toHaveBeenCalled();
    });

    it('drops a log whose record workflowId does not match the envelope', async () => {
      // The worker owns `wf-log` and the envelope targets `wf-log`, but the record
      // claims a different `workflowId`. Identity must match the envelope, so the
      // record is dropped — never delivered, never a discard.
      const sink = mock(() => {});
      setup(1, { maxProtocolMessageBytes: 4_096, requireProtocolVersion: true, onLog: sink });

      await startOwned('wf-log');
      dispatchLog(firstWorker(), logRecord('mismatched-identity', 'wf-other'), 'wf-log');

      expect(sink).not.toHaveBeenCalled();
      expect(mockPool.discard).not.toHaveBeenCalled();
    });

    it('delivers a log for a parked workflow the worker still owns', async () => {
      // Park `wf-log` on a wait-signal checkpoint. The worker is released to the pool
      // but still OWNS the parked workflow, so a fire-and-forget log resolving while
      // parked passes the ownership gate and is delivered.
      const sink = mock(() => {});
      setup(1, {
        workflowTurnTimeoutMs: 100,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
      });

      await startOwned('wf-log');
      const worker = firstWorker();
      const runTurnId = runTurnIdOf(worker);
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            turnId: runTurnId,
            workflowId: 'wf-log',
            checkpoint: new ArrayBuffer(0),
            operationRequest: { type: 'wait-signal', operationId: 'op-wait', signalName: 'go' },
          } satisfies WorkerOutboundMessage,
        }),
      );
      // Control: parking released the worker, proving the turn was cleared (the
      // "between turns" window). A strict message now would be rejected as
      // out-of-turn; the lenient log lane still delivers because ownership persists.
      expect(mockPool.release).toHaveBeenCalledTimes(1);

      dispatchLog(worker, logRecord('while-parked'));

      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ message: 'while-parked' }));
      expect(mockPool.discard).not.toHaveBeenCalled();
    });

    it('rejects a STRICT out-of-turn message after parking (control for the lenient log lane)', async () => {
      // The teeth for "between turns": prove the parked state is genuinely turn-cleared
      // by showing a STRICT (non-log) message with the run turnId is now rejected as
      // out-of-turn and discards the worker. This is the behavior the lenient log lane
      // deliberately does NOT share — contrast with the parked-log delivery test above.
      setup(1, {
        workflowTurnTimeoutMs: 100,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
      });

      await startOwned('wf-log');
      const worker = firstWorker();
      const runTurnId = runTurnIdOf(worker);
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            turnId: runTurnId,
            workflowId: 'wf-log',
            checkpoint: new ArrayBuffer(0),
            operationRequest: { type: 'wait-signal', operationId: 'op-wait', signalName: 'go' },
          } satisfies WorkerOutboundMessage,
        }),
      );
      expect(mockPool.release).toHaveBeenCalledTimes(1);

      // A strict completed echoing the (now stale) run turnId arrives after the turn
      // cleared: the strict gate rejects it and discards the worker.
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'completed',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            turnId: runTurnId,
            workflowId: 'wf-log',
            result: 'stale',
          } satisfies WorkerOutboundMessage,
        }),
      );

      expect(mockPool.discard).toHaveBeenCalledWith(worker);
    });

    it('does NOT clear the turn watchdog for a mid-turn log (subsequent checkpoint still accepted)', async () => {
      const sink = mock(() => {});
      setup(1, {
        workflowTurnTimeoutMs: 100,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
      });

      await startOwned('wf-log');
      const worker = firstWorker();
      const runTurnId = runTurnIdOf(worker);

      // A mid-turn log arrives; it must not touch the watchdog or the turn state.
      dispatchLog(worker, logRecord('mid-turn'));

      // The turn is still active: a checkpoint echoing the SAME turnId is accepted,
      // not rejected as "outside an active turn" (which would discard the worker).
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'checkpoint',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            turnId: runTurnId,
            workflowId: 'wf-log',
            checkpoint: new ArrayBuffer(0),
            operationRequest: {
              type: 'sleep',
              operationId: 'op-sleep',
              duration: 1,
              scheduledFireAt: 1,
            },
          } satisfies WorkerOutboundMessage,
        }),
      );

      expect(mockPool.discard).not.toHaveBeenCalled();
      expect(sink).toHaveBeenCalledTimes(1);
    });

    it('a log-spamming worker still trips the turn watchdog at the ORIGINAL deadline (short-circuit, not re-arm)', async () => {
      useFakeTimers();
      const sink = mock(() => {});
      setup(1, {
        workflowTurnTimeoutMs: 5,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
      });

      await startOwned('wf-log');
      const worker = firstWorker();

      // Advance to 4ms (1ms before the original turn-begin deadline) and spam a log.
      // A `reset`-style watchdog would re-arm here, pushing the deadline to 9ms.
      await advanceTimersByTime(4);
      dispatchLog(worker, logRecord('spam-0'));
      expect(mockPool.discard).not.toHaveBeenCalled();

      // Advancing the remaining 1ms reaches the ORIGINAL 5ms deadline. The watchdog
      // fires now — proving the log did NOT re-arm it (a reset implementation would
      // still be 4ms away from its pushed-out deadline and would not have discarded).
      await advanceTimersByTime(1);
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      expect(lastMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-log',
        failureCategory: 'timeout',
      });
    });

    it('a throwing host sink falls back to console and never discards the worker or fails the workflow', async () => {
      const sink = mock(() => {
        throw new Error('sink blew up');
      });
      const consoleInfo = mock(() => {});
      const originalConsoleInfo = console.info;
      console.info = consoleInfo;
      setup(1, {
        workflowTurnTimeoutMs: 100,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
      });

      try {
        await startOwned('wf-log');
        const worker = firstWorker();
        const runTurnId = runTurnIdOf(worker);

        dispatchLog(worker, logRecord('boom'));

        // The sink threw; the record fell back to the matching console method (`info`)
        // rather than disappearing or failing the run.
        expect(sink).toHaveBeenCalledTimes(1);
        expect(consoleInfo).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
        expect(mockPool.discard).not.toHaveBeenCalled();
        expect(messages).toHaveLength(0);

        // The turn is still healthy: a terminal completed echoing the turnId settles cleanly.
        dispatchToMockWorker(
          worker,
          'message',
          new MessageEvent('message', {
            data: {
              type: 'completed',
              protocolVersion: WORKER_PROTOCOL_VERSION,
              turnId: runTurnId,
              workflowId: 'wf-log',
              result: 'done',
            } satisfies WorkerOutboundMessage,
          }),
        );
        expect(lastMessage()).toMatchObject({ type: 'completed', workflowId: 'wf-log' });
      } finally {
        console.info = originalConsoleInfo;
      }
    });

    it('drops a malformed log record without delivering or discarding the worker', async () => {
      const sink = mock(() => {});
      setup(1, {
        workflowTurnTimeoutMs: 100,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
      });

      await startOwned('wf-log');

      // A `log` message whose record is missing required fields. It routes into the
      // lenient log lane on `type: 'log'` alone, where a malformed record is DROPPED —
      // never delivered to the sink, and (the teeth) never a worker-discard. A log
      // carries no turn-protocol state, so a corrupt payload can't fail the workflows.
      dispatchLog(firstWorker(), { not: 'a-log' });

      expect(sink).not.toHaveBeenCalled();
      expect(mockPool.discard).not.toHaveBeenCalled();
    });

    it('rejects a record missing required envelope fields (workflowType / timestamp)', async () => {
      const sink = mock(() => {});
      setup(1, { maxProtocolMessageBytes: 4_096, requireProtocolVersion: true, onLog: sink });

      await startOwned('wf-log');

      // Has level/message/workflowId but is missing workflowType and timestamp — the
      // full-shape validator rejects it so a partial record never reaches a typed sink.
      dispatchLog(firstWorker(), {
        level: 'info',
        message: 'partial',
        workflowId: 'wf-log',
      });

      expect(sink).not.toHaveBeenCalled();
      expect(mockPool.discard).not.toHaveBeenCalled();
    });

    it('drops an oversized log record without delivering or discarding the worker', async () => {
      const sink = mock(() => {});
      setup(1, {
        workflowTurnTimeoutMs: 100,
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
      });

      await startOwned('wf-log');

      const oversizeRecord = {
        ...logRecord('big'),
        attributes: { blob: 'x'.repeat(8_192) },
      };
      dispatchLog(firstWorker(), oversizeRecord);

      expect(sink).not.toHaveBeenCalled();
      expect(mockPool.discard).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // forwarded-log abuse counter (#545)
  // -------------------------------------------------------------------------

  describe('forwarded-log abuse counter (#545)', () => {
    function logRecord(message: string, workflowId = 'wf-log'): WorkerOutboundMessage {
      return {
        level: 'info',
        message,
        workflowId,
        workflowType: 'test',
        timestamp: 0,
      } as unknown as WorkerOutboundMessage;
    }

    /** A controllable clock injected as `getNow`, so flood windows are deterministic. */
    function controllableClock(): { now: () => number; advance: (ms: number) => void } {
      let current = 0;
      return {
        now: () => current,
        advance: (ms: number) => {
          current += ms;
        },
      };
    }

    function dispatchLog(worker: MockWorker, record: unknown, envelopeWorkflowId = 'wf-log'): void {
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'log',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            workflowId: envelopeWorkflowId,
            record,
          } as unknown as WorkerOutboundMessage,
        }),
      );
    }

    async function startOwned(workflowId = 'wf-log'): Promise<void> {
      strategy.startWorkflow({
        workflowId,
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(0);
    }

    it('discards a worker that floods more than the threshold within the window', async () => {
      const sink = mock(() => {});
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
        forwardedLogFloodThreshold: 3,
        forwardedLogFloodWindowMs: 1_000,
      });

      await startOwned('wf-log');
      const worker = firstWorker();

      // Three valid in-budget logs sit at the threshold — delivered, not a discard.
      dispatchLog(worker, logRecord('a'));
      dispatchLog(worker, logRecord('b'));
      dispatchLog(worker, logRecord('c'));
      expect(mockPool.discard).not.toHaveBeenCalled();
      expect(sink).toHaveBeenCalledTimes(3);

      // The fourth arrival exceeds the threshold → discard for flooding.
      dispatchLog(worker, logRecord('d'));
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      expect(lastMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-log',
        failureCategory: 'system',
      });
    });

    it('does not flood-discard a slow trickle that resets across windows', async () => {
      const clock = controllableClock();
      const sink = mock(() => {});
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
        getNow: clock.now,
        forwardedLogFloodThreshold: 1,
        forwardedLogFloodWindowMs: 1_000,
      });

      await startOwned('wf-log');
      const worker = firstWorker();

      dispatchLog(worker, logRecord('window-a'));
      clock.advance(1_000); // next arrival opens a fresh window
      dispatchLog(worker, logRecord('window-b'));

      expect(mockPool.discard).not.toHaveBeenCalled();
      expect(sink).toHaveBeenCalledTimes(2);
    });

    it('counts wrong-owner logs toward the flood budget (host paid the clone cost) but never strikes', async () => {
      const sink = mock(() => {});
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
        forwardedLogFloodThreshold: 2,
        forwardedLogFloodWindowMs: 1_000,
        forwardedLogStrikeThreshold: 2,
      });

      await startOwned('wf-log');
      const worker = firstWorker();

      // Wrong-owner logs are dropped (not delivered) but still counted as arrivals. They
      // are NOT strikes (benign mistiming), so the discard here is FLOODING, not strikes:
      // three arrivals exceed the flood threshold of 2.
      dispatchLog(worker, logRecord('spoof', 'wf-victim'), 'wf-victim');
      dispatchLog(worker, logRecord('spoof', 'wf-victim'), 'wf-victim');
      expect(mockPool.discard).not.toHaveBeenCalled();
      dispatchLog(worker, logRecord('spoof', 'wf-victim'), 'wf-victim');

      expect(sink).not.toHaveBeenCalled();
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
    });

    it('discards after repeated oversize/invalid records reach the lifetime strike threshold', async () => {
      const sink = mock(() => {});
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
        forwardedLogFloodThreshold: 1_000, // high, so this discard is strikes, not flood
        forwardedLogStrikeThreshold: 3,
      });

      await startOwned('wf-log');
      const worker = firstWorker();

      const oversize = { ...logRecord('big'), attributes: { blob: 'x'.repeat(8_192) } };
      const invalid = { not: 'a-log-record' };

      // Mixed oversize + invalid accumulate into ONE lifetime strike bucket.
      dispatchLog(worker, oversize); // strike 1 (oversize)
      dispatchLog(worker, invalid); // strike 2 (invalid)
      expect(mockPool.discard).not.toHaveBeenCalled();
      dispatchLog(worker, oversize); // strike 3 == threshold → discard
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      expect(lastMessage()).toMatchObject({ type: 'failed', failureCategory: 'system' });
    });

    it('never strikes valid in-budget records (a high-log honest worker is safe)', async () => {
      const sink = mock(() => {});
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
        forwardedLogFloodThreshold: 1_000,
        forwardedLogStrikeThreshold: 1, // even at 1, valid records never strike
      });

      await startOwned('wf-log');
      const worker = firstWorker();

      dispatchLog(worker, logRecord('ok-1'));
      dispatchLog(worker, logRecord('ok-2'));
      dispatchLog(worker, logRecord('ok-3'));

      expect(mockPool.discard).not.toHaveBeenCalled();
      expect(sink).toHaveBeenCalledTimes(3);
    });

    it('does not strike a single oversize or invalid record (single occurrence never discards)', async () => {
      const sink = mock(() => {});
      setup(1, {
        maxProtocolMessageBytes: 4_096,
        requireProtocolVersion: true,
        onLog: sink,
        forwardedLogFloodThreshold: 1_000,
        forwardedLogStrikeThreshold: 5,
      });

      await startOwned('wf-log');
      const worker = firstWorker();

      const oversize = { ...logRecord('big'), attributes: { blob: 'x'.repeat(8_192) } };
      dispatchLog(worker, oversize); // one strike, below threshold
      dispatchLog(worker, { not: 'a-log' }); // two strikes, still below threshold

      expect(mockPool.discard).not.toHaveBeenCalled();
    });

    it('cannot flood-count a worker that owns no workflows (listener detached on settle)', async () => {
      // Proves the abuse counter and the "no owned workflows" discard branch are mutually
      // exclusive: a flood discard can only fire while the worker owns >= 1 workflow (its
      // message listener is attached); once its only workflow settles, the listener detaches
      // and no further `log` reaches the counter. So the early-return-when-empty branch in
      // #discardWorkerAndFailWorkflows is never the path that a log-abuse discard takes.
      const sink = mock(() => {});
      setup(1, {
        requireProtocolVersion: true,
        maxProtocolMessageBytes: 4_096,
        onLog: sink,
        forwardedLogFloodThreshold: 1, // trips on the 2nd arrival, if any arrive
      });

      await startOwned('wf-log');
      const worker = firstWorker();
      const runMessage = worker.postMessage.mock.calls[0]![0] as { turnId: number };
      const runTurnId = runMessage.turnId;

      // Settle the worker's only workflow → release + detach-if-idle.
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: {
            type: 'completed',
            protocolVersion: WORKER_PROTOCOL_VERSION,
            turnId: runTurnId,
            workflowId: 'wf-log',
            result: 'done',
          } satisfies WorkerOutboundMessage,
        }),
      );
      await sleepForTesting(0);

      const sinkCallsBefore = sink.mock.calls.length;
      // Flood the now-unowned worker. The listener is detached, so these never reach
      // #handleWorkerMessage / the counter: no delivery, no discard.
      for (let i = 0; i < 10; i++) {
        dispatchLog(worker, logRecord(`post-settle-${i}`));
      }
      expect(sink.mock.calls.length).toBe(sinkCallsBefore);
      expect(mockPool.discard).not.toHaveBeenCalled();
    });
  });

  describe('realm-ready handshake (WFT-28)', () => {
    function readyMessage(
      overrides: Partial<{
        protocolVersion: number;
        realmGeneration: string;
        manifest: unknown;
      }> = {},
    ): Record<string, unknown> {
      return {
        type: 'ready',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        realmGeneration: 'test-realm-generation',
        manifest: buildInternalRealmManifest(['test']),
        ...overrides,
      };
    }

    function dispatchReady(
      worker: MockWorker,
      overrides?: Partial<{
        protocolVersion: number;
        realmGeneration: string;
        manifest: unknown;
      }>,
    ): void {
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', { data: readyMessage(overrides) }),
      );
    }

    async function waitForWorkerMessageListener(worker: MockWorker): Promise<void> {
      await waitForCondition(() => worker._listeners.has('message'), {
        label: 'worker message listener to be attached',
      });
    }

    async function waitForWorkerDiscard(worker: MockWorker): Promise<void> {
      await waitForCondition(
        () => {
          expect(mockPool.discard).toHaveBeenCalledWith(worker);
          return true;
        },
        { label: 'worker to be discarded after rejected realm-ready handshake' },
      );
    }

    it('throws when requireRealmReady is true but getExpectedWorkflowTypes is not provided', () => {
      mockWorkers = [createMockWorker()];
      mockPool = createMockPool(mockWorkers);
      expect(() => new WorkerExecutionStrategy(mockPool, { requireRealmReady: true })).toThrow(
        'getExpectedWorkflowTypes is required',
      );
    });

    it('swallows a ready message under default config without discarding the worker', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-default-config',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(10);

      const worker = firstWorker();
      // Default config sends `run` immediately (no handshake required); a `ready`
      // arriving anyway must be swallowed, not reach the strict per-turn gate that
      // would otherwise discard the worker for a message with no `workflowId`.
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
      dispatchReady(worker);
      await sleepForTesting(10);

      expect(mockPool.discard).not.toHaveBeenCalled();
      expect(messages.some((message) => message.type === 'failed')).toBe(false);
    });

    it('waits for the ready handshake before sending the first run message', async () => {
      setup(1, { requireRealmReady: true, getExpectedWorkflowTypes: () => ['test'] });

      strategy.startWorkflow({
        workflowId: 'wf-waits',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      const worker = firstWorker();
      await waitForWorkerMessageListener(worker);
      expect(worker.postMessage).not.toHaveBeenCalled();

      dispatchReady(worker);
      await waitForCondition(() => worker.postMessage.mock.calls.length === 1, {
        label: 'run message after realm-ready handshake',
      });

      expect(worker.postMessage).toHaveBeenCalledTimes(1);
      expect(worker.postMessage.mock.calls[0]![0]).toMatchObject({
        type: 'run',
        workflowId: 'wf-waits',
      });
    });

    it('skips the wait for a worker that already completed its handshake', async () => {
      setup(1, { requireRealmReady: true, getExpectedWorkflowTypes: () => ['test'] });

      strategy.startWorkflow({
        workflowId: 'wf-first',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      const worker = firstWorker();
      await waitForWorkerMessageListener(worker);
      dispatchReady(worker);
      await waitForCondition(() => worker.postMessage.mock.calls.length === 1, {
        label: 'first run message after realm-ready handshake',
      });
      expect(worker.postMessage).toHaveBeenCalledTimes(1);

      const runTurnId = (worker.postMessage.mock.calls[0]![0] as { turnId?: number }).turnId ?? 0;
      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', {
          data: { type: 'completed', turnId: runTurnId, workflowId: 'wf-first', result: 'done' },
        }),
      );
      await waitForCondition(
        () => {
          expect(mockPool.release).toHaveBeenCalledTimes(1);
          return true;
        },
        { label: 'worker release after first workflow completion' },
      );

      strategy.startWorkflow({
        workflowId: 'wf-second',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await waitForCondition(() => worker.postMessage.mock.calls.length === 2, {
        label: 'second run message on ready recycled worker',
      });

      // Recycled worker: the second run is sent without waiting for another ready.
      expect(worker.postMessage).toHaveBeenCalledTimes(2);
      expect(worker.postMessage.mock.calls[1]![0]).toMatchObject({
        type: 'run',
        workflowId: 'wf-second',
      });
    });

    it('discards the worker and fails the workflow when the ready manifest disagrees with the expected workflow types', async () => {
      setup(1, { requireRealmReady: true, getExpectedWorkflowTypes: () => ['test'] });

      strategy.startWorkflow({
        workflowId: 'wf-manifest-mismatch',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      const worker = firstWorker();
      await waitForWorkerMessageListener(worker);

      dispatchReady(worker, { manifest: buildInternalRealmManifest(['a-different-workflow']) });
      await waitForWorkerDiscard(worker);

      expect(worker.postMessage).not.toHaveBeenCalled();
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      expect(lastMessage()).toMatchObject({ type: 'failed', workflowId: 'wf-manifest-mismatch' });
    });

    it('discards the worker and fails the workflow when the ready protocolVersion disagrees', async () => {
      setup(1, { requireRealmReady: true, getExpectedWorkflowTypes: () => ['test'] });

      strategy.startWorkflow({
        workflowId: 'wf-protocol-mismatch',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      const worker = firstWorker();
      await waitForWorkerMessageListener(worker);

      dispatchReady(worker, { protocolVersion: WORKER_PROTOCOL_VERSION + 1 });
      await waitForWorkerDiscard(worker);

      expect(worker.postMessage).not.toHaveBeenCalled();
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      expect(lastMessage()).toMatchObject({ type: 'failed', workflowId: 'wf-protocol-mismatch' });
    });

    it('discards the worker and fails the workflow when the realm never sends ready before the timeout', async () => {
      useFakeTimers();
      setup(1, {
        requireRealmReady: true,
        getExpectedWorkflowTypes: () => ['test'],
        realmReadyTimeoutMs: 5,
      });

      strategy.startWorkflow({
        workflowId: 'wf-ready-timeout',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(0);
      await advanceTimersByTime(5);

      const worker = firstWorker();
      expect(worker.postMessage).not.toHaveBeenCalled();
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      expect(lastMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-ready-timeout',
        failureCategory: 'timeout',
      });
    });

    it('does not double-discard when a worker crashes while the ready handshake is pending', async () => {
      useFakeTimers();
      setup(1, {
        requireRealmReady: true,
        getExpectedWorkflowTypes: () => ['test'],
        realmReadyTimeoutMs: 50,
      });

      strategy.startWorkflow({
        workflowId: 'wf-crash-during-wait',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(0);
      const worker = firstWorker();

      dispatchToMockWorker(worker, 'error', new ErrorEvent('error', { message: 'boom' }));
      await sleepForTesting(0);

      expect(worker.postMessage).not.toHaveBeenCalled();
      expect(mockPool.discard).toHaveBeenCalledTimes(1);
      expect(messages.filter((message) => message.type === 'failed')).toHaveLength(1);

      // The crash already settled the pending waiter (via `forget`, which clears
      // the timeout); the original ready-timeout must not fire a second discard.
      await advanceTimersByTime(50);
      await sleepForTesting(0);

      expect(mockPool.discard).toHaveBeenCalledTimes(1);
      expect(messages.filter((message) => message.type === 'failed')).toHaveLength(1);
    });

    it('settles a pending ready wait without hanging or double-discarding when the strategy is disposed mid-handshake', async () => {
      setup(1, { requireRealmReady: true, getExpectedWorkflowTypes: () => ['test'] });

      strategy.startWorkflow({
        workflowId: 'wf-disposed-during-wait',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await sleepForTesting(0);
      const worker = firstWorker();

      strategy[Symbol.dispose]();
      await sleepForTesting(10);

      expect(worker.postMessage).not.toHaveBeenCalled();
    });

    it('discards the worker when the ready message exceeds the protocol size limit', async () => {
      setup(1, {
        requireRealmReady: true,
        getExpectedWorkflowTypes: () => ['test'],
        maxProtocolMessageBytes: 256,
      });

      strategy.startWorkflow({
        workflowId: 'wf-oversize-ready',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      const worker = firstWorker();
      await waitForWorkerMessageListener(worker);

      const oversizeManifest = buildInternalRealmManifest(
        Array.from({ length: 50 }, (_, index) => `workflow-type-${index}`),
      );
      dispatchReady(worker, { manifest: oversizeManifest });
      await waitForWorkerDiscard(worker);

      expect(worker.postMessage).not.toHaveBeenCalled();
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      expect(lastMessage()).toMatchObject({
        type: 'failed',
        workflowId: 'wf-oversize-ready',
        failureCategory: 'resource',
      });
    });

    it('discards the worker when the ready message has an empty realmGeneration', async () => {
      setup(1, { requireRealmReady: true, getExpectedWorkflowTypes: () => ['test'] });

      strategy.startWorkflow({
        workflowId: 'wf-empty-generation',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      const worker = firstWorker();
      await waitForWorkerMessageListener(worker);

      dispatchReady(worker, { realmGeneration: '' });
      await waitForWorkerDiscard(worker);

      expect(worker.postMessage).not.toHaveBeenCalled();
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      expect(lastMessage()).toMatchObject({ type: 'failed', workflowId: 'wf-empty-generation' });
    });

    it('discards the worker when the ready message manifest fails to parse', async () => {
      setup(1, { requireRealmReady: true, getExpectedWorkflowTypes: () => ['test'] });

      strategy.startWorkflow({
        workflowId: 'wf-bad-manifest',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      const worker = firstWorker();
      await waitForWorkerMessageListener(worker);

      dispatchReady(worker, { manifest: 42 });
      await waitForWorkerDiscard(worker);

      expect(worker.postMessage).not.toHaveBeenCalled();
      expect(mockPool.discard).toHaveBeenCalledWith(worker);
      const failure = lastMessage() as WorkerOutboundMessage & { error: string };
      expect(failure).toMatchObject({ type: 'failed', workflowId: 'wf-bad-manifest' });
      expect(failure.error).toContain('rejected');
    });
  });
});
