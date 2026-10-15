import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';

import {
  WORKFLOW_VISIBILITY_INDEX_VERSION,
  WORKFLOW_VISIBILITY_UPDATED_BUCKET_MILLISECONDS,
  buildWorkflowVisibilityIndexTransition,
  deriveWorkflowVisibilityIndexKeys,
  getWorkflowVisibilityWatermark,
  workflowVisibilityUpdatedBucket,
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
  } as unknown as WorkflowState;
  return { ...base, ...overrides };
}

function keysOf(operations: readonly BatchOperation[], type: BatchOperation['type']): string[] {
  return operations
    .filter((operation) => operation.type === type)
    .map((operation) => operation.key);
}

describe('workflowVisibilityUpdatedBucket', () => {
  it('floors a timestamp to the start of its bucket', () => {
    const bucketStart = 1_700_000_040_000;
    expect(bucketStart % WORKFLOW_VISIBILITY_UPDATED_BUCKET_MILLISECONDS).toBe(0);
    expect(workflowVisibilityUpdatedBucket(bucketStart)).toBe(bucketStart);
    expect(
      workflowVisibilityUpdatedBucket(
        bucketStart + WORKFLOW_VISIBILITY_UPDATED_BUCKET_MILLISECONDS - 1,
      ),
    ).toBe(bucketStart);
    expect(
      workflowVisibilityUpdatedBucket(
        bucketStart + WORKFLOW_VISIBILITY_UPDATED_BUCKET_MILLISECONDS,
      ),
    ).toBe(bucketStart + WORKFLOW_VISIBILITY_UPDATED_BUCKET_MILLISECONDS);
  });
});

describe('deriveWorkflowVisibilityIndexKeys', () => {
  it('emits the four mandatory dimensions, with updatedAt bucketed', () => {
    const state = makeState();
    const keys = deriveWorkflowVisibilityIndexKeys(state);
    expect(keys.toSorted()).toEqual(
      [
        KEYS.workflowVisibilityCreated(state.createdAt, state.id),
        KEYS.workflowVisibilityStatus(state.status, state.id),
        KEYS.workflowVisibilityType(state.type, state.id),
        KEYS.workflowVisibilityUpdated(workflowVisibilityUpdatedBucket(state.updatedAt), state.id),
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
});

describe('buildWorkflowVisibilityIndexTransition', () => {
  it('writes every derived key, and nothing else, on first insert', () => {
    const state = makeState({ executionDeadline: 1_700_000_999_999 });
    const operations = buildWorkflowVisibilityIndexTransition(null, state);

    expect(keysOf(operations, 'delete')).toEqual([]);
    expect(keysOf(operations, 'put').toSorted()).toEqual(
      deriveWorkflowVisibilityIndexKeys(state).toSorted(),
    );
  });

  it('moves only the status row when updatedAt stays inside its bucket (COR-1387)', () => {
    const previousState = makeState({ status: 'running', updatedAt: 1_700_000_040_100 });
    const nextState = makeState({ status: 'completed', updatedAt: 1_700_000_040_900 });

    const operations = buildWorkflowVisibilityIndexTransition(previousState, nextState);

    expect(keysOf(operations, 'delete')).toEqual([
      KEYS.workflowVisibilityStatus('running', nextState.id),
    ]);
    expect(keysOf(operations, 'put')).toEqual([
      KEYS.workflowVisibilityStatus('completed', nextState.id),
    ]);
  });

  it('moves the updated row when updatedAt crosses into a later bucket', () => {
    const previousUpdatedAt = 1_700_000_040_100;
    const nextUpdatedAt = previousUpdatedAt + WORKFLOW_VISIBILITY_UPDATED_BUCKET_MILLISECONDS;
    const previousState = makeState({ status: 'pending', updatedAt: previousUpdatedAt });
    const nextState = makeState({ status: 'running', updatedAt: nextUpdatedAt });

    const operations = buildWorkflowVisibilityIndexTransition(previousState, nextState);
    const deletedKeys = keysOf(operations, 'delete');
    const putKeys = keysOf(operations, 'put');

    expect(deletedKeys).toContain(KEYS.workflowVisibilityStatus('pending', nextState.id));
    expect(deletedKeys).toContain(
      KEYS.workflowVisibilityUpdated(
        workflowVisibilityUpdatedBucket(previousUpdatedAt),
        nextState.id,
      ),
    );
    // type and createdAt are immutable — no delete for them.
    expect(deletedKeys).not.toContain(KEYS.workflowVisibilityType(nextState.type, nextState.id));
    expect(deletedKeys).not.toContain(
      KEYS.workflowVisibilityCreated(nextState.createdAt, nextState.id),
    );
    expect(putKeys).toContain(KEYS.workflowVisibilityStatus('running', nextState.id));
    expect(putKeys).toContain(
      KEYS.workflowVisibilityUpdated(workflowVisibilityUpdatedBucket(nextUpdatedAt), nextState.id),
    );
  });

  it('emits no operations when the derived keys are unchanged', () => {
    const state = makeState();
    expect(buildWorkflowVisibilityIndexTransition(state, { ...state })).toEqual([]);
  });

  it('drops every key when transitioning to null', () => {
    const previousState = makeState({ executionDeadline: 1_700_000_999_999 });
    const operations = buildWorkflowVisibilityIndexTransition(previousState, null);

    expect(keysOf(operations, 'put')).toEqual([]);
    expect(keysOf(operations, 'delete').toSorted()).toEqual(
      deriveWorkflowVisibilityIndexKeys(previousState).toSorted(),
    );
  });

  it('emits no operations when both states are null', () => {
    expect(buildWorkflowVisibilityIndexTransition(null, null)).toEqual([]);
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
