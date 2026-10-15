import { afterEach, describe, expect, it } from 'bun:test';

import {
  runWorkflowVisibilityBackfill,
  runWorkflowVisibilityDrop,
} from '../../scripts/lib/workflow-visibility-backfill.ts';
import { decode, encode } from '../core/codec.ts';
import {
  getWorkflowVisibilityWatermark,
  workflowVisibilityUpdatedBucket,
} from '../core/engine/workflow-indexes.ts';
import type { WorkflowState } from '../core/types.ts';
import {
  collectKeys,
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
  type DiskBackedTestFixture,
} from '../testing/storage-backends.test-support.ts';
import { KEYS } from './interface.ts';

import { BunSQLiteStorage } from './bun-sql.ts';

let currentStorage: BunSQLiteStorage | undefined;
let currentFixture: DiskBackedTestFixture | undefined;

afterEach(() => {
  currentStorage?.[Symbol.dispose]();
  currentStorage = undefined;
  currentFixture?.cleanup();
  currentFixture = undefined;
});

function openDiskStorage(): BunSQLiteStorage {
  currentFixture = createDiskBackedTestFixture({
    prefix: 'bunsqlite-visibility-backfill',
    suffix: '.db',
    sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
  });
  currentStorage = new BunSQLiteStorage(currentFixture.path);
  return currentStorage;
}

function makeWorkflowState(overrides: Partial<WorkflowState>): WorkflowState {
  return {
    id: 'workflow-a',
    type: 'order-fulfillment',
    status: 'running',
    input: null,
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    tags: [],
    ...overrides,
  };
}

async function seedWorkflow(storage: BunSQLiteStorage, state: WorkflowState): Promise<void> {
  await storage.put(KEYS.workflow(state.id), encode(state));
}

describe('BunSQLite workflow visibility backfill', () => {
  it('writes index rows and the watermark for an on-disk database', async () => {
    const storage = openDiskStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({
        id: 'workflow-a',
        type: 'order-fulfillment',
        status: 'running',
      }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({
        id: 'workflow-b',
        type: 'payment',
        status: 'completed',
        executionDeadline: 1_700_000_010_000,
      }),
    );

    const report = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    expect(report).toEqual({ processed: 2, conflicts: 0, watermarkWritten: true });
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
    expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).toBeNull();
    const builtAtBytes = await storage.get(KEYS.workflowVisibilityMetaBuiltAt());
    expect(builtAtBytes).not.toBeNull();
    expect(decode(builtAtBytes!)).toEqual(expect.any(Number));

    expect(await collectKeys(storage, 'wf-idx-created:')).toEqual([
      KEYS.workflowVisibilityCreated(1_700_000_000_000, 'workflow-a'),
      KEYS.workflowVisibilityCreated(1_700_000_000_000, 'workflow-b'),
    ]);
    expect(await collectKeys(storage, 'wf-idx-updated:')).toEqual([
      KEYS.workflowVisibilityUpdated(
        workflowVisibilityUpdatedBucket(1_700_000_000_500),
        'workflow-a',
      ),
      KEYS.workflowVisibilityUpdated(
        workflowVisibilityUpdatedBucket(1_700_000_000_500),
        'workflow-b',
      ),
    ]);
    expect(await collectKeys(storage, 'wf-idx-manifest:')).toEqual([]);
    expect(await collectKeys(storage, 'wf-idx-status:')).toEqual([
      KEYS.workflowVisibilityStatus('completed', 'workflow-b'),
      KEYS.workflowVisibilityStatus('running', 'workflow-a'),
    ]);
    expect(await collectKeys(storage, 'wf-idx-type:')).toEqual([
      KEYS.workflowVisibilityType('order-fulfillment', 'workflow-a'),
      KEYS.workflowVisibilityType('payment', 'workflow-b'),
    ]);
    expect(await collectKeys(storage, 'wf-idx-deadline:')).toEqual([
      KEYS.workflowVisibilityDeadline(1_700_000_010_000, 'workflow-b'),
    ]);

    const indexedKeysAfterFirstBackfill = await collectKeys(storage, 'wf-idx-');
    const secondReport = await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });

    expect(secondReport).toEqual({ processed: 2, conflicts: 0, watermarkWritten: true });
    expect(await collectKeys(storage, 'wf-idx-')).toEqual(indexedKeysAfterFirstBackfill);
  });

  it('drops visibility rows and watermark without deleting workflow state', async () => {
    const storage = openDiskStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({
        id: 'workflow-a',
        executionDeadline: 1_700_000_010_000,
      }),
    );
    await runWorkflowVisibilityBackfill(storage, { settleMilliseconds: 0 });
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');

    const report = await runWorkflowVisibilityDrop(storage, { settleMilliseconds: 0 });

    expect(report.rowsDeleted).toBeGreaterThan(0);
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
    expect(await storage.get(KEYS.workflowVisibilityMetaVersion())).toBeNull();
    expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).toBeNull();
    expect(await storage.get(KEYS.workflowVisibilityMetaBuiltAt())).toBeNull();
    expect(await storage.get(KEYS.workflow('workflow-a'))).not.toBeNull();

    for (const prefix of [
      'wf-idx-status:',
      'wf-idx-type:',
      'wf-idx-created:',
      'wf-idx-updated:',
      'wf-idx-deadline:',
      'wf-idx-manifest:',
    ]) {
      expect(await collectKeys(storage, prefix)).toEqual([]);
    }
  });
});
