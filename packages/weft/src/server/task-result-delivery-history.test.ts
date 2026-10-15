/**
 * COR-1366 — transport-level task result delivery history
 * (`weft.tasks.deliveries`), its live event (`task:result-delivery`), and a
 * dead-lettered attempt's retained value (`weft.tasks.deadletters.get`),
 * driven through the real long-poll and WebSocket result paths.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import { encode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import { TaskResultDeliveryEvent } from '../core/events.ts';
import { encodeTaskAttemptRecord, taskAttemptKey } from '../core/task-ledger/task-attempt.ts';
import {
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskLeased,
} from '../core/task-ledger/task-ledger.ts';
import { taskResultDeliveryKey } from '../core/task-ledger/task-result-delivery.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { sha256HexSync } from '../worker/manifest/content-digest.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../worker/protocol.ts';
import { manifestForActivities } from '../worker/registry-fixtures.test-support.ts';
import type { AuthorizationScope } from './authorization-scope.ts';
import type { ServeOptions } from './index.ts';
import type { WebSocketData } from './json-rpc-websocket-runtime.ts';
import { createOperationRegistry, executeOperation } from './operation-catalog.ts';
import { clearTaskDeadLetterOperation } from './operations/clear-task-dead-letter.ts';
import {
  getTaskDeadLetterOperation,
  getTaskDeadLetterRestBinding,
  getTaskResultDeliveriesOperation,
  getTaskResultDeliveriesOutputSchema,
  getTaskResultDeliveriesRestBinding,
  type GetTaskDeadLetterOutput,
  type GetTaskResultDeliveriesOutput,
} from './operations/get-task-deliveries.ts';
import {
  createEngine,
  deadLetteredFixture,
  putLedgerRecord,
  runGetTaskDetail,
} from './operations/get-task-detail.test-support.ts';
import { principalFromApiKey } from './principal.ts';
import { minimalServerContext } from './runtime/server-context.test-support.ts';
import { handleTaskResultRequest } from './runtime/task-result-submission.ts';
import { handleWorkerWebSocketMessage } from './runtime/websocket-worker.ts';

const WORKER_PRINCIPAL = principalFromApiKey({ subject: 'worker', scopes: ['workers:write'] });
const NOOP_CLEANUP = (_operationId: string) => {};

function serveOptions(engine: Engine): ServeOptions {
  return { engine, port: 0 };
}

function leased(operationId: string, overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId,
    workflowId: 'wf-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 1,
    state: 'leased',
    attemptToken: 'secret-attempt-token',
    workerSessionId: 'w-1',
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

async function seedLeased(storage: MemoryStorage, record: RemoteTaskLeased): Promise<void> {
  await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));
  const digest = sha256HexSync(record.attemptToken);
  await storage.put(
    taskAttemptKey(record.operationId, digest),
    encodeTaskAttemptRecord({
      recordVersion: 1,
      operationId: record.operationId,
      attempt: record.attempt,
      attemptTokenDigest: digest,
      workerSessionId: record.workerSessionId,
      claimedAt: record.startedAt,
      disposition: 'leased',
      dispositionAt: record.startedAt,
    }),
  );
}

async function postResult(
  options: ServeOptions,
  body: Record<string, unknown>,
  queue = 'default',
): Promise<Response> {
  const url = `http://localhost/v1/tasks/${queue}/result`;
  const response = await handleTaskResultRequest(
    minimalServerContext({ registry: null as never }),
    options,
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    new URL(url),
    WORKER_PRINCIPAL,
  );
  if (response === null) throw new Error('Expected the long-poll result route to answer');
  return response;
}

async function invoke(
  engine: Engine,
  name: 'weft.tasks.deliveries' | 'weft.tasks.deadletters.get',
  input: Record<string, unknown>,
  scopes: readonly AuthorizationScope[],
) {
  return executeOperation(name, input, {
    principal: principalFromApiKey({ subject: 'operator', scopes }),
    engine,
    transport: 'jsonRpcStdio',
    registry: createOperationRegistry([
      getTaskResultDeliveriesOperation,
      getTaskDeadLetterOperation,
    ]),
  });
}

async function readDeliveries(
  engine: Engine,
  operationId: string,
): Promise<GetTaskResultDeliveriesOutput> {
  const result = await invoke(engine, 'weft.tasks.deliveries', { operationId }, ['system:read']);
  if (!result.ok) throw new Error(`weft.tasks.deliveries failed: ${result.fault.code}`);
  return getTaskResultDeliveriesOutputSchema.parse(result.value);
}

function captureDeliveryEvents(engine: Engine): TaskResultDeliveryEvent[] {
  const events: TaskResultDeliveryEvent[] = [];
  engine.addEventListener(TaskResultDeliveryEvent.type, (event) => {
    events.push(event);
  });
  return events;
}

describe('weft.tasks.deliveries over long-poll', () => {
  it('records every answer, resolves attempts, redacts the token, and announces non-applied outcomes', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    const options = serveOptions(engine);
    const events = captureDeliveryEvents(engine);
    // The long-poll path logs the ledger's commit rejection; keep it out of test output.
    using consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const token = 'secret-attempt-token';
    await seedLeased(storage, leased('op-lp'));
    const submission = { operationId: 'op-lp', workerId: 'w-1', attemptToken: token };

    const cases: ReadonlyArray<readonly [Record<string, unknown>, string, number]> = [
      [{ ...submission, status: 'completed', value: 1 }, 'other', 403],
      [{ ...submission, workerId: 'w-2', status: 'completed' }, 'default', 403],
      [{ ...submission, status: 'completed', value: { total: 1 } }, 'default', 200],
      [{ ...submission, status: 'completed', value: { total: 1 } }, 'default', 200],
      [{ ...submission, status: 'completed', value: { total: 2 } }, 'default', 403],
      [{ ...submission, attemptToken: 'forged-token', status: 'completed' }, 'default', 403],
    ];
    for (const [body, queue, expectedStatus] of cases) {
      const response = await postResult(options, body, queue);
      expect(response.status).toBe(expectedStatus);
    }

    const history = await readDeliveries(engine, 'op-lp');
    expect(history.droppedCount).toBe(0);
    expect(history.historyLimit).toBe(32);
    expect(
      history.deliveries.map((entry) =>
        entry.outcome === 'acknowledged' ? entry.disposition : entry.rejectionCode,
      ),
    ).toEqual([
      'queue-mismatch',
      'worker-mismatch',
      'applied',
      'duplicate',
      'conflicting-content',
      'attempt-token-mismatch',
    ]);
    const digest = sha256HexSync(token);
    expect(history.deliveries.slice(0, 5).every((entry) => entry.attempt === 1)).toBe(true);
    expect(
      history.deliveries.slice(0, 5).every((entry) => entry.attemptTokenDigest === digest),
    ).toBe(true);
    // A forged token never matches an issued attempt.
    expect(history.deliveries[5]?.attempt).toBeUndefined();
    expect(history.deliveries.every((entry) => entry.transport === 'longPoll')).toBe(true);
    // The ledger's conflicting-content reason interpolates the raw token; the
    // recorded reason must not.
    const conflict = history.deliveries[4];
    if (conflict?.outcome !== 'rejected') throw new Error('Expected a rejected delivery');
    expect(conflict.reason).toContain('[attempt token redacted]');
    expect(JSON.stringify(history)).not.toContain(token);
    expect(consoleError).toHaveBeenCalled();

    expect(events.map((event) => event.disposition ?? event.rejectionCode)).toEqual([
      'queue-mismatch',
      'worker-mismatch',
      'duplicate',
      'conflicting-content',
      'attempt-token-mismatch',
    ]);
    expect(events[0]?.workflowId).toBe('wf-1');
    expect(events[0]?.activityName).toBe('charge');

    // Additive only: weft.tasks.get's ledger-level attempts are unchanged.
    const detail = await runGetTaskDetail(engine, 'op-lp');
    if (!detail.ok) throw new Error('Expected weft.tasks.get to succeed');
    expect(Object.keys(detail.value)).not.toContain('deliveries');
    expect(detail.value.attempts[0]?.attemptTokenDigest).toBe(digest);
  });

  it('records nothing for an operation that has no ledger record', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    const response = await postResult(serveOptions(engine), {
      operationId: 'op-never',
      workerId: 'w-1',
      attemptToken: 'token',
      status: 'completed',
    });
    expect(response.status).toBe(403);
    expect(await storage.get(taskResultDeliveryKey('op-never'))).toBeNull();

    const result = await invoke(engine, 'weft.tasks.deliveries', { operationId: 'op-never' }, [
      'system:read',
    ]);
    expect(result.ok ? 'ok' : result.fault.code).toBe('NotFound');
  });

  it('returns an empty, complete history for a task with no deliveries yet', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await seedLeased(storage, leased('op-quiet'));
    const history = await readDeliveries(engine, 'op-quiet');
    expect(history.deliveries).toEqual([]);
    expect(history.droppedCount).toBe(0);
  });
});

describe('weft.tasks.deliveries over WebSocket', () => {
  it('records fast-path rejections, the applied ack, and a fallback duplicate', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    const options = serveOptions(engine);
    const context = minimalServerContext();
    const sent: string[] = [];
    const ws = {
      data: { pathname: '/v1/tasks/default/stream', connectionType: 'worker', queue: 'default' },
      readyState: WebSocket.OPEN,
      send: (message: string) => sent.push(message),
      close: () => {},
      unsubscribe: () => {},
      terminate: () => {},
    } as unknown as { data: WebSocketData };
    const send = (message: Record<string, unknown>) =>
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify(message),
        NOOP_CLEANUP,
      );

    send({
      type: 'register',
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerId: 'w-1',
      manifest: manifestForActivities(['charge']),
      concurrency: 2,
    });
    await waitForCondition(() => context.registry.getWorker('w-1') !== undefined, {
      timeoutMs: 1_000,
      label: 'worker registration',
    });
    context.registry.assignTask('w-1', 'op-ws', 30_000, undefined, 'secret-attempt-token');
    await seedLeased(storage, leased('op-ws'));
    const result = { type: 'taskResult', operationId: 'op-ws', status: 'completed', value: 'ok' };

    send({ ...result, attemptToken: 'wrong-token' });
    send({ ...result, attemptToken: 'secret-attempt-token' });
    await waitForCondition(() => sent.some((message) => message.includes('"applied"')), {
      timeoutMs: 1_000,
      label: 'applied ack',
    });
    send({ ...result, attemptToken: 'secret-attempt-token' });
    await waitForCondition(
      async () => {
        const recorded = await readDeliveries(engine, 'op-ws');
        return recorded.deliveries.length === 3;
      },
      { timeoutMs: 1_000, label: 'three recorded deliveries' },
    );

    const history = await readDeliveries(engine, 'op-ws');
    expect(
      history.deliveries.map((entry) =>
        entry.outcome === 'acknowledged' ? entry.disposition : entry.rejectionCode,
      ),
    ).toEqual(['attempt-token-mismatch', 'applied', 'duplicate']);
    expect(history.deliveries.every((entry) => entry.transport === 'webSocket')).toBe(true);
    expect(history.deliveries.every((entry) => entry.workerId === 'w-1')).toBe(true);
  });
});

describe('weft.tasks.deadletters.get', () => {
  it('requires system:admin — system:read is not enough', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture());
    const result = await invoke(engine, 'weft.tasks.deadletters.get', { operationId: 'op-dead' }, [
      'system:read',
    ]);
    expect(result.ok ? 'ok' : result.fault.code).toBe('Forbidden');
  });

  it('returns the retained value with the attempt digest, never the raw token or headers', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(
      storage,
      deadLetteredFixture({ headers: { authorization: 'Bearer secret' }, input: { card: '4242' } }),
    );
    const result = await invoke(engine, 'weft.tasks.deadletters.get', { operationId: 'op-dead' }, [
      'system:admin',
    ]);
    if (!result.ok) throw new Error(`Expected success, got ${result.fault.code}`);
    const output = result.value as GetTaskDeadLetterOutput;
    expect(output.payload).toEqual({
      kind: 'value',
      value: { secret: 'do not leak' },
      serializedBytes: JSON.stringify({ secret: 'do not leak' }).length,
    });
    expect(output.attemptTokenDigest).toBe(sha256HexSync('attempt-token'));
    expect(output.resultDigest).toBe('digest-pending');
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('"attempt-token"');
    expect(serialized).not.toContain('Bearer secret');
    expect(serialized).not.toContain('4242');
  });

  it('reports a value larger than maxBytes as omitted rather than truncating it', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ value: 'x'.repeat(100) }));
    const result = await invoke(
      engine,
      'weft.tasks.deadletters.get',
      { operationId: 'op-dead', maxBytes: 10 },
      ['system:admin'],
    );
    if (!result.ok) throw new Error(`Expected success, got ${result.fault.code}`);
    expect((result.value as GetTaskDeadLetterOutput).payload).toEqual({
      kind: 'omitted',
      reason: 'exceeds-max-bytes',
      serializedBytes: 102,
      maxBytes: 10,
    });
  });

  it('reports a failed dead letter as having no value, and carries its error', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    const failed = deadLetteredFixture({ pendingStatus: 'failed', error: 'boom' });
    const { value: _value, ...withoutValue } = failed;
    await putLedgerRecord(storage, withoutValue);
    const result = await invoke(engine, 'weft.tasks.deadletters.get', { operationId: 'op-dead' }, [
      'system:admin',
    ]);
    if (!result.ok) throw new Error(`Expected success, got ${result.fault.code}`);
    const output = result.value as GetTaskDeadLetterOutput;
    expect(output.payload).toEqual({ kind: 'absent' });
    expect(output.error).toBe('boom');
  });

  it('reports a completed dead letter whose value is undefined as absent, with no error', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    const { value: _value, ...withoutValue } = deadLetteredFixture();
    await putLedgerRecord(storage, withoutValue);
    const result = await invoke(engine, 'weft.tasks.deadletters.get', { operationId: 'op-dead' }, [
      'system:admin',
    ]);
    if (!result.ok) throw new Error(`Expected success, got ${result.fault.code}`);
    const output = result.value as GetTaskDeadLetterOutput;
    expect(output.payload).toEqual({ kind: 'absent' });
    expect(output.pendingStatus).toBe('completed');
    expect(output.error).toBeUndefined();
  });

  it('answers NotFound for a missing task and for a task that is not dead-lettered', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await seedLeased(storage, leased('op-live'));
    for (const operationId of ['op-missing', 'op-live']) {
      const result = await invoke(engine, 'weft.tasks.deadletters.get', { operationId }, [
        'system:admin',
      ]);
      expect(result.ok ? 'ok' : result.fault.code).toBe('NotFound');
    }
  });
});

describe('delivery history retention', () => {
  it('is cleared together with the dead letter it belongs to', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    const token = 'attempt-token';
    using consoleError = spyOn(console, 'error').mockImplementation(() => {});
    await putLedgerRecord(storage, deadLetteredFixture({ attemptToken: token }));
    // A resend whose content does not match the retained digest is rejected;
    // the rejection is still recorded against the dead letter.
    const response = await postResult(serveOptions(engine), {
      operationId: 'op-dead',
      attemptToken: token,
      status: 'completed',
      value: { secret: 'do not leak' },
    });
    expect(response.status).toBe(403);
    expect(consoleError).toHaveBeenCalled();
    expect(await storage.get(taskResultDeliveryKey('op-dead'))).not.toBeNull();

    const cleared = await executeOperation(
      'weft.tasks.diagnostics.deadletters.clear',
      { operationId: 'op-dead' },
      {
        principal: principalFromApiKey({ subject: 'operator', scopes: ['system:admin'] }),
        engine,
        transport: 'http-rest',
        registry: createOperationRegistry([clearTaskDeadLetterOperation]),
      },
    );
    expect(cleared.ok).toBe(true);
    expect(await storage.get(taskResultDeliveryKey('op-dead'))).toBeNull();
  });
});

describe('task delivery REST bindings', () => {
  it('read the operationId from the path under the reserved /detail/ namespace', async () => {
    const request = new Request('http://localhost/v1/tasks/detail/op-1/deliveries');
    expect(getTaskResultDeliveriesRestBinding.path).toBe(
      '/v1/tasks/detail/:operationId/deliveries',
    );
    expect(
      await getTaskResultDeliveriesRestBinding.extractInput(request, { operationId: 'op-1' }, {}),
    ).toEqual({ operationId: 'op-1' });
    expect(await getTaskResultDeliveriesRestBinding.extractInput(request, {}, {})).toEqual({
      operationId: '',
    });
  });

  it('read maxBytes from the query string, leaving it to the default when absent', async () => {
    const withLimit = new Request('http://localhost/v1/tasks/detail/op-1/dead-letter?maxBytes=10');
    expect(
      await getTaskDeadLetterRestBinding.extractInput(withLimit, { operationId: 'op-1' }, {}),
    ).toEqual({ operationId: 'op-1', maxBytes: 10 });
    for (const url of [
      'http://localhost/v1/tasks/detail/op-1/dead-letter',
      'http://localhost/v1/tasks/detail/op-1/dead-letter?maxBytes=',
    ]) {
      expect(await getTaskDeadLetterRestBinding.extractInput(new Request(url), {}, {})).toEqual({
        operationId: '',
        maxBytes: undefined,
      });
    }
  });
});

describe('task delivery operations on a corrupt ledger record', () => {
  it('fault EngineFailure rather than NotFound', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await storage.put(taskLedgerKey('op-corrupt'), encode({ invalid: true }));
    const deliveries = await invoke(
      engine,
      'weft.tasks.deliveries',
      { operationId: 'op-corrupt' },
      ['system:read'],
    );
    expect(deliveries.ok ? 'ok' : deliveries.fault.code).toBe('EngineFailure');
    const deadLetter = await invoke(
      engine,
      'weft.tasks.deadletters.get',
      { operationId: 'op-corrupt' },
      ['system:admin'],
    );
    expect(deadLetter.ok ? 'ok' : deadLetter.fault.code).toBe('EngineFailure');
  });
});
