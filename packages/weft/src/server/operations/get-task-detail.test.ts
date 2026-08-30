import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { AuthorizationScope } from '../authorization-scope.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry, REST_BINDINGS } from '../rest-bindings.ts';
import {
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskCancelling,
  type RemoteTaskCompleting,
  type RemoteTaskDeadLettered,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskRecord,
  type RemoteTaskTerminalCancelled,
  type RemoteTaskTerminalResolved,
  type RemoteTaskTerminalRetryExhausted,
} from '../task-ledger.ts';
import {
  getTaskDetailOperation,
  getTaskDetailOutputSchema,
  getTaskDetailRestBinding,
  type GetTaskDetailOutput,
} from './get-task-detail.ts';
import { systemReadAuthContext } from './operation-registry-test-helpers.test-support.ts';

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

async function putLedgerRecord(storage: MemoryStorage, record: RemoteTaskRecord): Promise<void> {
  await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));
}

function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
  return {
    recordVersion: 1,
    operationId: 'op-queued',
    workflowId: 'wf-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'billing',
    input: null,
    headers: { 'x-trace-id': 'trace-1', authorization: 'Bearer secret' },
    priority: 7,
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    generation: 0,
    state: 'queued',
    attempt: 1,
    availableAt: 1_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
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
    createdAt: 1_000,
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-session-1',
    attempt: 1,
    leaseDeadline: 60_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
    startedAt: 2_000,
    lastHeartbeatAt: 2_500,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function completingFixture(overrides: Partial<RemoteTaskCompleting> = {}): RemoteTaskCompleting {
  return {
    recordVersion: 1,
    operationId: 'op-completing',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    generation: 2,
    state: 'completing',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-session-1',
    attempt: 1,
    leaseDeadline: 60_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
    startedAt: 2_000,
    lastHeartbeatAt: 2_500,
    retryCount: 0,
    requeueCount: 0,
    pendingStatus: 'completed',
    pendingResultDigest: 'digest-abc',
    ...overrides,
  };
}

function cancellingFixture(overrides: Partial<RemoteTaskCancelling> = {}): RemoteTaskCancelling {
  return {
    recordVersion: 1,
    operationId: 'op-cancelling',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    generation: 2,
    state: 'cancelling',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-session-1',
    attempt: 1,
    leaseDeadline: 60_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
    startedAt: 2_000,
    lastHeartbeatAt: 2_500,
    retryCount: 0,
    requeueCount: 0,
    cancellationReason: 'operator requested',
    cancellationRequestedAt: 3_000,
    ...overrides,
  };
}

function terminalResolvedFixture(
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
    createdAt: 1_000,
    generation: 3,
    state: 'terminal',
    attempt: 1,
    resultDigest: 'digest-abc',
    terminalAt: 4_000,
    adopted: false,
    retentionGeneration: 0,
    disposition: 'resolved',
    attemptToken: 'attempt-token',
    status: 'completed',
    ...overrides,
  };
}

function terminalCancelledFixture(
  overrides: Partial<RemoteTaskTerminalCancelled> = {},
): RemoteTaskTerminalCancelled {
  return {
    recordVersion: 1,
    operationId: 'op-terminal-cancelled',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    generation: 3,
    state: 'terminal',
    attempt: 1,
    resultDigest: 'digest-cancelled',
    terminalAt: 4_000,
    adopted: false,
    retentionGeneration: 0,
    disposition: 'cancelled',
    cancellationReason: 'operator requested',
    ...overrides,
  };
}

function terminalRetryExhaustedFixture(
  overrides: Partial<RemoteTaskTerminalRetryExhausted> = {},
): RemoteTaskTerminalRetryExhausted {
  return {
    recordVersion: 1,
    operationId: 'op-terminal-exhausted',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    generation: 3,
    state: 'terminal',
    attempt: 3,
    resultDigest: 'digest-exhausted',
    terminalAt: 4_000,
    adopted: false,
    retentionGeneration: 0,
    disposition: 'retryExhausted',
    attemptToken: 'attempt-token',
    error: 'boom',
    ...overrides,
  };
}

function deadLetteredFixture(
  overrides: Partial<RemoteTaskDeadLettered> = {},
): RemoteTaskDeadLettered {
  return {
    recordVersion: 1,
    operationId: 'op-dead',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    generation: 4,
    state: 'deadLettered',
    attemptToken: 'attempt-token',
    attempt: 2,
    retryCount: 1,
    requeueCount: 1,
    pendingStatus: 'completed',
    pendingResultDigest: 'digest-pending',
    value: { secret: 'do not leak' },
    deadLetteredAt: 5_000,
    persistenceFailureReason: 'storage exhausted',
    ...overrides,
  };
}

