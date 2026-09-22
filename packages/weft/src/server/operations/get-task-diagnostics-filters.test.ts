import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromJwtClaims } from '../principal.ts';
import { TaskQueue } from '../task-queue.ts';
import {
  createEngine,
  diagnosticsValue,
  putLedgerRecord,
  queuedFixture,
  runDiagnostics,
  terminalFixture,
  ThrowingScanStorage,
} from './get-task-diagnostics.test-support.ts';
import { createGetTaskDiagnosticsOperation } from './get-task-diagnostics.ts';

describe('weft.tasks.diagnostics filters', () => {
  it('reports only unadopted terminal tasks at or beyond the configured age', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await putLedgerRecord(
      storage,
      terminalFixture({
        operationId: 'unadopted-old',
        workflowId: 'workflow-a',
        queue: 'payments',
        terminalAt: 9_000,
      }),
    );
    await putLedgerRecord(
      storage,
      terminalFixture({ operationId: 'unadopted-young', terminalAt: 9_001 }),
    );
    await putLedgerRecord(
      storage,
      terminalFixture({ operationId: 'already-adopted', terminalAt: 0, adopted: true }),
    );

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: { unadoptedAfterMs: 1_000 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = diagnosticsValue(result.value);
    expect(diagnostics.summary.unadoptedTerminal).toBe(1);
    expect(diagnostics.items).toContainEqual({
      kind: 'unadopted-terminal',
      state: 'resolved',
      operationId: 'unadopted-old',
      workflowId: 'workflow-a',
      queue: 'payments',
      terminalAt: 9_000,
      adopted: false,
      evidence: ['Terminal task has remained unadopted for 1000ms'],
    });
  });

  it('combines record filters with AND and counts new kinds before truncation', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await putLedgerRecord(
      storage,
      queuedFixture({
        operationId: 'matching-delayed',
        workflowId: 'workflow-a',
        queue: 'payments',
        availableAt: 20_000,
      }),
    );
    await putLedgerRecord(
      storage,
      terminalFixture({
        operationId: 'matching-terminal',
        workflowId: 'workflow-a',
        queue: 'payments',
        terminalAt: 0,
      }),
    );
    await putLedgerRecord(
      storage,
      queuedFixture({
        operationId: 'wrong-queue',
        workflowId: 'workflow-a',
        queue: 'shipping',
        availableAt: 20_000,
      }),
    );

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: {
        workflowId: 'workflow-a',
        queue: 'payments',
        includeExpectedDelayed: true,
        unadoptedAfterMs: 1_000,
        limit: 1,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = diagnosticsValue(result.value);
    expect(diagnostics.items).toHaveLength(1);
    expect(diagnostics.summary.delayed).toBe(1);
    expect(diagnostics.summary.unadoptedTerminal).toBe(1);

    const operationFiltered = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: {
        operationId: 'matching-delayed',
        workflowId: 'workflow-a',
        queue: 'payments',
        includeExpectedDelayed: true,
      },
    });
    expect(operationFiltered.ok).toBe(true);
    if (!operationFiltered.ok) throw new Error('expected diagnostics result');
    expect(diagnosticsValue(operationFiltered.value).items).toHaveLength(1);
  });

  it('excludes malformed ledger rows from items and summary', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await storage.put(taskLedgerKey('malformed'), encode({ state: 'queued' }));

    const result = await runDiagnostics({
      engine,
      registry: new WorkerRegistry(),
      taskQueue: new TaskQueue(),
      input: { includeExpectedDelayed: true, unadoptedAfterMs: 0 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = diagnosticsValue(result.value);
    expect(diagnostics.items).toEqual([]);
    expect(diagnostics.summary.delayed).toBe(0);
    expect(diagnostics.summary.unadoptedTerminal).toBe(0);
  });

  it('propagates storage scan failures through the existing server fault path', async () => {
    const engine = createEngine(new ThrowingScanStorage());

    const result = await runDiagnostics({
      engine,
      registry: new WorkerRegistry(),
      taskQueue: new TaskQueue(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected server fault');
    expect(result.fault.code).toBe('EngineFailure');
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
    const diagnostics = diagnosticsValue(result.value);
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
