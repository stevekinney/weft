import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from '../../worker/registry-fixtures.test-support.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { TaskQueue } from '../task-queue.ts';
import {
  createEngine,
  deadLetteredFixture,
  diagnosticsValue,
  leasedFixture,
  putLedgerRecord,
  queuedFixture,
  runDiagnostics,
  terminalFixture,
} from './get-task-diagnostics.test-support.ts';

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
    const diagnostics = diagnosticsValue(result.value);

    expect(diagnostics.summary).toEqual({
      stuckQueued: 1,
      staleInflight: 1,
      retryStorms: 1,
      allWorkersAtCapacity: 1,
      deadLettered: 0,
      delayed: 0,
      unadoptedTerminal: 0,
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
    const diagnostics = diagnosticsValue(result.value);

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
    const diagnostics = diagnosticsValue(result.value);
    expect(diagnostics.items).toHaveLength(0);
    expect(diagnostics.summary).toEqual({
      stuckQueued: 0,
      staleInflight: 0,
      retryStorms: 0,
      allWorkersAtCapacity: 0,
      deadLettered: 0,
      delayed: 0,
      unadoptedTerminal: 0,
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
    const diagnostics = diagnosticsValue(result.value);
    expect(diagnostics.items).toHaveLength(0);
  });

  it('includes expected delayed tasks only when requested and uses a strict availability boundary', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await putLedgerRecord(
      storage,
      queuedFixture({
        operationId: 'delayed-future',
        workflowId: 'workflow-a',
        queue: 'payments',
        availableAt: 40_000,
        retryCount: 2,
        requeueCount: 1,
      }),
    );
    await putLedgerRecord(
      storage,
      queuedFixture({ operationId: 'available-now', availableAt: 10_000 }),
    );

    const omitted = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: { operationId: 'delayed-future' },
    });
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) throw new Error('expected diagnostics result');
    expect(diagnosticsValue(omitted.value).items).toEqual([]);

    const included = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: { includeExpectedDelayed: true },
    });
    expect(included.ok).toBe(true);
    if (!included.ok) throw new Error('expected diagnostics result');
    const diagnostics = diagnosticsValue(included.value);
    expect(diagnostics.summary.delayed).toBe(1);
    expect(diagnostics.items).toContainEqual({
      kind: 'delayed',
      state: 'queued',
      operationId: 'delayed-future',
      workflowId: 'workflow-a',
      queue: 'payments',
      retryCount: 2,
      requeueCount: 1,
      availableAt: 40_000,
      evidence: ['Task is delayed until 40000 on queue "payments"'],
    });
    expect(diagnostics.items.some((item) => item.operationId === 'available-now')).toBe(false);
  });
});
