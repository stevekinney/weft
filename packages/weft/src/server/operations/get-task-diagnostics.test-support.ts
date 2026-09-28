import { Engine } from '../../core/engine.ts';
import { encodeTaskAttemptRecord, taskAttemptKey } from '../../core/task-ledger/task-attempt.ts';
import {
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskDeadLettered,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskTerminalResolved,
} from '../../core/task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sha256HexSync } from '../../worker/manifest/content-digest.ts';
import type { WorkerExecutionIdentity } from '../../worker/manifest/types.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import type { AuthorizationScope } from '../authorization-scope.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { TaskQueue } from '../task-queue.ts';
import {
  createGetTaskDiagnosticsOperation,
  getTaskDiagnosticsOperation,
  type GetTaskDiagnosticsOutput,
} from './get-task-diagnostics.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  yield* [];
  return input;
});

export function createEngine(storage: MemoryStorage): Engine {
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return engine;
}

export class ThrowingScanStorage extends MemoryStorage {
  override scan(): AsyncIterable<[string, Uint8Array]> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<[string, Uint8Array]> => ({
        next: async (): Promise<IteratorResult<[string, Uint8Array]>> => {
          throw new Error('diagnostics scan failed');
        },
      }),
    };
  }
}

export function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
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

export function terminalFixture(
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

export function deadLetteredFixture(
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

export async function putLedgerRecord(
  storage: MemoryStorage,
  record: RemoteTaskQueued | RemoteTaskLeased | RemoteTaskTerminalResolved | RemoteTaskDeadLettered,
): Promise<void> {
  await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));
}

export function executionIdentityFixture(
  overrides: Partial<WorkerExecutionIdentity> = {},
): WorkerExecutionIdentity {
  return {
    workerId: 'w-1',
    manifestDigest: 'manifest-digest',
    protocolVersion: 1,
    sdkVersion: '1.0.0',
    runtimeName: 'bun',
    runtimeVersion: '1.0.0',
    deploymentName: 'checkout',
    buildId: 'b1',
    artifactDigest: 'sha256:b1',
    workflowType: 'test',
    workflowRevision: 'rev-1',
    activityName: 'charge',
    activityContractHash: 'contract-hash',
    ...overrides,
  };
}

/** Writes a leased ledger record together with its current attempt's `TaskAttemptRecord`, for COR-198's identity-filter tests. */
export async function putLeasedWithAttempt(
  storage: MemoryStorage,
  leased: RemoteTaskLeased,
  executionIdentity?: WorkerExecutionIdentity,
): Promise<void> {
  await putLedgerRecord(storage, leased);
  const digest = sha256HexSync(leased.attemptToken);
  await storage.put(
    taskAttemptKey(leased.operationId, digest),
    encodeTaskAttemptRecord({
      recordVersion: 1,
      operationId: leased.operationId,
      attempt: leased.attempt,
      attemptTokenDigest: digest,
      workerSessionId: leased.workerSessionId,
      claimedAt: leased.startedAt,
      disposition: 'leased',
      dispositionAt: leased.startedAt,
      ...(executionIdentity !== undefined ? { executionIdentity } : {}),
    }),
  );
}

export async function runDiagnostics({
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

export function diagnosticsValue(value: unknown): GetTaskDiagnosticsOutput {
  const parsed = getTaskDiagnosticsOperation.outputSchema.safeParse(value);
  if (!parsed.success) throw new Error('expected validated diagnostics output');
  return parsed.data;
}