function runGetTaskDetail(
  engine: Engine,
  operationId: string,
  scopes: ReadonlyArray<AuthorizationScope> = ['system:read'],
) {
  const operationRegistry = createOperationRegistry([getTaskDetailOperation]);
  return executeOperation<GetTaskDetailOutput>(
    'weft.tasks.get',
    { operationId },
    {
      principal: principalFromApiKey({ subject: 'operator', scopes }),
      engine,
      transport: 'jsonRpcStdio',
      registry: operationRegistry,
    },
  );
}

describe('weft.tasks.get', () => {
  it('faults NotFound for an operationId that was never dispatched', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);

    const result = await runGetTaskDetail(engine, 'never-dispatched');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected NotFound fault');
    expect(result.fault.code).toBe('NotFound');
  });

  it('faults EngineFailure, not NotFound, when the ledger key exists but does not decode', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await storage.put(taskLedgerKey('corrupt-op'), encode({ invalid: true }));

    const result = await runGetTaskDetail(engine, 'corrupt-op');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected EngineFailure fault');
    expect(result.fault.code).toBe('EngineFailure');
  });

  it('faults EngineFailure when the decoded record has a different operationId than requested', async () => {
    // Simulates a storage-integrity problem: operation B's record living
    // under operation A's key (manual repair gone wrong, import, or
    // corruption). Must not silently hand back B's data for an A lookup.
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await storage.put(
      taskLedgerKey('op-a'),
      encodeRemoteTaskRecord(queuedFixture({ operationId: 'op-b' })),
    );

    const result = await runGetTaskDetail(engine, 'op-a');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected EngineFailure fault');
    expect(result.fault.code).toBe('EngineFailure');
  });

  it('rejects an operationId larger than the ledger byte limit with InvalidParams, not a storage lookup', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const oversized = 'x'.repeat(600);

    const result = await runGetTaskDetail(engine, oversized);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected InvalidParams fault');
    expect(result.fault.code).toBe('InvalidParams');
  });

  it('projects only the declared retryPolicy and executionRequirement fields, tolerating additive properties the ledger itself does not reject', async () => {
    // isValidRetryPolicy/isValidExecutionRequirement only check known
    // fields; a same-process dispatch caller can attach extra properties
    // that the ledger happily stores. Returning that object through a
    // .strict() schema verbatim would EngineFailure an otherwise valid,
    // running task.
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(
      storage,
      queuedFixture({
        retryPolicy: {
          maxAttempts: 3,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
          // @ts-expect-error deliberately additive field the ledger's own validator ignores
          unexpectedFutureField: 'should be stripped',
        },
        executionRequirement: {
          deploymentName: 'billing-service',
          // @ts-expect-error deliberately additive field the ledger's own validator ignores
          unexpectedFutureField: 'should also be stripped',
        },
      }),
    );

    const result = await runGetTaskDetail(engine, 'op-queued');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success, not EngineFailure from strict validation');
    expect(result.value).toMatchObject({
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
      executionRequirement: { deploymentName: 'billing-service' },
    });
    expect(JSON.stringify(result.value)).not.toContain('unexpectedFutureField');
  });

  it('reports workflowExecutionToken when the task is workflow-bound', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, queuedFixture({ workflowExecutionToken: 'exec-token-abc' }));

    const result = await runGetTaskDetail(engine, 'op-queued');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toMatchObject({ workflowExecutionToken: 'exec-token-abc' });
  });

  it('reports a queued task with envelope fields, header keys only, and no header values', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, queuedFixture());

    const result = await runGetTaskDetail(engine, 'op-queued');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({
      operationId: 'op-queued',
      workflowId: 'wf-1',
      workflowType: 'test',
      activityName: 'charge',
      queue: 'billing',
      priority: 7,
      headerKeys: ['x-trace-id', 'authorization'],
      visibilityTimeoutMilliseconds: 30_000,
      createdAt: 1_000,
      attempt: 1,
      state: 'queued',
      retryCount: 0,
      requeueCount: 0,
      availableAt: 1_000,
      firstQueuedAt: 1_000,
      lastQueuedAt: 1_000,
    });
    expect(JSON.stringify(result.value)).not.toContain('Bearer secret');
  });

  it('reports the retained retry and routing envelope when configured', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(
      storage,
      queuedFixture({
        retryPolicy: {
          maxAttempts: 5,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
        scheduleToCloseDeadline: 999_999,
        executionRequirement: { deploymentName: 'billing-service', buildId: 'build-42' },
        fairShareKey: 'tenant-1',
        stickyWorkflowId: 'wf-1',
      }),
    );

    const result = await runGetTaskDetail(engine, 'op-queued');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toMatchObject({
      retryPolicy: {
        maxAttempts: 5,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
      scheduleToCloseDeadline: 999_999,
      executionRequirement: { deploymentName: 'billing-service', buildId: 'build-42' },
      fairShareKey: 'tenant-1',
      stickyWorkflowId: 'wf-1',
    });
  });

  it('omits the retry and routing envelope fields entirely when not configured', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, leasedFixture());

    const result = await runGetTaskDetail(engine, 'op-leased');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).not.toHaveProperty('retryPolicy');
    expect(result.value).not.toHaveProperty('scheduleToCloseDeadline');
    expect(result.value).not.toHaveProperty('executionRequirement');
    expect(result.value).not.toHaveProperty('fairShareKey');
    expect(result.value).not.toHaveProperty('stickyWorkflowId');
  });

  it('reports a leased task without attemptToken, workerSessionId, or executionIdentity', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, leasedFixture());

    const result = await runGetTaskDetail(engine, 'op-leased');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.state).toBe('leased');
    expect(result.value).not.toHaveProperty('attemptToken');
    expect(result.value).not.toHaveProperty('workerSessionId');
    expect(result.value).not.toHaveProperty('executionIdentity');
    if (result.value.state === 'leased') {
      expect(result.value.leaseDeadline).toBe(60_000);
      expect(result.value.lastHeartbeatAt).toBe(2_500);
    }
  });

  it('reports a completing task with pendingStatus and resultDigest, not the raw result value', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, completingFixture());

    const result = await runGetTaskDetail(engine, 'op-completing');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'completing') throw new Error('expected completing state');
    expect(result.value.pendingStatus).toBe('completed');
    expect(result.value.resultDigest).toBe('digest-abc');
  });

  it('reports a cancelling task with cancellation reason and requested-at timestamp', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, cancellingFixture());

    const result = await runGetTaskDetail(engine, 'op-cancelling');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'cancelling') throw new Error('expected cancelling state');
    expect(result.value.cancellationReason).toBe('operator requested');
    expect(result.value.cancellationRequestedAt).toBe(3_000);
  });

  it('reports a resolved terminal task with disposition, resultDigest, adoption, and resultStatus', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, terminalResolvedFixture({ adopted: true, adoptedAt: 4_500 }));

    const result = await runGetTaskDetail(engine, 'op-terminal');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'terminal') throw new Error('expected terminal state');
    if (result.value.disposition !== 'resolved') throw new Error('expected resolved disposition');
    expect(result.value.resultDigest).toBe('digest-abc');
    expect(result.value.adopted).toBe(true);
    expect(result.value.adoptedAt).toBe(4_500);
    expect(result.value.resultStatus).toBe('completed');
    expect(result.value).not.toHaveProperty('cancellationReason');
  });

  it('reports a cancelled terminal task with cancellationReason, not resultStatus, and never leaks the synthetic resultDigest that embeds attemptToken', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    // task-ledger-transitions-cancellation.ts builds a leased-origin
    // cancellation's resultDigest as `cancelled:${operationId}:${attemptToken}`
    // — this fixture mirrors that exact shape to prove the token doesn't leak.
    await putLedgerRecord(
      storage,
      terminalCancelledFixture({
        resultDigest: 'cancelled:op-terminal-cancelled:super-secret-attempt-token',
      }),
    );

    const result = await runGetTaskDetail(engine, 'op-terminal-cancelled');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'terminal') throw new Error('expected terminal state');
    if (result.value.disposition !== 'cancelled') throw new Error('expected cancelled disposition');
    expect(result.value.cancellationReason).toBe('operator requested');
    expect(result.value).not.toHaveProperty('resultStatus');
    expect(result.value).not.toHaveProperty('resultDigest');
    expect(JSON.stringify(result.value)).not.toContain('super-secret-attempt-token');
  });

  it('reports a retry-exhausted terminal task with its error, no retryCount/requeueCount, and never leaks the synthetic resultDigest that embeds attemptToken', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    // task-ledger-transitions.ts builds a retry-exhausted resultDigest as
    // `retry-exhausted:${operationId}:${attemptToken}` — same proof as above.
    await putLedgerRecord(
      storage,
      terminalRetryExhaustedFixture({
        resultDigest: 'retry-exhausted:op-terminal-exhausted:super-secret-attempt-token',
      }),
    );

    const result = await runGetTaskDetail(engine, 'op-terminal-exhausted');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'terminal') throw new Error('expected terminal state');
    if (result.value.disposition !== 'retryExhausted')
      throw new Error('expected retryExhausted disposition');
    expect(result.value.error).toBe('boom');
    expect(result.value).not.toHaveProperty('retryCount');
    expect(result.value).not.toHaveProperty('requeueCount');
    expect(result.value).not.toHaveProperty('resultDigest');
    expect(JSON.stringify(result.value)).not.toContain('super-secret-attempt-token');
  });

  it('reports a dead-lettered task with pendingStatus, resultDigest, and reason, never the raw pending value', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture());

    const result = await runGetTaskDetail(engine, 'op-dead');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'deadLettered') throw new Error('expected deadLettered state');
    expect(result.value.pendingStatus).toBe('completed');
    expect(result.value.resultDigest).toBe('digest-pending');
    expect(result.value.persistenceFailureReason).toBe('storage exhausted');
    expect(JSON.stringify(result.value)).not.toContain('do not leak');
  });

  it('requires system:read scope', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, queuedFixture());

    const result = await executeOperation(
      'weft.tasks.get',
      { operationId: 'op-queued' },
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([getTaskDetailOperation]),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected authorization failure');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('resolves GET /v1/tasks/detail/:operationId through the real REST router', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, queuedFixture());

    const response = await handleRequest(
      new Request('http://localhost/v1/tasks/detail/op-queued', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getTaskDetailOperation]),
        restBindings: [getTaskDetailRestBinding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as GetTaskDetailOutput;
    expect(body.state).toBe('queued');
    expect(body.operationId).toBe('op-queued');
  });

  it('returns 404 through the real REST router for an unknown operationId', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);

    const response = await handleRequest(
      new Request('http://localhost/v1/tasks/detail/never-dispatched', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getTaskDetailOperation]),
        restBindings: [getTaskDetailRestBinding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(404);
  });

  it('a task whose operationId equals an existing literal /v1/tasks/... sibling ("diagnostics") is reachable through the detail namespace', async () => {
    // Regression guard for the exact case a bare GET /v1/tasks/:operationId
    // would have broken: an operationId equal to a sibling literal path
    // segment. /detail/ structurally cannot collide (different segment
    // count from every other /v1/tasks/... binding), so this must resolve
    // to the task, not to weft.tasks.diagnostics.
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await putLedgerRecord(storage, queuedFixture({ operationId: 'diagnostics' }));

    const response = await handleRequest(
      new Request('http://localhost/v1/tasks/detail/diagnostics', { method: 'GET' }),
      engine,
      {
        operationRegistry: createLiveOperationRegistry(),
        restBindings: REST_BINDINGS,
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as GetTaskDetailOutput;
    expect(body.operationId).toBe('diagnostics');
    expect(body.state).toBe('queued');
  });

  it('GET /v1/tasks/diagnostics still resolves to weft.tasks.diagnostics through the full static registry', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);

    const response = await handleRequest(
      new Request('http://localhost/v1/tasks/diagnostics', { method: 'GET' }),
      engine,
      {
        operationRegistry: createLiveOperationRegistry(),
        restBindings: REST_BINDINGS,
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown; summary: unknown };
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('summary');
  });
});

