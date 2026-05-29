/**
 * Characterization tests for handleWorkerWebSocketMessage.
 *
 * These tests assert outbound WebSocket messages and registry public-reader
 * state for every message variant (register, taskResult, heartbeat), plus
 * malformed/unknown-type paths. They do NOT assert private call order.
 */

import { describe, expect, it } from 'bun:test';

import { REMOTE_WORKER_PROTOCOL_VERSION } from '../../worker/protocol.ts';
import { principalFromApiKey } from '../principal.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { handleWorkerWebSocketMessage } from './websocket-worker.ts';

import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';

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

const NOOP_CLEANUP = (_operationId: string) => {};

function workerPrincipal() {
  return principalFromApiKey({ subject: 'worker-key', scopes: ['workers:write'] });
}

describe('handleWorkerWebSocketMessage', () => {
  describe('invalid JSON', () => {
    it('sends protocolError and closes on non-JSON input', () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
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
    it('rejects authenticated worker registration without the worker write scope', () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();
      ws.data.principal = principalFromApiKey({
        subject: 'client-key',
        scopes: ['workflows:read'],
      });

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-no-scope',
          activities: ['doWork'],
          concurrency: 3,
        }),
        NOOP_CLEANUP,
      );

      expect(ws.sentMessages).toHaveLength(1);
      const message = JSON.parse(ws.sentMessages[0]!);
      expect(message.type).toBe('registerError');
      expect(message.message).toContain('workers:write');
      expect(context.registry.getWorker('w-no-scope')).toBeUndefined();
      expect(ws.closeCode).toBeDefined();
    });

    it('accepts authenticated worker registration with the worker write scope', () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();
      ws.data.principal = workerPrincipal();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-worker-scope',
          activities: ['doWork'],
          concurrency: 3,
        }),
        NOOP_CLEANUP,
      );

      expect(ws.sentMessages).toHaveLength(1);
      const ack = JSON.parse(ws.sentMessages[0]!);
      expect(ack.type).toBe('registerAck');
      expect(context.registry.getWorker('w-worker-scope')).toBeDefined();
    });

    it('registers worker and sends registerAck', () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
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
      const context = minimalServerContext();
      const options = minimalServeOptions();
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

    it('rejects a v1 worker at handshake with the canonical incompatibility message', () => {
      // Phase 4 regression. A worker advertising the retired bare-name protocol
      // (v1) must be rejected before any task is dispatched. The error message
      // must point at the protocol mismatch, not at a missing activity.
      const context = minimalServerContext();
      const options = minimalServeOptions();
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: 1,
          workerId: 'w-legacy',
          activities: ['formatGreeting'],
          concurrency: 1,
        }),
        NOOP_CLEANUP,
      );

      expect(ws.sentMessages).toHaveLength(1);
      const msg = JSON.parse(ws.sentMessages[0]!);
      expect(msg.type).toBe('registerError');
      expect(msg.code).toBe('unsupported_protocol_version');
      expect(msg.requestedProtocolVersion).toBe(1);
      expect(msg.message).toContain(`protocol v${String(REMOTE_WORKER_PROTOCOL_VERSION)}`);
      expect(msg.message).toContain('got v1');
      expect(msg.message).toContain('qualified activity names');
      // Old-protocol worker never enters the registry.
      expect(context.registry.getWorker('w-legacy')).toBeUndefined();
      expect(ws.closeCode).toBeDefined();
    });

    it('rejects when worker sends non-register first message', () => {
      const context = minimalServerContext();
      const options = minimalServeOptions();
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
      const context = minimalServerContext();
      const options = minimalServeOptions();
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
      const context = minimalServerContext();
      const options = minimalServeOptions();
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
      const context = minimalServerContext();
      const options = minimalServeOptions();
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
      const context = minimalServerContext();
      const options = minimalServeOptions();
      // Not a worker stream path
      const ws = createFakeWs('/v1/workflows/wf-1/stream', undefined as unknown as string);
      ws.data.connectionType = 'stream';

      handleWorkerWebSocketMessage(context, options, ws as never, 'not json', NOOP_CLEANUP);

      // No messages sent because early return on non-worker path
      expect(ws.sentMessages).toHaveLength(0);
    });
  });
});
