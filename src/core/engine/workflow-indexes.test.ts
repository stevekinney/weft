import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decode, encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';

import {
  WORKFLOW_VISIBILITY_INDEX_VERSION,
  buildWorkflowVisibilityIndexOperations,
  buildWorkflowVisibilityIndexTransition,
  decodeWorkflowVisibilityManifest,
  deriveWorkflowVisibilityIndexKeys,
  getWorkflowVisibilityWatermark,
  type WorkflowVisibilityManifest,
} from './workflow-indexes.ts';

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  const base: WorkflowState = {
    id: 'wf-1',
    type: 'order-fulfillment',
    status: 'running',
    steps: [],
    attributes: {},
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    eventCount: 0,
    waiters: {},
    blockedSteps: {},
    pendingChildren: {},
    childWorkflows: {},
    pendingUpdates: {},
    updates: {},
    operationLeases: {},
    pendingSignals: [],
  } as unknown as WorkflowState;
  return { ...base, ...overrides };
}

describe('deriveWorkflowVisibilityIndexKeys', () => {
  it('emits the four mandatory dimensions in sorted order', () => {
    const state = makeState();
    const keys = deriveWorkflowVisibilityIndexKeys(state);
    expect(keys).toEqual(
      [
        KEYS.workflowVisibilityCreated(state.createdAt, state.id),
        KEYS.workflowVisibilityStatus(state.status, state.id),
        KEYS.workflowVisibilityType(state.type, state.id),
        KEYS.workflowVisibilityUpdated(state.updatedAt, state.id),
      ].toSorted(),
    );
  });

  it('includes the deadline index when executionDeadline is set', () => {
    const state = makeState({ executionDeadline: 1_700_000_999_999 });
    const keys = deriveWorkflowVisibilityIndexKeys(state);
    expect(keys).toContain(KEYS.workflowVisibilityDeadline(1_700_000_999_999, state.id));
  });

  it('omits optional dimensions when absent', () => {
    const keys = deriveWorkflowVisibilityIndexKeys(makeState());
    for (const key of keys) {
      expect(key.startsWith('wf-idx-deadline:')).toBe(false);
    }
  });

  it('returns keys in a stable, sorted order', () => {
    const keys = deriveWorkflowVisibilityIndexKeys(
      makeState({ executionDeadline: 1_700_000_999_999 }),
    );
    const sorted = [...keys].toSorted();
    expect(keys).toEqual(sorted);
  });
});

describe('buildWorkflowVisibilityIndexOperations', () => {
  it('writes all index keys and a fresh manifest on first insert', () => {
    const state = makeState({ executionDeadline: 1_700_000_999_999 });
    const { batchOps, nextManifestKeys } = buildWorkflowVisibilityIndexOperations(
      state.id,
      null,
      state,
    );

    const puts = batchOps.filter((operation) => operation.type === 'put');
    const deletes = batchOps.filter((operation) => operation.type === 'delete');
    expect(deletes).toEqual([]);

    const indexPuts = puts.filter(
      (operation) => operation.key !== KEYS.workflowVisibilityManifest(state.id),
    );
    const expectedKeys = deriveWorkflowVisibilityIndexKeys(state);
    expect(indexPuts.map((operation) => operation.key).toSorted()).toEqual(expectedKeys);

    const manifestPut = puts.find(
      (operation) => operation.key === KEYS.workflowVisibilityManifest(state.id),
    );
    expect(manifestPut).toBeDefined();
    const decoded = decode(manifestPut!.value);
    expect(decoded).toEqual({ version: WORKFLOW_VISIBILITY_INDEX_VERSION, keys: expectedKeys });
    expect(nextManifestKeys).toEqual(expectedKeys);
  });

  it('diffs against the current manifest on status transition', () => {
    const previousState = makeState({ status: 'pending', updatedAt: 1_700_000_000_100 });
    const previousManifest: WorkflowVisibilityManifest = {
      version: WORKFLOW_VISIBILITY_INDEX_VERSION,
      keys: deriveWorkflowVisibilityIndexKeys(previousState),
    };
    const nextState = makeState({ status: 'running', updatedAt: 1_700_000_000_200 });

    const { batchOps } = buildWorkflowVisibilityIndexOperations(
      nextState.id,
      previousManifest,
      nextState,
    );

    const deletedKeys = batchOps
      .filter((operation) => operation.type === 'delete')
      .map((operation) => operation.key);
    const putKeys = batchOps
      .filter(
        (operation): operation is { type: 'put'; key: string; value: Uint8Array } =>
          operation.type === 'put',
      )
      .map((operation) => operation.key);

    // Old status row and old updatedAt row must be deleted.
    expect(deletedKeys).toContain(KEYS.workflowVisibilityStatus('pending', nextState.id));
    expect(deletedKeys).toContain(KEYS.workflowVisibilityUpdated(1_700_000_000_100, nextState.id));
    // type and createdAt are immutable — no delete for them.
    expect(deletedKeys).not.toContain(KEYS.workflowVisibilityType(nextState.type, nextState.id));
    expect(deletedKeys).not.toContain(
      KEYS.workflowVisibilityCreated(nextState.createdAt, nextState.id),
    );

    // New rows for status + updatedAt must be inserted, and the manifest rewritten.
    expect(putKeys).toContain(KEYS.workflowVisibilityStatus('running', nextState.id));
    expect(putKeys).toContain(KEYS.workflowVisibilityUpdated(1_700_000_000_200, nextState.id));
    expect(putKeys).toContain(KEYS.workflowVisibilityManifest(nextState.id));
  });

  it('drops every key and the manifest when nextState is null', () => {
    const state = makeState({ executionDeadline: 1_700_000_999_999 });
    const manifest: WorkflowVisibilityManifest = {
      version: WORKFLOW_VISIBILITY_INDEX_VERSION,
      keys: deriveWorkflowVisibilityIndexKeys(state),
    };

    const { batchOps, nextManifestKeys } = buildWorkflowVisibilityIndexOperations(
      state.id,
      manifest,
      null,
    );

    const deletedKeys = batchOps
      .filter((operation) => operation.type === 'delete')
      .map((operation) => operation.key);

    for (const key of manifest.keys) {
      expect(deletedKeys).toContain(key);
    }
    expect(deletedKeys).toContain(KEYS.workflowVisibilityManifest(state.id));
    expect(batchOps.every((operation) => operation.type === 'delete')).toBe(true);
    expect(nextManifestKeys).toBeNull();
  });

  it('produces only a manifest write when keys are unchanged', () => {
    const state = makeState();
    const manifest: WorkflowVisibilityManifest = {
      version: WORKFLOW_VISIBILITY_INDEX_VERSION,
      keys: deriveWorkflowVisibilityIndexKeys(state),
    };

    const { batchOps } = buildWorkflowVisibilityIndexOperations(state.id, manifest, state);

    expect(batchOps).toHaveLength(1);
    expect(batchOps[0]).toMatchObject({
      type: 'put',
      key: KEYS.workflowVisibilityManifest(state.id),
    });
  });

  it('issues no manifest delete when there was no prior manifest and the workflow is gone', () => {
    const { batchOps, nextManifestKeys } = buildWorkflowVisibilityIndexOperations(
      'wf-1',
      null,
      null,
    );
    expect(batchOps).toEqual([]);
    expect(nextManifestKeys).toBeNull();
  });
});

