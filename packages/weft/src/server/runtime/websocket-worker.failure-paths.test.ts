/**
 * Failure-path tests for `handleWorkerWebSocketMessage`: the branches a healthy worker never
 * reaches (a rejected substitute result, a revision-mismatched resend, an unreadable ledger, a
 * wire-level registration rejection). The happy-path and per-message-variant suites live in
 * `websocket-worker.characterization.test.ts`.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import {
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskLeased,
} from '../../core/task-ledger/task-ledger.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../../worker/protocol.ts';
import { manifestForActivities } from '../../worker/registry-fixtures.test-support.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { handleWorkerWebSocketMessage } from './websocket-worker.ts';

type FakeWs = {
  data: WebSocketData;
  sentMessages: string[];
  closeCode?: number;
  terminated: boolean;
  readyState: number;
  send(message: string): void;
  close(code: number, reason: string): void;
  unsubscribe(topic: string): void;
  terminate(): void;
};

function createFakeWs(): FakeWs {
  return {
    data: { pathname: '/v1/tasks/default/stream', connectionType: 'worker', queue: 'default' },
    sentMessages: [],
    terminated: false,
    readyState: WebSocket.OPEN,
    send(message) {
      this.sentMessages.push(message);
    },
    close(code) {
      this.closeCode = code;
    },
    unsubscribe() {},
    terminate() {
      this.terminated = true;
    },
  };
}

const NOOP_CLEANUP = (_operationId: string) => {};

function registerMessageJson(workerId: string): string {
  return JSON.stringify({
    type: 'register',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId,
    manifest: manifestForActivities(['doWork']),
    concurrency: 5,
  });
}

function leasedRecord(overrides: Partial<RemoteTaskLeased>): RemoteTaskLeased {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'doWork',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: now + 30_000,
    firstQueuedAt: now,
    lastQueuedAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

async function registerWorker(
  context: ReturnType<typeof minimalServerContext>,
  options: ReturnType<typeof minimalServeOptions>,
  ws: FakeWs,
  workerId: string,
): Promise<void> {
  handleWorkerWebSocketMessage(
    context,
    options,
    ws as never,
    registerMessageJson(workerId),
    NOOP_CLEANUP,
  );
  await waitForCondition(() => context.registry.getWorker(workerId) !== undefined, {
    label: 'worker registered',
  });
}

function protocolErrors(ws: FakeWs): Array<{ code: string; message: string }> {
  return ws.sentMessages
    .map((raw) => JSON.parse(raw) as { type: string; code: string; message: string })
    .filter((message) => message.type === 'protocolError');
}

describe('taskResult failure paths', () => {
  it('logs, and acknowledges nothing, when the substitute failure for an oversized result cannot be persisted', async () => {
    const storage = new MemoryStorage();
    const context = minimalServerContext();
    (context as { payloadSizeMaxBytes: number | null }).payloadSizeMaxBytes = 64;
    const options = minimalServeOptions(storage);
    const ws = createFakeWs();
    await registerWorker(context, options, ws, 'worker-1');
    // The registry holds this attempt, but the durable ledger has since moved to another attempt
    // token, so the substitute "failed" result is refused by the ledger.
    context.registry.assignTask('worker-1', 'op-1', 30_000, undefined, 'attempt-token');
    await storage.put(
      taskLedgerKey('op-1'),
      encodeRemoteTaskRecord(leasedRecord({ attemptToken: 'a-newer-attempt-token' })),
    );
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const sentBefore = ws.sentMessages.length;

    try {
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-1',
          attemptToken: 'attempt-token',
          status: 'completed',
          value: { blob: 'x'.repeat(200) },
        }),
        NOOP_CLEANUP,
      );
      await waitForCondition(() => errorSpy.mock.calls.length > 0, {
        label: 'persistence failure logged',
      });

      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
        'Failed to persist oversized task result rejection for task "op-1"',
      );
    } finally {
      errorSpy.mockRestore();
    }
    const acknowledgements = ws.sentMessages
      .slice(sentBefore)
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((message) => message.type === 'taskResultAck');
    expect(acknowledgements).toEqual([]);
    expect(protocolErrors(ws)[0]?.code).toBe('invalid_message');
  });

  it('rejects a resend whose workflowRevision echo differs from the ledger record when no in-flight entry remains', async () => {
    const storage = new MemoryStorage();
    const context = minimalServerContext();
    const options = minimalServeOptions(storage);
    const ws = createFakeWs();
    await registerWorker(context, options, ws, 'worker-1');
    await storage.put(
      taskLedgerKey('op-1'),
      encodeRemoteTaskRecord(leasedRecord({ workflowRevision: 'revision-recorded' })),
    );
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const sentBefore = ws.sentMessages.length;

    try {
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-1',
          attemptToken: 'attempt-token',
          status: 'completed',
          value: 'done',
          workflowRevision: 'revision-echoed-wrongly',
        }),
        NOOP_CLEANUP,
      );
      await waitForCondition(() => ws.sentMessages.length > sentBefore, {
        label: 'revision mismatch rejected',
      });
    } finally {
      errorSpy.mockRestore();
    }

    expect(protocolErrors(ws).at(-1)?.message).toContain('revision mismatch');
  });

  it('logs when the ledger cannot be read while resolving a result with no in-flight entry', async () => {
    class UnreadableLedgerStorage extends MemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        if (key === taskLedgerKey('op-unreadable')) throw new Error('ledger read failed');
        return super.get(key);
      }
    }
    const storage = new UnreadableLedgerStorage();
    const context = minimalServerContext();
    const options = minimalServeOptions(storage);
    const ws = createFakeWs();
    await registerWorker(context, options, ws, 'worker-1');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'taskResult',
          operationId: 'op-unreadable',
          attemptToken: 'attempt-token',
          status: 'completed',
          value: 'done',
        }),
        NOOP_CLEANUP,
      );
      await waitForCondition(() => errorSpy.mock.calls.length > 0, {
        label: 'fallback failure logged',
      });

      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
        'Failed to resolve fallback task result for "op-unreadable"',
      );
      const logged = errorSpy.mock.calls[0]?.[1] as Error;
      expect(logged.message).toBe('ledger read failed');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('registration wire rejection', () => {
  it('relays the parser message when a register frame is missing a required field', async () => {
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
        manifest: manifestForActivities(['doWork']),
        concurrency: 1,
      }),
      NOOP_CLEANUP,
    );

    expect(ws.sentMessages).toHaveLength(1);
    const reply = JSON.parse(ws.sentMessages[0]!);
    expect(reply.type).toBe('registerError');
    expect(reply.code).toBe('invalid_registration');
    expect(reply.message).toMatch(/workerId/);
    expect(ws.closeCode).toBeDefined();
    // The rejection force-terminates the socket on a short timer; let it fire before the test ends.
    await waitForCondition(() => ws.terminated, { label: 'rejected socket terminated' });
  });
});
