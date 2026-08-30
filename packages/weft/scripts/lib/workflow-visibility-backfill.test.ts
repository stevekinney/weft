import { describe, expect, it } from 'bun:test';

import { encode } from '../../src/core/codec.ts';
import {
  WORKFLOW_VISIBILITY_INDEX_VERSION,
  decodeWorkflowVisibilityManifest,
  getWorkflowVisibilityWatermark,
} from '../../src/core/engine/workflow-indexes.ts';
import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
} from '../../src/storage/interface.ts';
import { MemoryStorage } from '../../src/storage/memory.ts';

import {
  runWorkflowVisibilityBackfill,
  runWorkflowVisibilityDrop,
} from './workflow-visibility-backfill.ts';

type MinimalWorkflowState = {
  id: string;
  type: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  steps: unknown[];
  attributes: Record<string, unknown>;
  tags: string[];
  eventCount: number;
  waiters: Record<string, unknown>;
  blockedSteps: Record<string, unknown>;
  pendingChildren: Record<string, unknown>;
  childWorkflows: Record<string, unknown>;
  pendingUpdates: Record<string, unknown>;
  updates: Record<string, unknown>;
  operationLeases: Record<string, unknown>;
  pendingSignals: unknown[];
  tenant?: { id: string };
  executionDeadline?: number;
};

function makeWorkflowState(overrides: Partial<MinimalWorkflowState>): MinimalWorkflowState {
  return {
    id: 'wf-1',
    type: 'order-fulfillment',
    status: 'running',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    steps: [],
    attributes: {},
    tags: [],
    eventCount: 0,
    waiters: {},
    blockedSteps: {},
    pendingChildren: {},
    childWorkflows: {},
    pendingUpdates: {},
    updates: {},
    operationLeases: {},
    pendingSignals: [],
    ...overrides,
  };
}

async function seedWorkflow(storage: MemoryStorage, state: MinimalWorkflowState): Promise<void> {
  await storage.put(KEYS.workflow(state.id), encode(state));
}

async function collectKeys(storage: Storage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(prefix)) keys.push(key);
  return keys;
}

describe('runWorkflowVisibilityBackfill', () => {
  it('writes the manifest, index rows, and watermark for a fresh database', async () => {
    await using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-b', type: 'payment' }));

    const report = await runWorkflowVisibilityBackfill(storage);

    expect(report.processed).toBe(2);
    expect(report.conflicts).toBe(0);
    expect(report.watermarkWritten).toBe(true);

    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
    expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).toBeNull();

    const manifestA = decodeWorkflowVisibilityManifest(
      await storage.get(KEYS.workflowVisibilityManifest('wf-a')),
    );
    expect(manifestA?.version).toBe(WORKFLOW_VISIBILITY_INDEX_VERSION);
    expect(manifestA?.keys.length).toBeGreaterThan(0);

    const statusRows = await collectKeys(storage, 'wf-idx-status:');
    expect(statusRows).toContain(KEYS.workflowVisibilityStatus('running', 'wf-a'));
    expect(statusRows).toContain(KEYS.workflowVisibilityStatus('running', 'wf-b'));
  });

  it('is idempotent on a second pass', async () => {
    await using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));

    await runWorkflowVisibilityBackfill(storage);
    const firstRows = await collectKeys(storage, 'wf-idx-status:');
    const firstStatusRows = firstRows.toSorted();

    const second = await runWorkflowVisibilityBackfill(storage);
    expect(second.processed).toBe(1);
    expect(second.watermarkWritten).toBe(true);

    const secondRows = await collectKeys(storage, 'wf-idx-status:');
    const secondStatusRows = secondRows.toSorted();
    expect(secondStatusRows).toEqual(firstStatusRows);
  });

  it('skips workflows that the engine updates mid-backfill (conditional-batch conflict)', async () => {
    await using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-b' }));

    const racingStorage = new RacingStorage(storage, new Set(['wf-a']));
    const report = await runWorkflowVisibilityBackfill(racingStorage);

    // wf-a was updated mid-backfill; wf-b processed cleanly.
    expect(report.processed).toBe(1);
    expect(report.conflicts).toBe(1);
    // Watermark must NOT advance when conflicts occurred.
    expect(report.watermarkWritten).toBe(false);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
  });

  it('resumes from the persisted cursor', async () => {
    await using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-b' }));
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-c' }));

    // Plant a cursor pointing past wf-a so the next run only processes b and c.
    await storage.put(KEYS.workflowVisibilityMetaCursor(), encode(KEYS.workflow('wf-a')));

    const report = await runWorkflowVisibilityBackfill(storage);
    expect(report.processed).toBe(2);
    expect(report.watermarkWritten).toBe(true);

    // wf-a was skipped, so it has no manifest.
    expect(await storage.get(KEYS.workflowVisibilityManifest('wf-a'))).toBeNull();
    expect(await storage.get(KEYS.workflowVisibilityManifest('wf-b'))).not.toBeNull();
    expect(await storage.get(KEYS.workflowVisibilityManifest('wf-c'))).not.toBeNull();
  });

  it('refuses to run when the storage backend has no conditionalBatch', async () => {
    const storage = new NoConditionalBatchStorage();
    await expect(runWorkflowVisibilityBackfill(storage)).rejects.toThrow(
      /does not expose conditionalBatch/,
    );
  });
});

