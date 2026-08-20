import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from '../../worker/registry-fixtures.test-support.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import type { AuthorizationScope } from '../authorization-scope.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import {
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskDeadLettered,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskTerminalResolved,
} from '../task-ledger.ts';
import { TaskQueue } from '../task-queue.ts';
import {
  clearTaskDeadLetterOperation,
  createGetTaskDiagnosticsOperation,
  type GetTaskDiagnosticsOutput,
} from './get-task-diagnostics.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(storage: MemoryStorage): Engine {
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return engine;
}

function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
  return {
    recordVersion: 1,
    operationId: 'op-queued',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 0,
    generation: 0,
    state: 'queued',
    attempt: 1,
    availableAt: 0,
    firstQueuedAt: 0,
    lastQueuedAt: 0,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function leasedFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  return {
    recordVersion: 1,
    operationId: 'op-leased',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 0,
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: 60_000,
    firstQueuedAt: 0,
    lastQueuedAt: 0,
    startedAt: 0,
    lastHeartbeatAt: 0,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function terminalFixture(
  overrides: Partial<RemoteTaskTerminalResolved> = {},
): RemoteTaskTerminalResolved {
  return {
    recordVersion: 1,
    operationId: 'op-terminal',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 0,
    generation: 2,
    state: 'terminal',
    disposition: 'resolved',
    attempt: 1,
    attemptToken: 'attempt-token',
    status: 'completed',
    resultDigest: 'digest',
    terminalAt: 9_000,
    adopted: false,
    retentionGeneration: 0,
    ...overrides,
  };
}

function deadLetteredFixture(
  overrides: Partial<RemoteTaskDeadLettered> = {},
): RemoteTaskDeadLettered {
  return {
    recordVersion: 1,
    operationId: 'op-dead-lettered',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 0,
    generation: 3,
    state: 'deadLettered',
    attemptToken: 'attempt-token',
    attempt: 2,
    pendingStatus: 'completed',
    pendingResultDigest: 'digest',
    retryCount: 0,
    requeueCount: 0,
    deadLetteredAt: 9_000,
    persistenceFailureReason:
      'lost the compare-and-swap race on operation "op-dead-lettered" after 3 attempt(s)',
    ...overrides,
  };
}

async function putLedgerRecord(
  storage: MemoryStorage,
  record: RemoteTaskQueued | RemoteTaskLeased | RemoteTaskTerminalResolved | RemoteTaskDeadLettered,
): Promise<void> {
  await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));
}

async function runDiagnostics({
  engine,
  registry,
  taskQueue,
  input = {},
  scopes = ['system:read'],
}: {
  engine: Engine;
  registry: WorkerRegistry;
  taskQueue: TaskQueue;
  input?: Record<string, unknown>;
  scopes?: ReadonlyArray<AuthorizationScope>;
}) {
  const operation = createGetTaskDiagnosticsOperation({
    registry,
    taskQueue,
    now: () => 10_000,
  });
  const operationRegistry = createOperationRegistry([operation]);

  return executeOperation('weft.tasks.diagnostics', input, {
    principal: principalFromApiKey({ subject: 'operator', scopes }),
    engine,
    transport: 'jsonRpcStdio',
    registry: operationRegistry,
  });
}

