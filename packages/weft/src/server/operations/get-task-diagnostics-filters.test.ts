import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { encodeTaskAttemptRecord, taskAttemptKey } from '../../core/task-ledger/task-attempt.ts';
import { taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sha256HexSync } from '../../worker/manifest/content-digest.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromJwtClaims } from '../principal.ts';
import { TaskQueue } from '../task-queue.ts';
import {
  createEngine,
  diagnosticsValue,
  executionIdentityFixture,
  leasedFixture,
  putLeasedWithAttempt,
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

  describe('execution-identity filters (COR-198)', () => {
    it('filters stale-inflight diagnostics by buildId, sourced from the attempt record rather than the ledger', async () => {
      const storage = new MemoryStorage();
      const engine = createEngine(storage);
      const registry = new WorkerRegistry();
      const taskQueue = new TaskQueue();

      await putLeasedWithAttempt(
        storage,
        leasedFixture({ operationId: 'op-build-a', attemptToken: 'attempt-a', queue: 'default' }),
        executionIdentityFixture({ buildId: 'b1' }),
      );
      await putLeasedWithAttempt(
        storage,
        leasedFixture({ operationId: 'op-build-b', attemptToken: 'attempt-b', queue: 'default' }),
        executionIdentityFixture({ buildId: 'b2' }),
      );

      const result = await runDiagnostics({
        engine,
        registry,
        taskQueue,
        input: { staleHeartbeatAfterMs: 0, buildId: 'b1' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected diagnostics result');
      const diagnostics = diagnosticsValue(result.value);
      expect(diagnostics.items.map((item) => item.operationId)).toEqual(['op-build-a']);
      expect(diagnostics.summary.staleInflight).toBe(1);
    });

    it('combines deploymentName, artifactDigest, and workflowRevision filters with AND', async () => {
      const storage = new MemoryStorage();
      const engine = createEngine(storage);
      const registry = new WorkerRegistry();
      const taskQueue = new TaskQueue();

      await putLeasedWithAttempt(
        storage,
        leasedFixture({ operationId: 'op-match', attemptToken: 'attempt-match', queue: 'default' }),
        executionIdentityFixture({
          deploymentName: 'checkout',
          artifactDigest: 'sha256:match',
          workflowRevision: 'rev-2',
        }),
      );
      await putLeasedWithAttempt(
        storage,
        leasedFixture({
          operationId: 'op-wrong-revision',
          attemptToken: 'attempt-wrong-revision',
          queue: 'default',
        }),
        executionIdentityFixture({
          deploymentName: 'checkout',
          artifactDigest: 'sha256:match',
          workflowRevision: 'rev-1',
        }),
      );

      const result = await runDiagnostics({
        engine,
        registry,
        taskQueue,
        input: {
          staleHeartbeatAfterMs: 0,
          deploymentName: 'checkout',
          artifactDigest: 'sha256:match',
          workflowRevision: 'rev-2',
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected diagnostics result');
      expect(diagnosticsValue(result.value).items.map((item) => item.operationId)).toEqual([
        'op-match',
      ]);
    });

    it('rejects on a mismatching deploymentName or artifactDigest, independent of any other field matching', async () => {
      const storage = new MemoryStorage();
      const engine = createEngine(storage);
      const registry = new WorkerRegistry();
      const taskQueue = new TaskQueue();

      await putLeasedWithAttempt(
        storage,
        leasedFixture({
          operationId: 'op-deployment-mismatch',
          attemptToken: 'attempt-deployment-mismatch',
          queue: 'default',
        }),
        executionIdentityFixture({
          deploymentName: 'other-service',
          artifactDigest: 'sha256:match',
        }),
      );
      await putLeasedWithAttempt(
        storage,
        leasedFixture({
          operationId: 'op-artifact-mismatch',
          attemptToken: 'attempt-artifact-mismatch',
          queue: 'default',
        }),
        executionIdentityFixture({ deploymentName: 'checkout', artifactDigest: 'sha256:other' }),
      );

      const deploymentResult = await runDiagnostics({
        engine,
        registry,
        taskQueue,
        input: { staleHeartbeatAfterMs: 0, deploymentName: 'checkout' },
      });
      expect(deploymentResult.ok).toBe(true);
      if (!deploymentResult.ok) throw new Error('expected diagnostics result');
      expect(
        diagnosticsValue(deploymentResult.value).items.map((item) => item.operationId),
      ).toEqual(['op-artifact-mismatch']);

      const artifactResult = await runDiagnostics({
        engine,
        registry,
        taskQueue,
        input: { staleHeartbeatAfterMs: 0, artifactDigest: 'sha256:match' },
      });
      expect(artifactResult.ok).toBe(true);
      if (!artifactResult.ok) throw new Error('expected diagnostics result');
      expect(diagnosticsValue(artifactResult.value).items.map((item) => item.operationId)).toEqual([
        'op-deployment-mismatch',
      ]);
    });

    it("filters by workerId against the attempt's executionIdentity.workerId, not the ledger's workerSessionId", async () => {
      const storage = new MemoryStorage();
      const engine = createEngine(storage);
      const registry = new WorkerRegistry();
      const taskQueue = new TaskQueue();

      // The session that claimed the lease is named `w-session-1`, but the
      // worker PROCESS identity `executionIdentity.workerId` recorded is a
      // different string — the filter must match the latter, not the former.
      await putLeasedWithAttempt(
        storage,
        leasedFixture({
          operationId: 'op-worker-identity',
          attemptToken: 'attempt-worker-identity',
          workerSessionId: 'w-session-1',
          queue: 'default',
        }),
        executionIdentityFixture({ workerId: 'w-process-7' }),
      );

      const matched = await runDiagnostics({
        engine,
        registry,
        taskQueue,
        input: { staleHeartbeatAfterMs: 0, workerId: 'w-process-7' },
      });
      expect(matched.ok).toBe(true);
      if (!matched.ok) throw new Error('expected diagnostics result');
      expect(diagnosticsValue(matched.value).items).toHaveLength(1);

      const unmatched = await runDiagnostics({
        engine,
        registry,
        taskQueue,
        input: { staleHeartbeatAfterMs: 0, workerId: 'w-session-1' },
      });
      expect(unmatched.ok).toBe(true);
      if (!unmatched.ok) throw new Error('expected diagnostics result');
      expect(diagnosticsValue(unmatched.value).items).toHaveLength(0);
    });

    it('excludes a task with no attempt record from every identity filter, rather than treating it as a wildcard match', async () => {
      const storage = new MemoryStorage();
      const engine = createEngine(storage);
      const registry = new WorkerRegistry();
      const taskQueue = new TaskQueue();

      // Leased, but no attempt record was ever written for it (e.g. a
      // hand-seeded fixture, or one predating COR-205) — never a match once
      // an identity filter is set.
      await putLedgerRecord(
        storage,
        leasedFixture({ operationId: 'op-no-attempt', attemptToken: 'attempt-orphan' }),
      );

      const result = await runDiagnostics({
        engine,
        registry,
        taskQueue,
        input: { staleHeartbeatAfterMs: 0, buildId: 'b1' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected diagnostics result');
      expect(diagnosticsValue(result.value).items).toHaveLength(0);
    });

    it('leaves every other diagnostic kind unaffected when no identity filter is set', async () => {
      const storage = new MemoryStorage();
      const engine = createEngine(storage);
      const registry = new WorkerRegistry();
      const taskQueue = new TaskQueue();

      await putLeasedWithAttempt(
        storage,
        leasedFixture({ operationId: 'op-unfiltered', attemptToken: 'attempt-unfiltered' }),
        executionIdentityFixture(),
      );

      const result = await runDiagnostics({
        engine,
        registry,
        taskQueue,
        input: { staleHeartbeatAfterMs: 0 },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected diagnostics result');
      expect(diagnosticsValue(result.value).items).toHaveLength(1);
    });

    it('excludes a queued record from every identity filter — no attempt has claimed it yet', async () => {
      const storage = new MemoryStorage();
      const engine = createEngine(storage);
      const registry = new WorkerRegistry();
      const taskQueue = new TaskQueue();

      await putLedgerRecord(
        storage,
        queuedFixture({ operationId: 'op-queued-unclaimed', availableAt: 0 }),
      );

      const result = await runDiagnostics({
        engine,
        registry,
        taskQueue,
        input: { staleQueuedAfterMs: 0, buildId: 'b1' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected diagnostics result');
      expect(diagnosticsValue(result.value).items).toHaveLength(0);
    });

    it("matches a resolved terminal record's identity filter via its retained attempt record", async () => {
      const storage = new MemoryStorage();
      const engine = createEngine(storage);
      const registry = new WorkerRegistry();
      const taskQueue = new TaskQueue();

      await putLedgerRecord(
        storage,
        terminalFixture({
          operationId: 'op-terminal-identity',
          attemptToken: 'attempt-terminal-identity',
          terminalAt: 0,
          adopted: false,
        }),
      );
      const digest = sha256HexSync('attempt-terminal-identity');
      await storage.put(
        taskAttemptKey('op-terminal-identity', digest),
        encodeTaskAttemptRecord({
          recordVersion: 1,
          operationId: 'op-terminal-identity',
          attempt: 1,
          attemptTokenDigest: digest,
          workerSessionId: 'w-1',
          claimedAt: 0,
          disposition: 'resolved',
          dispositionAt: 0,
          executionIdentity: executionIdentityFixture({ buildId: 'b-terminal' }),
        }),
      );

      const result = await runDiagnostics({
        engine,
        registry,
        taskQueue,
        input: { unadoptedAfterMs: 0, buildId: 'b-terminal' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected diagnostics result');
      expect(diagnosticsValue(result.value).items.map((item) => item.operationId)).toEqual([
        'op-terminal-identity',
      ]);
    });
  });
});
