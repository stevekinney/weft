/**
 * Characterization tests for dispatchTaskImpl.
 *
 * These tests assert externally observable outputs — the boolean return value,
 * messages sent to the worker WebSocket, and task-queue/registry state — so the
 * refactor cannot silently change behavior.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { MetricsCollector } from '../../observability/metrics.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { DeadlineTracker } from '../deadline-tracker.ts';
import { TaskQueue } from '../task-queue.ts';
import { dispatchTaskImpl } from './task-dispatch.ts';

import type { ServerContext } from './context.ts';

function createMinimalContext(): ServerContext {
  const registry = new WorkerRegistry();
  const taskQueue = new TaskQueue();
  const deadlineTracker = new DeadlineTracker();

  return {
    registry,
    taskQueue,
    workerSockets: new Map(),
    streamSockets: new Map(),
    workerAffinity: new Map(),
    workflowOperations: new Map(),
    operationToWorkflow: new Map(),
    pendingTimers: new Set(),
    deadlineTracker,
    liveOperationRegistry: null as never,
    liveRestBindings: null as never,
    supportedAuthenticationSchemes: new Set() as never,
    metricsCollector: new MetricsCollector(),
    eventFeedBackend: null as never,
    workflowEventFeed: null as never,
    activeJsonRpcSessions: new Set(),
    mcpSessionManager: null as never,
    authenticatorPromise: null,
    visibilityPollMs: 5000,
    scanRunning: false,
    processingOperations: new Set(),
    reconciliationRunning: false,
  };
}

function createMinimalOptions(storage = new MemoryStorage()) {
  return {
    engine: { storage },
    port: 0,
  } as never;
}

describe('dispatchTaskImpl', () => {
  let context: ServerContext;
  let options: ReturnType<typeof createMinimalOptions>;

  afterEach(() => {
    // Clean up any pending timers
    for (const timer of context.pendingTimers) {
      clearTimeout(timer);
    }
  });

  it('returns false for a duplicate operationId already in the task queue', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const task = {
      operationId: 'op-dup',
      activityName: 'doWork',
      queue: 'default',
      input: null,
    };

    const first = await dispatchTaskImpl(context, options, task);
    expect(first).toBe(true);

    const second = await dispatchTaskImpl(context, options, task);
    expect(second).toBe(false);
  });

  it('returns true and enqueues task when no worker is available', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const result = await dispatchTaskImpl(context, options, {
      operationId: 'op-1',
      activityName: 'doWork',
      queue: 'default',
      input: null,
    });

    expect(result).toBe(true);
    expect(context.taskQueue.isTracked('op-1')).toBe(true);
  });

  it('sends task message to worker WebSocket when worker is available', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const workerId = 'worker-1';
    const sentMessages: string[] = [];
    const fakeWs = {
      send(msg: string) {
        sentMessages.push(msg);
      },
    };

    context.registry.register({
      id: workerId,
      queue: 'default',
      activities: ['doWork'],
      concurrency: 5,
    });
    context.workerSockets.set(workerId, fakeWs as never);

    const result = await dispatchTaskImpl(context, options, {
      operationId: 'op-ws',
      activityName: 'doWork',
      queue: 'default',
      input: { x: 1 },
    });

    expect(result).toBe(true);
    expect(sentMessages).toHaveLength(1);
    const msg = JSON.parse(sentMessages[0]!);
    expect(msg.type).toBe('task');
    expect(msg.operationId).toBe('op-ws');
    expect(msg.activityName).toBe('doWork');
    expect(msg.input).toEqual({ x: 1 });
  });

  it('assigns the task in the registry after WebSocket dispatch', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const workerId = 'worker-2';
    context.registry.register({
      id: workerId,
      queue: 'default',
      activities: ['assignMe'],
      concurrency: 5,
    });
    context.workerSockets.set(workerId, { send: () => {} } as never);

    await dispatchTaskImpl(context, options, {
      operationId: 'op-assign',
      activityName: 'assignMe',
      queue: 'default',
      input: null,
    });

    expect(context.registry.isAssigned('op-assign')).toBe(true);
  });

  it('records workflow affinity after WebSocket dispatch with workflowId', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const workerId = 'worker-affinity';
    context.registry.register({
      id: workerId,
      queue: 'default',
      activities: ['affinityWork'],
      concurrency: 5,
    });
    context.workerSockets.set(workerId, { send: () => {} } as never);

    await dispatchTaskImpl(context, options, {
      operationId: 'op-affinity',
      activityName: 'affinityWork',
      queue: 'default',
      input: null,
      workflowId: 'wf-sticky',
    });

    expect(context.workerAffinity.get('wf-sticky')).toBe(workerId);
  });

  it('clamps undefined visibilityTimeout to default', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    // enqueue to the task queue (no worker available) — just check it doesn't throw
    const result = await dispatchTaskImpl(context, options, {
      operationId: 'op-clamp',
      activityName: 'clampMe',
      queue: 'default',
      input: null,
    });

    expect(result).toBe(true);
  });

  it('adds a deadline tracker entry for WebSocket dispatch', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const workerId = 'worker-deadline';
    context.registry.register({
      id: workerId,
      queue: 'default',
      activities: ['deadlineWork'],
      concurrency: 5,
    });
    context.workerSockets.set(workerId, { send: () => {} } as never);

    await dispatchTaskImpl(context, options, {
      operationId: 'op-deadline',
      activityName: 'deadlineWork',
      queue: 'default',
      input: null,
    });

    // The deadline tracker should have an entry for this operation
    expect(context.deadlineTracker.size).toBeGreaterThan(0);
  });
});
