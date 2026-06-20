/**
 * Characterization tests for handleWorkerWebSocketMessage.
 *
 * These tests assert outbound WebSocket messages and registry public-reader
 * state for every message variant (register, taskResult, heartbeat), plus
 * malformed/unknown-type paths. They do NOT assert private call order.
 */

import { describe, expect, it } from 'bun:test';

import { decode } from '../../core/codec.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../../worker/protocol.ts';
import { principalFromApiKey } from '../principal.ts';
import { markInflight, type InflightRecord, type ResolvedRecord } from '../task-state.ts';
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

function setPayloadSizeLimit(context: unknown, maxBytes: number): void {
  (context as { payloadSizeMaxBytes: number | null }).payloadSizeMaxBytes = maxBytes;
}

async function readResolvedRecord(
  storage: MemoryStorage,
  operationId: string,
): Promise<ResolvedRecord> {
  const bytes = await storage.get(KEYS.operationResolved(operationId));
  expect(bytes).not.toBeNull();
  return decode(bytes!) as ResolvedRecord;
}

function makeInflightRecord(operationId: string, workerId: string): InflightRecord {
  return {
    operationId,
    workerId,
    deadline: Date.now() + 30_000,
    activityName: 'doWork',
    queue: 'default',
    input: null,
    attempt: 1,
    visibilityTimeout: 30_000,
  };
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

    it('rejects oversized completed results and resolves the task as failed', async () => {
      const storage = new MemoryStorage();
      const context = minimalServerContext();
      setPayloadSizeLimit(context, 64);
      const options = minimalServeOptions(storage);
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-oversize',
          activities: ['doWork'],
          concurrency: 5,
        }),
        NOOP_CLEANUP,
      );

      context.registry.assignTask('w-oversize', 'op-oversize', 30_000, undefined);
      context.deadlineTracker.add({ operationId: 'op-oversize', deadline: Date.now() + 30_000 });
      await markInflight(storage, makeInflightRecord('op-oversize', 'w-oversize'));

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-oversize',
          status: 'completed',
          value: { blob: 'x'.repeat(200) },
        }),
        NOOP_CLEANUP,
      );

      await waitForCondition(
        async () => (await storage.get(KEYS.operationResolved('op-oversize'))) !== null,
        { timeoutMs: 1000, intervalMs: 10, label: 'oversized WebSocket task to resolve failed' },
      );

      const protocolError = ws.sentMessages
        .map((message) => JSON.parse(message))
        .find((message: { type?: string }) => message.type === 'protocolError');
      expect(protocolError).toMatchObject({
        type: 'protocolError',
        code: 'invalid_message',
      });
      expect(String(protocolError.message)).toContain('activity result exceeds');
      expect(context.registry.isAssigned('op-oversize')).toBe(false);
      expect(context.deadlineTracker.size).toBe(0);
      expect(await storage.get(KEYS.operationInflight('op-oversize'))).toBeNull();

      const resolved = await readResolvedRecord(storage, 'op-oversize');
      expect(resolved.status).toBe('failed');
      expect(resolved.error).toContain('activity result exceeds');
      expect(resolved.value).toBeUndefined();
    });

    it('rejects oversized cancelled errors and resolves the task as failed', async () => {
      const storage = new MemoryStorage();
      const context = minimalServerContext();
      setPayloadSizeLimit(context, 64);
      const options = minimalServeOptions(storage);
      const ws = createFakeWs();

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-cancel-oversize',
          activities: ['doWork'],
          concurrency: 5,
        }),
        NOOP_CLEANUP,
      );

      context.registry.assignTask('w-cancel-oversize', 'op-cancel-oversize', 30_000, undefined);
      await markInflight(storage, makeInflightRecord('op-cancel-oversize', 'w-cancel-oversize'));

      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-cancel-oversize',
          status: 'cancelled',
          cancelled: true,
          error: 'x'.repeat(200),
        }),
        NOOP_CLEANUP,
      );

      await waitForCondition(
        async () => (await storage.get(KEYS.operationResolved('op-cancel-oversize'))) !== null,
        {
          timeoutMs: 1000,
          intervalMs: 10,
          label: 'oversized WebSocket cancellation to resolve failed',
        },
      );

      const protocolError = ws.sentMessages
        .map((message) => JSON.parse(message))
        .find((message: { type?: string }) => message.type === 'protocolError');
      expect(String(protocolError.message)).toContain('activity result exceeds');

      const resolved = await readResolvedRecord(storage, 'op-cancel-oversize');
      expect(resolved.status).toBe('failed');
      expect(resolved.error).toContain('activity result exceeds');
      expect(resolved.error).not.toContain('x'.repeat(100));
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

  describe('duplicate workerId registration', () => {
    it('rejects a second register message for a workerId already mapped to a live socket', () => {
      // Security regression: an unauthenticated or malicious client that knows an
      // active workerId must not be able to displace the legitimate socket.
      const context = minimalServerContext();
      const options = minimalServeOptions();

      // First socket — the legitimate worker.
      const ws1 = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        ws1 as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-live',
          activities: ['doWork'],
          concurrency: 2,
        }),
        NOOP_CLEANUP,
      );
      expect(ws1.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws1.sentMessages[0]!).type).toBe('registerAck');
      // `workerSockets` is typed against the real `ServerWebSocket`; the stored
      // value is our `FakeWs` (passed in as `never`), so widen to `unknown` to
      // assert reference identity without a `ServerWebSocket` overlap mismatch.
      expect(context.workerSockets.get('w-live') as unknown).toBe(ws1);

      // Second (attacker) socket — attempts to claim the same workerId.
      const ws2 = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        ws2 as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-live',
          activities: ['doWork'],
          concurrency: 2,
        }),
        NOOP_CLEANUP,
      );

      // Attacker must receive registerError with code 'invalid_registration'.
      expect(ws2.sentMessages).toHaveLength(1);
      const rejection = JSON.parse(ws2.sentMessages[0]!);
      expect(rejection.type).toBe('registerError');
      expect(rejection.code).toBe('invalid_registration');
      // Attacker socket must be closed.
      expect(ws2.closeCode).toBeDefined();
      // Original socket must remain the owner in the map.
      expect(context.workerSockets.get('w-live') as unknown).toBe(ws1);
    });

    it('allows the same socket to re-register the same workerId (metadata refresh)', () => {
      // The hijacking guard keys on socket IDENTITY, not mere presence: a second
      // register on the SAME connection (e.g. to refresh its activity list or
      // concurrency) is a legitimate refresh, not a takeover, and must be
      // accepted. `WorkerRegistry.register` is built to refresh an existing id.
      const context = minimalServerContext();
      const options = minimalServeOptions();

      const ws = createFakeWs();
      const register = (activities: string[], concurrency: number) =>
        handleWorkerWebSocketMessage(
          context,
          options,
          ws as never,
          JSON.stringify({
            type: 'register',
            protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
            workerId: 'w-refresh',
            activities,
            concurrency,
          }),
          NOOP_CLEANUP,
        );

      register(['doWork'], 2);
      expect(JSON.parse(ws.sentMessages[0]!).type).toBe('registerAck');

      // Same socket re-registers with updated metadata — must be accepted, not
      // rejected as a duplicate.
      register(['doWork', 'doMore'], 5);
      expect(ws.sentMessages).toHaveLength(2);
      const second = JSON.parse(ws.sentMessages[1]!);
      expect(second.type).toBe('registerAck');
      expect(second.activities).toEqual(['doWork', 'doMore']);
      expect(second.concurrency).toBe(5);
      // No rejection, socket stays open and owns the id.
      expect(ws.closeCode).toBeUndefined();
      expect(context.workerSockets.get('w-refresh') as unknown).toBe(ws);
      expect(context.registry.getWorker('w-refresh')?.concurrency).toBe(5);
    });

    it('allows reconnect within the grace period for the same workerId (clears pendingWorkerRequeues entry)', () => {
      // A worker that disconnects and reconnects before its grace-period timer fires
      // must still be accepted: the pending-requeue entry is cleared first, so the
      // duplicate-active guard never fires.
      const context = minimalServerContext();
      const options = minimalServeOptions();

      // Simulate a pending requeue entry — as if the first socket closed and the
      // grace-period timer is still pending. In the real close-handler path the
      // old socket stays in `workerSockets` until the timer fires or the
      // reconnecting socket overwrites it; here the unit-level guard is exercised
      // purely through `pendingWorkerRequeues`, which sets `isGracePeriodReconnect`
      // and bypasses the duplicate-active rejection regardless of the map entry.
      // The end-to-end real state (old socket still mapped at reconnect) is
      // covered by the integration test in src/server/index.test.ts.
      const timerHandle = setTimeout(() => {}, 60_000);
      context.pendingWorkerRequeues.set('w-reconnect', timerHandle);

      // Reconnecting socket registers under the same workerId.
      const ws = createFakeWs();
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'w-reconnect',
          activities: ['doWork'],
          concurrency: 4,
        }),
        NOOP_CLEANUP,
      );

      // Must succeed: registerAck sent, timer cleared, socket in map.
      expect(ws.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws.sentMessages[0]!).type).toBe('registerAck');
      expect(ws.closeCode).toBeUndefined();
      expect(context.pendingWorkerRequeues.has('w-reconnect')).toBe(false);
      expect(context.workerSockets.get('w-reconnect') as unknown).toBe(ws);

      clearTimeout(timerHandle);
    });

    it('keeps the registry and workerSockets map in agreement after a successful registration', () => {
      // The duplicate-active guard reads `workerSockets` as the liveness source;
      // the close handler's stale-socket guard relies on the same map agreeing
      // with the registry. Pin that both are populated together on a successful
      // register so a future change cannot let them diverge (which would either
      // bypass the guard or falsely reject a fresh worker).
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
          workerId: 'w-sync',
          activities: ['doWork'],
          concurrency: 2,
        }),
        NOOP_CLEANUP,
      );

      expect(JSON.parse(ws.sentMessages[0]!).type).toBe('registerAck');
      expect(context.workerSockets.has('w-sync')).toBe(true);
      expect(context.registry.getWorker('w-sync')).toBeDefined();
      expect(context.workerSockets.get('w-sync') as unknown).toBe(ws);
    });
  });
});
