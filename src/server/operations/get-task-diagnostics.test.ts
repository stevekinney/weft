import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { KEYS, type ScanOptions } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from '../../worker/registry-fixtures.test-support.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import type { AuthorizationScope } from '../authorization-scope.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import { TaskQueue } from '../task-queue.ts';
import {
  type DeadLetteredTaskRecord,
  type InflightRecord,
  type QueuedRecord,
  type ResolvedRecord,
} from '../task-state.ts';
import {
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

class ScanCountingStorage extends MemoryStorage {
  readonly scannedEntriesByPrefix = new Map<string, number>();

  override async *scan(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<[string, Uint8Array]> {
    for await (const entry of super.scan(prefix, options)) {
      this.scannedEntriesByPrefix.set(prefix, (this.scannedEntriesByPrefix.get(prefix) ?? 0) + 1);
      yield entry;
    }
  }

  scannedEntryCount(prefix: string): number {
    return this.scannedEntriesByPrefix.get(prefix) ?? 0;
  }
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

async function putResolvedRecord(storage: MemoryStorage, record: ResolvedRecord): Promise<void> {
  const encodedRecord = encode(record);
  await storage.put(KEYS.operationResolved(record.operationId), encodedRecord);
  await storage.put(
    KEYS.operationResolvedByTime(record.resolvedAt, record.operationId),
    encodedRecord,
  );
}

describe('weft.tasks.diagnostics', () => {
  it('loads a resolved task directly by operation id', async () => {
    const storage = new ScanCountingStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await putResolvedRecord(storage, {
      operationId: 'resolved-by-id',
      workflowId: 'workflow-history',
      activityName: 'charge',
      queue: 'default',
      status: 'failed',
      resolvedAt: 9_000,
      retryCount: 3,
      requeueCount: 3,
      resolutionReason: 'max-attempts-exceeded',
    });

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: { operationId: 'resolved-by-id', retryStormMinimumAttempts: 3 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;
    expect(diagnostics.items.map((item) => item.operationId)).toEqual(['resolved-by-id']);
    expect(storage.scannedEntryCount(KEYS.operationResolvedByTimePrefix())).toBe(0);
  });

  it('identifies stuck queued tasks, stale inflight tasks, retry storms, and capacity saturation', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    const stuckQueued: QueuedRecord = {
      operationId: 'queued-stuck',
      workflowId: 'workflow-a',
      activityName: 'charge',
      input: null,
      queue: 'payments',
      attempt: 1,
      visibilityTimeout: 30_000,
      queuedAt: 1_000,
      firstQueuedAt: 1_000,
      lastQueuedAt: 1_000,
      retryCount: 0,
      requeueCount: 0,
    };
    const staleInflight: InflightRecord = {
      operationId: 'inflight-stale',
      workflowId: 'workflow-a',
      activityName: 'charge',
      input: null,
      queue: 'payments',
      workerId: 'worker-stale',
      deadline: 20_000,
      attempt: 2,
      visibilityTimeout: 30_000,
      attemptToken: 'attempt-token',
      firstQueuedAt: 1_000,
      lastQueuedAt: 1_000,
      lastDispatchedAt: 2_000,
      startedAt: 2_100,
      lastHeartbeatAt: 3_000,
      retryCount: 1,
      requeueCount: 1,
    };
    const retryStorm: ResolvedRecord = {
      operationId: 'retry-storm',
      workflowId: 'workflow-a',
      activityName: 'ship',
      queue: 'payments',
      status: 'failed',
      resolvedAt: 9_000,
      firstQueuedAt: 1_000,
      lastQueuedAt: 8_000,
      lastDispatchedAt: 8_500,
      startedAt: 8_600,
      completedAt: 9_000,
      retryCount: 5,
      requeueCount: 5,
      resolutionReason: 'max-attempts-exceeded',
    };

    await storage.put(KEYS.operationQueued(stuckQueued.operationId), encode(stuckQueued));
    await storage.put(KEYS.operationInflight(staleInflight.operationId), encode(staleInflight));
    await putResolvedRecord(storage, retryStorm);

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
    expect(diagnostics.items.map((item) => item.kind)).toEqual([
      'stuck-queued',
      'stale-inflight',
      'retry-storm',
      'all-workers-at-capacity',
    ]);
    expect(diagnostics.items[0]).toMatchObject({
      operationId: 'queued-stuck',
      workflowId: 'workflow-a',
      queue: 'payments',
      queueLatencyMs: 9_000,
    });
    expect(diagnostics.items[1]).toMatchObject({
      operationId: 'inflight-stale',
      workerId: 'worker-stale',
      heartbeatAgeMs: 7_000,
    });
  });

  it('lists task-result dead letters without also reporting the guarded inflight task', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    const inflightRecord: InflightRecord = {
      operationId: 'dead-lettered-operation',
      workflowId: 'workflow-dead-letter',
      activityName: 'charge',
      input: null,
      queue: 'payments',
      workerId: 'worker-dead-letter',
      deadline: 2_000,
      attempt: 2,
      visibilityTimeout: 30_000,
      attemptToken: 'attempt-token',
      firstQueuedAt: 1_000,
      lastQueuedAt: 1_500,
      lastDispatchedAt: 2_000,
      startedAt: 2_100,
      lastHeartbeatAt: 3_000,
      retryCount: 1,
      requeueCount: 1,
      lastRequeueReason: 'visibility-timeout',
    };
    const deadLetterRecord: DeadLetteredTaskRecord = {
      operationId: inflightRecord.operationId,
      workflowId: inflightRecord.workflowId,
      activityName: inflightRecord.activityName,
      queue: inflightRecord.queue,
      workerId: inflightRecord.workerId,
      attempt: inflightRecord.attempt,
      visibilityTimeout: inflightRecord.visibilityTimeout,
      retryCount: inflightRecord.retryCount,
      requeueCount: inflightRecord.requeueCount,
      lastRequeueReason: inflightRecord.lastRequeueReason,
      reason: 'result-resolution-storage-exhausted',
      deadLetteredAt: 9_000,
      errorMessage: 'result-resolution-storage-exhausted',
      retryAttempts: 2,
      status: 'completed',
    };

    await storage.put(KEYS.operationInflight(inflightRecord.operationId), encode(inflightRecord));
    await storage.put(
      KEYS.operationDeadLetter(deadLetterRecord.operationId),
      encode(deadLetterRecord),
    );

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: {
        operationId: inflightRecord.operationId,
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
      operationId: inflightRecord.operationId,
      workflowId: inflightRecord.workflowId,
      activityName: inflightRecord.activityName,
      queue: inflightRecord.queue,
      workerId: inflightRecord.workerId,
      deadLetteredAt: 9_000,
      deadLetterReason: 'result-resolution-storage-exhausted',
      storageError: 'result-resolution-storage-exhausted',
      retryAttempts: 2,
    });
  });

  it('bounds diagnostic result items while retaining summary counts', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    for (let index = 0; index < 3; index += 1) {
      const record: QueuedRecord = {
        operationId: `queued-${index}`,
        activityName: 'charge',
        input: null,
        queue: 'default',
        attempt: 1,
        visibilityTimeout: 30_000,
        queuedAt: 1_000 + index,
        firstQueuedAt: 1_000 + index,
        lastQueuedAt: 1_000 + index,
        retryCount: 0,
        requeueCount: 0,
      };
      await storage.put(KEYS.operationQueued(record.operationId), encode(record));
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

  it('bounds resolved history scans independently from the result item limit', async () => {
    const storage = new ScanCountingStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    for (let index = 0; index < 1_005; index += 1) {
      const record: ResolvedRecord = {
        operationId: `resolved-retry-${String(index).padStart(4, '0')}`,
        workflowId: 'workflow-history',
        activityName: 'charge',
        queue: 'default',
        status: 'failed',
        resolvedAt: 9_000 + index,
        retryCount: 3,
        requeueCount: 3,
        resolutionReason: 'max-attempts-exceeded',
      };
      await putResolvedRecord(storage, record);
    }

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: {
        retryStormMinimumAttempts: 3,
        limit: 2,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;
    expect(storage.scannedEntryCount(KEYS.operationResolvedByTimePrefix())).toBe(1_000);
    expect(diagnostics.summary.retryStorms).toBe(1_000);
    expect(diagnostics.items).toHaveLength(2);
  });

  it('orders resolved history by resolvedAt rather than operation id', async () => {
    const storage = new ScanCountingStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await putResolvedRecord(storage, {
      operationId: 'z-old-retry',
      workflowId: 'workflow-history',
      activityName: 'charge',
      queue: 'default',
      status: 'failed',
      resolvedAt: 1_000,
      retryCount: 3,
      requeueCount: 3,
      resolutionReason: 'max-attempts-exceeded',
    });
    await putResolvedRecord(storage, {
      operationId: 'a-new-retry',
      workflowId: 'workflow-history',
      activityName: 'charge',
      queue: 'default',
      status: 'failed',
      resolvedAt: 9_000,
      retryCount: 3,
      requeueCount: 3,
      resolutionReason: 'max-attempts-exceeded',
    });

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: {
        retryStormMinimumAttempts: 3,
        limit: 1,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;
    expect(diagnostics.summary.retryStorms).toBe(2);
    expect(diagnostics.items).toHaveLength(1);
    expect(diagnostics.items[0]?.operationId).toBe('a-new-retry');
  });

  it('counts filtered resolved retry storms beyond the returned item limit', async () => {
    const storage = new ScanCountingStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    for (let index = 0; index < 3; index += 1) {
      const record: ResolvedRecord = {
        operationId: `z-unrelated-${index}`,
        workflowId: 'other-workflow',
        activityName: 'charge',
        queue: 'default',
        status: 'failed',
        resolvedAt: 9_000 + index,
        retryCount: 3,
        requeueCount: 3,
        resolutionReason: 'max-attempts-exceeded',
      };
      await putResolvedRecord(storage, record);
    }

    for (let index = 0; index < 2; index += 1) {
      const record: ResolvedRecord = {
        operationId: `a-matching-${index}`,
        workflowId: 'target-workflow',
        activityName: 'charge',
        queue: 'default',
        status: 'failed',
        resolvedAt: 8_000 + index,
        retryCount: 3,
        requeueCount: 3,
        resolutionReason: 'max-attempts-exceeded',
      };
      await putResolvedRecord(storage, record);
    }

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: {
        workflowId: 'target-workflow',
        retryStormMinimumAttempts: 3,
        limit: 2,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;
    expect(storage.scannedEntryCount(KEYS.operationResolvedByTimePrefix())).toBe(5);
    expect(diagnostics.summary.retryStorms).toBe(2);
    expect(diagnostics.items.map((item) => item.operationId)).toEqual([
      'a-matching-1',
      'a-matching-0',
    ]);
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