describe('runWorkflowVisibilityDrop', () => {
  it('removes the watermark before sweeping rows and clears the cursor last', async () => {
    await using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await runWorkflowVisibilityBackfill(storage);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');

    await runWorkflowVisibilityDrop(storage);

    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
    expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).toBeNull();
    expect(await storage.get(KEYS.workflowVisibilityMetaBuiltAt())).toBeNull();

    for (const prefix of [
      'wf-idx-status:',
      'wf-idx-type:',
      'wf-idx-tenant:',
      'wf-idx-created:',
      'wf-idx-updated:',
      'wf-idx-deadline:',
      'wf-idx-manifest:',
    ]) {
      expect(await collectKeys(storage, prefix)).toEqual([]);
    }
  });

  it('leaves workflow state untouched', async () => {
    await using storage = new MemoryStorage();
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-a' }));
    await runWorkflowVisibilityBackfill(storage);

    await runWorkflowVisibilityDrop(storage);

    expect(await storage.get(KEYS.workflow('wf-a'))).not.toBeNull();
  });
});

/**
 * MemoryStorage wrapper that simulates a runtime write to a target
 * workflow the first time its conditional batch is attempted. The
 * `expectedValue` no longer matches, so the conditional batch fails —
 * exactly the racing-runtime case the conditional pre-image guards.
 */
class RacingStorage implements Storage {
  readonly #inner: MemoryStorage;
  readonly #raceTargets: Set<string>;
  readonly #raced: Set<string> = new Set();

  conditionalBatch: NonNullable<Storage['conditionalBatch']>;

  constructor(inner: MemoryStorage, raceTargets: Set<string>) {
    this.#inner = inner;
    this.#raceTargets = raceTargets;
    this.conditionalBatch = async (
      conditions: ConditionalBatchCondition[],
      operations: BatchOperation[],
    ): Promise<boolean> => {
      // Simulate the racing engine write by mutating the watched workflow
      // before evaluating the conditional batch — exactly the order that
      // would produce an updatedAt mismatch in production.
      for (const condition of conditions) {
        const target = condition.key.startsWith('wf:') ? condition.key.slice(3) : '';
        if (this.#raceTargets.has(target) && !this.#raced.has(target)) {
          this.#raced.add(target);
          await this.#inner.put(condition.key, encode({ id: target, racedAt: Date.now() }));
        }
      }
      const conditionalBatch = this.#inner.conditionalBatch;
      if (conditionalBatch === undefined) {
        throw new Error('inner MemoryStorage should expose conditionalBatch');
      }
      return conditionalBatch.call(this.#inner, conditions, operations);
    };
  }

  capabilities() {
    return this.#inner.capabilities();
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.#inner.get(key);
  }
  async put(key: string, value: Uint8Array): Promise<void> {
    return this.#inner.put(key, value);
  }
  async delete(key: string): Promise<void> {
    return this.#inner.delete(key);
  }
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    return this.#inner.scan(prefix, options);
  }
  async batch(operations: BatchOperation[]): Promise<void> {
    return this.#inner.batch(operations);
  }
  [Symbol.dispose](): void {
    this.#inner[Symbol.dispose]();
  }
}

/**
 * Bare-minimum Storage implementation that omits `conditionalBatch`,
 * used to assert the backfill refuses to run on backends without
 * conditional writes.
 */
class NoConditionalBatchStorage implements Storage {
  capabilities() {
    return {
      persistence: 'ephemeral' as const,
      readAfterWrite: 'linearizable' as const,
      scanConsistency: 'snapshot' as const,
      atomicBatch: true,
      conditionalBatch: false,
      boundedRangeDelete: false,
    };
  }
  async get(): Promise<Uint8Array | null> {
    return null;
  }
  async put(): Promise<void> {
    return undefined;
  }
  async delete(): Promise<void> {
    return undefined;
  }
  async *scan(): AsyncIterable<[string, Uint8Array]> {
    // empty
  }
  async batch(): Promise<void> {
    return undefined;
  }
  [Symbol.dispose](): void {
    // nothing to dispose
  }
}
