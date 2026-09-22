import { Engine } from '../../core/engine.ts';
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
} from '../../core/task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { AuthorizationScope } from '../authorization-scope.ts';
import type { DispatchResult } from '../operation-catalog.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import {
  getTaskDetailOperation,
  getTaskDetailOutputSchema,
  type GetTaskDetailOutput,
} from './get-task-detail.ts';

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true as const, value: undefined }),
    }),
  };
}

export const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  yield* emptyAsyncIterable();
  return input;
});

export function createEngine(storage: MemoryStorage): Engine {
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return engine;
}

export async function putLedgerRecord(
  storage: MemoryStorage,
  record: RemoteTaskRecord,
): Promise<void> {
  await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));
}

export function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
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

export function leasedFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
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

export function completingFixture(
  overrides: Partial<RemoteTaskCompleting> = {},
): RemoteTaskCompleting {
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

export function cancellingFixture(
  overrides: Partial<RemoteTaskCancelling> = {},
): RemoteTaskCancelling {
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
    cancellationDeadline: 33_000,
    ...overrides,
  };
}

export function terminalResolvedFixture(
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

export function terminalCancelledFixture(
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

export function terminalRetryExhaustedFixture(
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

export function deadLetteredFixture(
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

export function runGetTaskDetail(
  engine: Engine,
  operationId: string,
  scopes: ReadonlyArray<AuthorizationScope> = ['system:read'],
): Promise<DispatchResult<GetTaskDetailOutput>> {
  const operationRegistry = createOperationRegistry([getTaskDetailOperation]);
  return executeOperation(
    'weft.tasks.get',
    { operationId },
    {
      principal: principalFromApiKey({ subject: 'operator', scopes }),
      engine,
      transport: 'jsonRpcStdio',
      registry: operationRegistry,
    },
  ).then((result) => {
    if (!result.ok) return result;
    const parsed = getTaskDetailOutputSchema.safeParse(result.value);
    if (!parsed.success) throw new Error('getTaskDetail output failed its declared schema');
    return { ok: true, value: parsed.data };
  });
}