describe('weft.tasks.diagnostics', () => {
  it('identifies stuck queued tasks, stale inflight tasks, retry storms, and capacity saturation', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await putLedgerRecord(
      storage,
      queuedFixture({
        operationId: 'queued-stuck',
        workflowId: 'workflow-a',
        queue: 'payments',
        availableAt: 1_000,
        firstQueuedAt: 1_000,
        lastQueuedAt: 1_000,
      }),
    );
    await putLedgerRecord(
      storage,
      leasedFixture({
        operationId: 'inflight-stale',
        workflowId: 'workflow-a',
        queue: 'payments',
        workerSessionId: 'worker-stale',
        firstQueuedAt: 1_000,
        lastQueuedAt: 1_000,
        startedAt: 2_100,
        lastHeartbeatAt: 3_000,
      }),
    );
    await putLedgerRecord(
      storage,
      leasedFixture({
        operationId: 'retry-storm',
        workflowId: 'workflow-a',
        activityName: 'ship',
        queue: 'payments',
        workerSessionId: 'worker-fresh',
        firstQueuedAt: 1_000,
        lastQueuedAt: 1_000,
        startedAt: 9_900,
        // Fresh heartbeat — must not also trigger stale-inflight, isolating
        // the retry-storm assertion below.
        lastHeartbeatAt: 9_999,
        retryCount: 5,
        requeueCount: 5,
      }),
    );

    registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'worker-capacity',
      queue: 'payments',
      activities: ['charge'],
      concurrency: 1,
    });
    registry.assignTask('worker-capacity', 'busy-operation', 30_000, undefined, 'attempt-token');
    taskQueue.enqueue('payments', {
      operationId: 'queued-capacity',
      activityName: 'charge',
      input: null,
    });

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: {
        workflowId: 'workflow-a',
        staleQueuedAfterMs: 5_000,
        staleHeartbeatAfterMs: 5_000,
        retryStormMinimumAttempts: 3,
        limit: 10,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;

    expect(diagnostics.summary).toEqual({
      stuckQueued: 1,
      staleInflight: 1,
      retryStorms: 1,
      allWorkersAtCapacity: 1,
      deadLettered: 0,
    });
    expect(new Set(diagnostics.items.map((item) => item.kind))).toEqual(
      new Set(['all-workers-at-capacity', 'retry-storm', 'stale-inflight', 'stuck-queued']),
    );
    const stuckQueuedItem = diagnostics.items.find((item) => item.kind === 'stuck-queued');
    expect(stuckQueuedItem).toMatchObject({
      operationId: 'queued-stuck',
      workflowId: 'workflow-a',
      queue: 'payments',
      queueLatencyMs: 9_000,
    });
    const staleInflightItem = diagnostics.items.find((item) => item.kind === 'stale-inflight');
    expect(staleInflightItem).toMatchObject({
      operationId: 'inflight-stale',
      workerId: 'worker-stale',
      heartbeatAgeMs: 7_000,
    });
    const retryStormItem = diagnostics.items.find((item) => item.kind === 'retry-storm');
    expect(retryStormItem).toMatchObject({
      operationId: 'retry-storm',
      state: 'inflight',
      retryCount: 5,
      requeueCount: 5,
    });
  });

  it('lists task-result dead letters (the ledger has no separate guarded inflight record to conflict with)', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await putLedgerRecord(
      storage,
      deadLetteredFixture({
        operationId: 'dead-lettered-operation',
        workflowId: 'workflow-dead-letter',
        queue: 'payments',
        retryCount: 1,
        requeueCount: 1,
        lastRequeueReason: 'visibility-timeout',
        deadLetteredAt: 9_000,
        persistenceFailureReason: 'storage exhausted after 3 attempts',
      }),
    );

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: {
        operationId: 'dead-lettered-operation',
        staleHeartbeatAfterMs: 0,
        limit: 10,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;

    expect(diagnostics.summary.deadLettered).toBe(1);
    expect(diagnostics.summary.staleInflight).toBe(0);
    expect(diagnostics.items).toHaveLength(1);
    expect(diagnostics.items[0]).toMatchObject({
      kind: 'dead-lettered',
      state: 'dead-lettered',
      operationId: 'dead-lettered-operation',
      workflowId: 'workflow-dead-letter',
      queue: 'payments',
      deadLetteredAt: 9_000,
      deadLetterReason: 'result-resolution-storage-exhausted',
      storageError: 'storage exhausted after 3 attempts',
    });
  });

  it('reports no diagnostics for a terminal record — no attempt-count history survives resolution', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await putLedgerRecord(storage, terminalFixture({ operationId: 'resolved-op' }));

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: { operationId: 'resolved-op' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;
    expect(diagnostics.items).toHaveLength(0);
    expect(diagnostics.summary).toEqual({
      stuckQueued: 0,
      staleInflight: 0,
      retryStorms: 0,
      allWorkersAtCapacity: 0,
      deadLettered: 0,
    });
  });

  it('skips a queued record whose availableAt is still in the future — scheduled, not stuck', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await putLedgerRecord(
      storage,
      queuedFixture({
        operationId: 'delayed-retry',
        availableAt: 60_000,
        firstQueuedAt: 1_000,
        lastQueuedAt: 1_000,
      }),
    );

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: { operationId: 'delayed-retry', staleQueuedAfterMs: 0 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;
    expect(diagnostics.items).toHaveLength(0);
  });

  it('bounds diagnostic result items while retaining summary counts', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    for (let index = 0; index < 3; index += 1) {
      await putLedgerRecord(
        storage,
        queuedFixture({
          operationId: `queued-${String(index)}`,
          availableAt: 1_000 + index,
          firstQueuedAt: 1_000 + index,
          lastQueuedAt: 1_000 + index,
        }),
      );
    }

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: { staleQueuedAfterMs: 1_000, limit: 2 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;
    expect(diagnostics.summary.stuckQueued).toBe(3);
    expect(diagnostics.items).toHaveLength(2);
    expect(diagnostics.limit).toBe(2);
  });

  it('requires system read scope', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const operation = createGetTaskDiagnosticsOperation({
      registry: new WorkerRegistry(),
      taskQueue: new TaskQueue(),
    });
    const operationRegistry = createOperationRegistry([operation]);

    const result = await executeOperation(
      'weft.tasks.diagnostics',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: operationRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected authorization failure');
    expect(result.fault.code).toBe('Forbidden');
  });
});

describe('weft.tasks.diagnostics.deadletters.clear', () => {
  function runClear(
    engine: Engine,
    operationId: string,
    scopes: ReadonlyArray<AuthorizationScope>,
  ) {
    const operationRegistry = createOperationRegistry([clearTaskDeadLetterOperation]);
    return executeOperation(
      'weft.tasks.diagnostics.deadletters.clear',
      { operationId },
      {
        principal: principalFromApiKey({ subject: 'operator', scopes }),
        engine,
        transport: 'http-rest',
        registry: operationRegistry,
      },
    );
  }

  it('deletes a dead-lettered ledger record, freeing the operationId', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-to-clear' }));

    const result = await runClear(engine, 'op-to-clear', ['system:admin']);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected clear to succeed');
    expect(result.value).toEqual({ ok: true });
    expect(await storage.get(taskLedgerKey('op-to-clear'))).toBeNull();
  });

  it('faults NotFound when no dead-lettered record exists for the operationId', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);

    const result = await runClear(engine, 'never-dispatched', ['system:admin']);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected NotFound fault');
    expect(result.fault.code).toBe('NotFound');
  });

  it('faults NotFound rather than clearing a record that is not currently dead-lettered', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, queuedFixture({ operationId: 'still-queued' }));

    const result = await runClear(engine, 'still-queued', ['system:admin']);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected NotFound fault');
    expect(result.fault.code).toBe('NotFound');
    expect(await storage.get(taskLedgerKey('still-queued'))).not.toBeNull();
  });

  it('requires system admin scope', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-scoped' }));

    const result = await runClear(engine, 'op-scoped', ['system:read']);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected authorization failure');
    expect(result.fault.code).toBe('Forbidden');
  });
});
