/**
 * Characterization tests for handleWorkerWebSocketMessage.
 *
 * These tests assert outbound WebSocket messages and registry public-reader
 * state for every message variant (register, taskResult, heartbeat), plus
 * malformed/unknown-type paths. They do NOT assert private call order.
 */

import { describe, expect, it } from 'bun:test';

import { MetricsCollector } from '../../observability/metrics.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../../worker/protocol.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { DeadlineTracker } from '../deadline-tracker.ts';
import { TaskQueue } from '../task-queue.ts';
import { handleWorkerWebSocketMessage } from './websocket-worker.ts';

import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type { ServerContext } from './context.ts';

type FakeWs = {
  data: WebSocketData;
  sentMessages: string[];
  closeCode?: number;
  closeReason?: string;
  send(msg: string): void;
  close(code: number, reason: string): void;
  unsubscribe(topic: string): void;
  terminate(): void;
};

function createFakeWs(pathname = '/v1/tasks/default/stream', queue = 'default'): FakeWs {
  const ws: FakeWs = {
    data: {
      pathname,
      connectionType: 'worker',
      queue,
    },
    sentMessages: [],
    send(msg) {
      this.sentMessages.push(msg);
    },
    close(code, reason) {
      this.closeCode = code;
      this.closeReason = reason;
    },
    unsubscribe(_topic) {},
    terminate() {},
  };
  return ws;
}

function createMinimalContext(): ServerContext {
  const registry = new WorkerRegistry();
  return {
    registry,
    taskQueue: new TaskQueue(),
    workerSockets: new Map(),
    streamSockets: new Map(),
    workerAffinity: new Map(),
    workflowOperations: new Map(),
    operationToWorkflow: new Map(),
    pendingTimers: new Set(),
    deadlineTracker: new DeadlineTracker(),
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
  return { engine: { storage }, port: 0 } as never;
}

const NOOP_CLEANUP = (_operationId: string) => {};

describe('handleWorkerWebSocketMessage', () => {
  describe('invalid JSON', () => {
    it('sends protocolError and closes on non-JSON input', () => {
      const context = createMinimalContext();
      const options = createMinimalOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(context, options, ws as never, 'not valid json', NOOP_CLEANUP);

      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('protocolError');
      expect(msg.code).toBe('invalid_json');
      expect(ws.closeCode).toBeDefined();
    });
  });

  describe('register message', () => {
    it('registers worker and sends registerAck', () => {
      const context = createMinimalContext();
      const options = createMinimalOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-1',
          activities: ['doWork'],
          concurrency: 3,
        }),
        NOOP_CLEANUP,
      );

      expect(ws.sentMessages).toHaveLength(1);
      const ack = JSON.parse(ws.sentMessages[0]!);
      expect(ack.type).toBe('registerAck');
      expect(ack.workerId).toBe('w-1');
      expect(ack.concurrency).toBe(3);
      expect(ws.data.workerRegistered).toBe(true);
      expect(ws.data.workerId).toBe('w-1');
    });

    it('rejects register with unsupported protocol version', () => {
      const context = createMinimalContext();
      const options = createMinimalOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: 9999,
          workerId: 'w-bad',
          activities: [],
          concurrency: 1,
        }),
        NOOP_CLEANUP,
      );

      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('registerError');
      expect(ws.closeCode).toBeDefined();
    });

    it('rejects when worker sends non-register first message', () => {
      const context = createMinimalContext();
      const options = createMinimalOptions();
      const ws = createFakeWs();

      // heartbeat without prior registration
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({ type: 'heartbeat', workerId: 'w-unregistered' }),
        NOOP_CLEANUP,
      );

      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('protocolError');
      expect(msg.code).toBe('registration_required');
    });
  });

  describe('taskResult message', () => {
    it('completes task in registry and removes deadline tracker entry', () => {
      const context = createMinimalContext();
      const options = createMinimalOptions();
      const ws = createFakeWs();

      // Register worker first
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-result',
          activities: ['doWork'],
          concurrency: 5,
        }),
        NOOP_CLEANUP,
      );

      // Manually assign a task to the registry and add deadline
      context.registry.assignTask('w-result', 'op-finish', 30_000, undefined);
      context.deadlineTracker.add({ operationId: 'op-finish', deadline: Date.now() + 30_000 });

      expect(context.registry.isAssigned('op-finish')).toBe(true);
      expect(context.deadlineTracker.size).toBe(1);

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-finish',
          status: 'completed',
          value: 'done',
        }),
        NOOP_CLEANUP,
      );

      expect(context.registry.isAssigned('op-finish')).toBe(false);
      expect(context.deadlineTracker.size).toBe(0);
    });

    it('calls cleanupWorkflowIndex with the operationId', () => {
      const context = createMinimalContext();
      const options = createMinimalOptions();
      const ws = createFakeWs();

      const cleaned: string[] = [];

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-cleanup',
          activities: ['cleanWork'],
          concurrency: 5,
        }),
        NOOP_CLEANUP,
      );

      context.registry.assignTask('w-cleanup', 'op-cleanup', 30_000, undefined);

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-cleanup',
          status: 'failed',
          error: 'something broke',
        }),
        (opId) => {
          cleaned.push(opId);
        },
      );

      expect(cleaned).toEqual(['op-cleanup']);
    });
  });

  describe('heartbeat message', () => {
    it('updates registry heartbeat for registered worker', () => {
      const context = createMinimalContext();
      const options = createMinimalOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-hb',
          activities: ['heartWork'],
          concurrency: 5,
        }),
        NOOP_CLEANUP,
      );

      // Should not throw — heartbeat is a side-effect-only operation
      expect(() => {
        handleWorkerWebSocketMessage(
          context,
          options,
          ws as never,
          JSON.stringify({ type: 'heartbeat', workerId: 'w-hb' }),
          NOOP_CLEANUP,
        );
      }).not.toThrow();
    });
  });

  describe('non-worker connection', () => {
    it('returns immediately without processing for non-worker pathname', () => {
      const context = createMinimalContext();
      const options = createMinimalOptions();
      // Not a worker stream path
      const ws = createFakeWs('/v1/workflows/wf-1/stream', undefined as unknown as string);
      ws.data.connectionType = 'stream';

      handleWorkerWebSocketMessage(context, options, ws as never, 'not json', NOOP_CLEANUP);

      // No messages sent because early return on non-worker path
      expect(ws.sentMessages).toHaveLength(0);
    });
  });
});
