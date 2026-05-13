import { describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import {
  CURRENT_CHECKPOINT_SCHEMA_VERSION,
  type Checkpoint,
  type WorkflowState,
} from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from '../testing/storage-backends.ts';
import { collectDiagnostics } from './doctor.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf-1',
    type: 'testWorkflow',
    status: 'running',
    input: null,
    version: '1.0.0',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    workflowId: 'wf-1',
    step: 3,
    locals: {},
    accumulatedResults: [],
    pendingSignals: [],
    searchAttributes: {},
    version: '1.0.0',
    schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Database health — BunSQLiteStorage
// ---------------------------------------------------------------------------

describe('database health with BunSQLiteStorage', () => {
  it('returns valid page count and page size', async () => {
    using storage = new BunSQLiteStorage(':memory:');
    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.database.pageCount).toBeGreaterThan(0);
    expect(report.database.pageSize).toBeGreaterThan(0);
  });

  it('reports journal mode as a non-empty string', async () => {
    using storage = new BunSQLiteStorage(':memory:');
    const report = await collectDiagnostics(storage, ':memory:');

    // In-memory databases report 'memory' as journal mode since WAL
    // does not apply without a backing file.
    expect(typeof report.database.journalMode).toBe('string');
    expect(report.database.journalMode.length).toBeGreaterThan(0);
  });

  it('passes integrity check', async () => {
    using storage = new BunSQLiteStorage(':memory:');
    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.database.integrityOk).toBe(true);
    expect(report.database.integrityError).toBeNull();
  });

  it('returns a freelist count that is a non-negative number', async () => {
    using storage = new BunSQLiteStorage(':memory:');
    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.database.freelistCount).toBeGreaterThanOrEqual(0);
  });

  it('returns file size of 0 for in-memory database', async () => {
    using storage = new BunSQLiteStorage(':memory:');
    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.database.sizeBytes).toBe(0);
  });

  it('returns null WAL size for in-memory database', async () => {
    using storage = new BunSQLiteStorage(':memory:');
    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.database.walSizeBytes).toBeNull();
  });

  it('reads file size from disk for a file-based database', async () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'weft-doctor-test',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const storage = new BunSQLiteStorage(fixture.path);
    try {
      // Write some data so the file has non-zero size
      await storage.put('test-key', encode({ data: 'hello' }));
      const report = await collectDiagnostics(storage, fixture.path);

      expect(report.database.sizeBytes).toBeGreaterThan(0);
      // WAL file should exist for a file-based WAL-mode database
      expect(typeof report.database.walSizeBytes).toBe('number');
    } finally {
      storage[Symbol.dispose]();
      fixture.cleanup();
    }
  });

  it('returns null WAL size when WAL file does not exist', async () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'weft-doctor-nonexistent',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    try {
      using storage = new BunSQLiteStorage(':memory:');
      // Pass a non-memory path but the storage is actually in-memory
      // so the file won't exist on disk — tests the catch path
      const report = await collectDiagnostics(storage, fixture.path);

      // Since the file doesn't exist, size should be 0 (Bun.file().size returns 0 for nonexistent)
      // and WAL will also not exist
      expect(report.database.sizeBytes).toBe(0);
      expect(report.database.walSizeBytes).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Database health — MemoryStorage
// ---------------------------------------------------------------------------

describe('database health with MemoryStorage', () => {
  it('returns default values', async () => {
    const storage = new MemoryStorage();
    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.database.sizeBytes).toBe(0);
    expect(report.database.integrityOk).toBe(true);
    expect(report.database.integrityError).toBeNull();
    expect(report.database.fragmentationPercent).toBe(0);
    expect(report.database.walSizeBytes).toBeNull();
    expect(report.database.journalMode).toBe('unknown');
    expect(report.database.pageCount).toBe(0);
    expect(report.database.pageSize).toBe(0);
    expect(report.database.freelistCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Workflow statistics
// ---------------------------------------------------------------------------

describe('workflow statistics', () => {
  it('returns zeros for an empty database', async () => {
    const storage = new MemoryStorage();
    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.workflows.total).toBe(0);
    expect(report.workflows.statusCounts).toEqual({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timedOut: 0,
    });
    expect(report.workflows.longestRunning).toBeNull();
    expect(report.workflows.largestCheckpoint).toBeNull();
  });

  it('counts workflows by status', async () => {
    const storage = new MemoryStorage();

    await storage.put(
      KEYS.workflow('wf-1'),
      encode(makeWorkflowState({ id: 'wf-1', status: 'running' })),
    );
    await storage.put(
      KEYS.workflow('wf-2'),
      encode(makeWorkflowState({ id: 'wf-2', status: 'completed' })),
    );
    await storage.put(
      KEYS.workflow('wf-3'),
      encode(makeWorkflowState({ id: 'wf-3', status: 'failed' })),
    );
    await storage.put(
      KEYS.workflow('wf-4'),
      encode(makeWorkflowState({ id: 'wf-4', status: 'pending' })),
    );
    await storage.put(
      KEYS.workflow('wf-5'),
      encode(makeWorkflowState({ id: 'wf-5', status: 'cancelled' })),
    );
    await storage.put(
      KEYS.workflow('wf-6'),
      encode(makeWorkflowState({ id: 'wf-6', status: 'timed-out' })),
    );

    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.workflows.total).toBe(6);
    expect(report.workflows.statusCounts.running).toBe(1);
    expect(report.workflows.statusCounts.completed).toBe(1);
    expect(report.workflows.statusCounts.failed).toBe(1);
    expect(report.workflows.statusCounts.pending).toBe(1);
    expect(report.workflows.statusCounts.cancelled).toBe(1);
    expect(report.workflows.statusCounts.timedOut).toBe(1);
  });

  it('identifies the longest running workflow', async () => {
    const storage = new MemoryStorage();
    const now = Date.now();

    // Older running workflow — should be the longest
    await storage.put(
      KEYS.workflow('wf-old'),
      encode(
        makeWorkflowState({
          id: 'wf-old',
          type: 'orderProcess',
          status: 'running',
          createdAt: now - 100_000,
        }),
      ),
    );
    // Also seed its checkpoint
    await storage.put(
      KEYS.checkpoint('wf-old'),
      encode(makeCheckpoint({ workflowId: 'wf-old', step: 7 })),
    );

    // Newer running workflow
    await storage.put(
      KEYS.workflow('wf-new'),
      encode(
        makeWorkflowState({
          id: 'wf-new',
          type: 'paymentProcess',
          status: 'running',
          createdAt: now - 10_000,
        }),
      ),
    );
    await storage.put(
      KEYS.checkpoint('wf-new'),
      encode(makeCheckpoint({ workflowId: 'wf-new', step: 2 })),
    );

    const report = await collectDiagnostics(storage, ':memory:', { now });

    expect(report.workflows.longestRunning).not.toBeNull();
    expect(report.workflows.longestRunning!.id).toBe('wf-old');
    expect(report.workflows.longestRunning!.type).toBe('orderProcess');
    expect(report.workflows.longestRunning!.currentStep).toBe(7);
    expect(report.workflows.longestRunning!.elapsedMilliseconds).toBe(100_000);
  });

  it('identifies the largest checkpoint', async () => {
    const storage = new MemoryStorage();

    // Small checkpoint
    await storage.put(KEYS.workflow('wf-small'), encode(makeWorkflowState({ id: 'wf-small' })));
    const smallCheckpoint = encode(makeCheckpoint({ workflowId: 'wf-small', locals: { a: 1 } }));
    await storage.put(KEYS.checkpoint('wf-small'), smallCheckpoint);

    // Large checkpoint — stuff a big locals object
    await storage.put(KEYS.workflow('wf-large'), encode(makeWorkflowState({ id: 'wf-large' })));
    const largeLocals: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      largeLocals[`key${i}`] = 'x'.repeat(100);
    }
    const largeCheckpoint = encode(makeCheckpoint({ workflowId: 'wf-large', locals: largeLocals }));
    await storage.put(KEYS.checkpoint('wf-large'), largeCheckpoint);

    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.workflows.largestCheckpoint).not.toBeNull();
    expect(report.workflows.largestCheckpoint!.workflowId).toBe('wf-large');
    expect(report.workflows.largestCheckpoint!.sizeBytes).toBe(largeCheckpoint.byteLength);
  });

  it('does not count checkpoint history keys as largest checkpoint', async () => {
    const storage = new MemoryStorage();

    await storage.put(KEYS.workflow('wf-1'), encode(makeWorkflowState({ id: 'wf-1' })));

    // Current checkpoint (small)
    const currentCheckpoint = encode(makeCheckpoint({ workflowId: 'wf-1', locals: { a: 1 } }));
    await storage.put(KEYS.checkpoint('wf-1'), currentCheckpoint);

    // History checkpoint (would be larger, but should not be counted)
    const largeLocals: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      largeLocals[`key${i}`] = 'x'.repeat(100);
    }
    const historyCheckpoint = encode(makeCheckpoint({ workflowId: 'wf-1', locals: largeLocals }));
    await storage.put(KEYS.checkpointHistory('wf-1', 1), historyCheckpoint);

    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.workflows.largestCheckpoint).not.toBeNull();
    expect(report.workflows.largestCheckpoint!.sizeBytes).toBe(currentCheckpoint.byteLength);
  });
});