describe('buildWorkflowVisibilityIndexTransition', () => {
  it('derives previous keys from previousState (no manifest read needed)', () => {
    const previousState = makeState({ status: 'pending', updatedAt: 1_700_000_000_100 });
    const nextState = makeState({ status: 'running', updatedAt: 1_700_000_000_200 });

    const { batchOps } = buildWorkflowVisibilityIndexTransition(
      nextState.id,
      previousState,
      nextState,
    );

    const deletedKeys = batchOps
      .filter((operation) => operation.type === 'delete')
      .map((operation) => operation.key);
    expect(deletedKeys).toContain(KEYS.workflowVisibilityStatus('pending', nextState.id));
    expect(deletedKeys).toContain(KEYS.workflowVisibilityUpdated(1_700_000_000_100, nextState.id));
  });

  it('drops every key when transitioning to null with a previous state', () => {
    const previousState = makeState({ executionDeadline: 1_700_000_999_999 });
    const { batchOps, nextManifestKeys } = buildWorkflowVisibilityIndexTransition(
      previousState.id,
      previousState,
      null,
    );

    const deletedKeys = batchOps
      .filter((operation) => operation.type === 'delete')
      .map((operation) => operation.key);
    for (const key of deriveWorkflowVisibilityIndexKeys(previousState)) {
      expect(deletedKeys).toContain(key);
    }
    expect(deletedKeys).toContain(KEYS.workflowVisibilityManifest(previousState.id));
    expect(nextManifestKeys).toBeNull();
  });

  it('emits no operations when both states are null', () => {
    const { batchOps } = buildWorkflowVisibilityIndexTransition('wf-1', null, null);
    expect(batchOps).toEqual([]);
  });
});

describe('decodeWorkflowVisibilityManifest', () => {
  it('round-trips a valid manifest', () => {
    const manifest: WorkflowVisibilityManifest = {
      version: WORKFLOW_VISIBILITY_INDEX_VERSION,
      keys: ['wf-idx-status:running:wf-1', 'wf-idx-type:demo:wf-1'],
    };
    const decoded = decodeWorkflowVisibilityManifest(encode(manifest));
    expect(decoded).toEqual(manifest);
  });

  it('returns null for missing input', () => {
    expect(decodeWorkflowVisibilityManifest(null)).toBeNull();
  });

  it('returns null for malformed payloads', () => {
    expect(decodeWorkflowVisibilityManifest(encode({ version: 'one', keys: [] }))).toBeNull();
    expect(decodeWorkflowVisibilityManifest(encode({ version: 1, keys: 'oops' }))).toBeNull();
    expect(decodeWorkflowVisibilityManifest(encode({ version: 1, keys: [1, 2] }))).toBeNull();
    expect(decodeWorkflowVisibilityManifest(encode(null))).toBeNull();
  });
});

describe('getWorkflowVisibilityWatermark', () => {
  it('returns "stale" when no version watermark is present', async () => {
    await using storage = new MemoryStorage();
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
  });

  it('returns "stale" when the persisted version is below the current schema', async () => {
    await using storage = new MemoryStorage();
    await storage.put(
      KEYS.workflowVisibilityMetaVersion(),
      encode(WORKFLOW_VISIBILITY_INDEX_VERSION - 1),
    );
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
  });

  it('returns "current" when the persisted version matches', async () => {
    await using storage = new MemoryStorage();
    await storage.put(
      KEYS.workflowVisibilityMetaVersion(),
      encode(WORKFLOW_VISIBILITY_INDEX_VERSION),
    );
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
  });

  it('returns "stale" when the watermark payload is malformed', async () => {
    await using storage = new MemoryStorage();
    await storage.put(KEYS.workflowVisibilityMetaVersion(), encode('not-a-number'));
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
  });
});
