import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  advanceTimersByTime,
  restoreRealTimers,
  sleepForTesting,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';

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
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });

    it('forwards signal:received messages from BroadcastChannel to a parked worker', async () => {
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
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
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
});