// ---------------------------------------------------------------------------
// Queue statistics
// ---------------------------------------------------------------------------

describe('queue statistics', () => {
  it('returns empty queues for an empty database', async () => {
    const storage = new MemoryStorage();
    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.queues).toEqual([]);
  });

  it('counts pending operations per queue', async () => {
    const storage = new MemoryStorage();

    await storage.put(KEYS.operation('default', 1, 'op1'), encode({ queue: 'default', id: 'op1' }));
    await storage.put(KEYS.operation('default', 2, 'op2'), encode({ queue: 'default', id: 'op2' }));

    const report = await collectDiagnostics(storage, ':memory:');

    const defaultQueue = report.queues.find((queue) => queue.name === 'default');
    expect(defaultQueue).toBeDefined();
    expect(defaultQueue!.pendingCount).toBe(2);
  });

  it('counts in-flight operations per queue', async () => {
    const storage = new MemoryStorage();

    await storage.put(KEYS.operationInflight('op1'), encode({ queue: 'default', id: 'op1' }));
    await storage.put(KEYS.operationInflight('op2'), encode({ queue: 'default', id: 'op2' }));

    const report = await collectDiagnostics(storage, ':memory:');

    const defaultQueue = report.queues.find((queue) => queue.name === 'default');
    expect(defaultQueue).toBeDefined();
    expect(defaultQueue!.inflightCount).toBe(2);
  });

  it('ignores resolved task indexes when counting pending queues', async () => {
    const storage = new MemoryStorage();

    await storage.put(
      KEYS.operationResolvedByTime(1_234, 'op1'),
      encode({ queue: 'default', id: 'op1' }),
    );

    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.queues).toEqual([]);
  });

  it('handles multiple queues', async () => {
    const storage = new MemoryStorage();

    await storage.put(KEYS.operation('default', 1, 'op1'), encode({ queue: 'default', id: 'op1' }));
    await storage.put(
      KEYS.operation('payments', 1, 'op2'),
      encode({ queue: 'payments', id: 'op2' }),
    );
    await storage.put(KEYS.operationInflight('op3'), encode({ queue: 'payments', id: 'op3' }));

    const report = await collectDiagnostics(storage, ':memory:');

    expect(report.queues).toHaveLength(2);

    const defaultQueue = report.queues.find((queue) => queue.name === 'default');
    expect(defaultQueue).toBeDefined();
    expect(defaultQueue!.pendingCount).toBe(1);
    expect(defaultQueue!.inflightCount).toBe(0);

    const paymentsQueue = report.queues.find((queue) => queue.name === 'payments');
    expect(paymentsQueue).toBeDefined();
    expect(paymentsQueue!.pendingCount).toBe(1);
    expect(paymentsQueue!.inflightCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Full integration
// ---------------------------------------------------------------------------

describe('collectDiagnostics integration', () => {
  it('assembles a complete report with all sections', async () => {
    const storage = new MemoryStorage();
    const now = Date.now();

    // Seed workflows
    await storage.put(
      KEYS.workflow('wf-1'),
      encode(makeWorkflowState({ id: 'wf-1', status: 'running', createdAt: now - 60_000 })),
    );
    await storage.put(
      KEYS.workflow('wf-2'),
      encode(makeWorkflowState({ id: 'wf-2', status: 'completed' })),
    );

    // Seed checkpoint
    await storage.put(
      KEYS.checkpoint('wf-1'),
      encode(makeCheckpoint({ workflowId: 'wf-1', step: 5 })),
    );

    // Seed operations
    await storage.put(KEYS.operation('default', 1, 'op1'), encode({ queue: 'default', id: 'op1' }));
    await storage.put(KEYS.operationInflight('op2'), encode({ queue: 'default', id: 'op2' }));

    const report = await collectDiagnostics(storage, ':memory:', { now });

    // Report structure
    expect(report.timestamp).toBe(now);
    expect(report.databasePath).toBe(':memory:');

    // Database section (MemoryStorage defaults)
    expect(report.database.integrityOk).toBe(true);

    // Workflow section
    expect(report.workflows.total).toBe(2);
    expect(report.workflows.statusCounts.running).toBe(1);
    expect(report.workflows.statusCounts.completed).toBe(1);
    expect(report.workflows.longestRunning).not.toBeNull();
    expect(report.workflows.longestRunning!.id).toBe('wf-1');

    // Queue section
    expect(report.queues).toHaveLength(1);
    expect(report.queues[0]!.name).toBe('default');
    expect(report.queues[0]!.pendingCount).toBe(1);
    expect(report.queues[0]!.inflightCount).toBe(1);

    // Recommendations
    expect(Array.isArray(report.recommendations)).toBe(true);
  });

  it('uses the provided sizeLimitBytes option', async () => {
    const storage = new MemoryStorage();
    const customLimit = 500 * 1024 * 1024;
    const report = await collectDiagnostics(storage, ':memory:', { sizeLimitBytes: customLimit });

    expect(report.database.sizeLimitBytes).toBe(customLimit);
  });
});