describe('getTaskDetailOutputSchema', () => {
  const terminalBase = {
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    headerKeys: [],
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    attempt: 1,
    state: 'terminal' as const,
    terminalAt: 4_000,
    adopted: false,
  };

  it('accepts a resolved terminal record with resultDigest and resultStatus', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...terminalBase,
      disposition: 'resolved',
      resultDigest: 'digest-abc',
      resultStatus: 'completed',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a cancelled terminal record with no cancellationReason — the durable union requires one', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...terminalBase,
      disposition: 'cancelled',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a retryExhausted terminal record with no error — the durable union requires one', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...terminalBase,
      disposition: 'retryExhausted',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a cancelled terminal record carrying resultStatus or resultDigest — those belong only to resolved', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...terminalBase,
      disposition: 'cancelled',
      cancellationReason: 'operator requested',
      resultStatus: 'completed',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a terminal record with no retryCount/requeueCount — RemoteTaskTerminal never carries attempt-count history', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...terminalBase,
      disposition: 'resolved',
      resultDigest: 'digest-abc',
      resultStatus: 'completed',
    });
    expect(result.success).toBe(true);
  });

  const nonterminalBase = {
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    headerKeys: [],
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    attempt: 1,
    state: 'queued' as const,
    availableAt: 1_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
  };

  it('rejects a queued record missing retryCount/requeueCount — RemoteTaskAttemptFields guarantees both on every nonterminal state', () => {
    const result = getTaskDetailOutputSchema.safeParse(nonterminalBase);
    expect(result.success).toBe(false);
  });

  it('accepts a queued record with retryCount/requeueCount present', () => {
    const result = getTaskDetailOutputSchema.safeParse({
      ...nonterminalBase,
      retryCount: 0,
      requeueCount: 0,
    });
    expect(result.success).toBe(true);
  });
});
