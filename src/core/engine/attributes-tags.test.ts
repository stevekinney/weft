import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decode, encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import {
  bulkMutateWorkflowTags,
  cleanupAttributeIndex,
  mutateWorkflowTags,
  updateWorkflowState,
} from './attributes-tags.ts';
import { decodeEpoch, encodeEpoch } from './workflow-claim-codec.ts';

function createWorkflowState(
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: 1_000,
    id: workflowId,
    input: null,
    startedAt: 1_000,
    status: 'completed',
    type: 'workflow',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

function createInternals(
  storage: MemoryStorage,
  now = 2_000,
  overrides: Record<string, unknown> = {},
) {
  return {
    deposed: false,
    leaseManager: null,
    workflowClaimRegistry: null,
    options: {
      getNow: () => now,
      ownershipMode: 'none',
    },
    registrations: new Map(),
    storage,
    workflowStateWriteChains: new Map(),
    scheduleStateOperationChains: new Map(),
    ...overrides,
  } as never;
}

async function readWorkflowState(
  storage: MemoryStorage,
  workflowId: string,
): Promise<WorkflowState | null> {
  const bytes = await storage.get(KEYS.workflow(workflowId));
  return bytes === null ? null : (decode(bytes) as WorkflowState);
}

describe('attribute and tag helpers', () => {
  it('loads persisted attributes when cleaning indexes without an explicit attribute map', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    const workflowId = 'cleanup-attributes';
    const attributes = { customerId: 'cust-1', 'weft:status': 'completed' };

    await storage.put(KEYS.attribute(workflowId), encode(attributes));

    await cleanupAttributeIndex(internals, workflowId);
    expect(await storage.get(KEYS.attribute(workflowId))).toBeNull();

    await expect(cleanupAttributeIndex(internals, 'missing-attributes')).resolves.toBeUndefined();
  });

  it('returns false when tag mutation receives no runtime tags and removes the final tag on delete', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'mutate-tags';
    await storage.put(
      KEYS.workflow(workflowId),
      encode(createWorkflowState(workflowId, { tags: ['solo'] })),
    );

    const internals = createInternals(storage);

    await expect(
      mutateWorkflowTags(internals, workflowId, undefined as never, 'add'),
    ).resolves.toBe(false);
    await expect(mutateWorkflowTags(internals, workflowId, ['solo'], 'remove')).resolves.toBe(true);

    const updatedState = await readWorkflowState(storage, workflowId);
    expect(updatedState?.tags).toBeUndefined();
  });

  it('honors status-filter offsets and zero limits when bulk-mutating workflow tags', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);

    for (const workflowId of ['bulk-tag-a', 'bulk-tag-b', 'bulk-tag-c']) {
      await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));
    }

    await expect(
      bulkMutateWorkflowTags(internals, { status: 'completed', limit: 0 }, ['bulk'], 'add'),
    ).resolves.toEqual({ modified: 0 });

    await expect(
      bulkMutateWorkflowTags(
        internals,
        { status: 'completed', offset: 1, limit: 1 },
        ['bulk'],
        'add',
      ),
    ).resolves.toEqual({ modified: 1 });

    const bulkTagAState = await readWorkflowState(storage, 'bulk-tag-a');
    const bulkTagBState = await readWorkflowState(storage, 'bulk-tag-b');
    const bulkTagCState = await readWorkflowState(storage, 'bulk-tag-c');
    expect(bulkTagAState?.tags).toBeUndefined();
    expect(bulkTagBState?.tags).toEqual(['bulk']);
    expect(bulkTagCState?.tags).toBeUndefined();
  });

  it('stops snapshotting after the requested limit and rethrows non-not-found mutation failures', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);

    for (const workflowId of ['bulk-limit-a', 'bulk-limit-b', 'bulk-limit-c']) {
      await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));
    }

    await expect(
      bulkMutateWorkflowTags(internals, { status: 'completed', limit: 1 }, ['bulk'], 'add'),
    ).resolves.toEqual({ modified: 1 });
    const bulkLimitAState = await readWorkflowState(storage, 'bulk-limit-a');
    const bulkLimitBState = await readWorkflowState(storage, 'bulk-limit-b');
    expect(bulkLimitAState?.tags).toEqual(['bulk']);
    expect(bulkLimitBState?.tags).toBeUndefined();

    const explodingStorage = new MemoryStorage();
    const explodingInternals = createInternals(explodingStorage);
    await explodingStorage.put(
      KEYS.workflow('bulk-explode'),
      encode(createWorkflowState('bulk-explode')),
    );
    explodingStorage.get = async () => {
      throw new Error('unexpected read failure');
    };

    await expect(
      bulkMutateWorkflowTags(explodingInternals, { status: 'completed' }, ['bulk'], 'add', [
        'bulk-explode',
      ]),
    ).rejects.toThrow('unexpected read failure');
  });

  it('routes "category" to the matching ADR 0002 commit shape: "external-terminal" rotates wf-owner-epoch under workflow-lease, "self" fences on this engine\'s own (absent) claim and fails closed', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'update-workflow-state-category';
    await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));

    // No `workflowClaimRegistry` installed — mirrors today's un-wired state.
    // An EXTERNAL terminal transition never consults it, so it succeeds and
    // rotates the epoch; a SELF transition fences on this engine's own claim
    // and — holding none — fails closed immediately.
    const internals = createInternals(storage, 2_000, {
      options: { getNow: () => 2_000, ownershipMode: 'workflow-lease' },
      workflowClaimRegistry: null,
      pendingAtomicWorkflowCommitSideEffects: new Map(),
    });

    await expect(
      updateWorkflowState(internals, workflowId, { status: 'cancelled' }, 'external-terminal'),
    ).resolves.not.toBeNull();
    expect(decodeEpoch((await storage.get(KEYS.workflowOwnerEpoch(workflowId)))!)).toBe(1);

    await storage.put(
      KEYS.workflow(workflowId),
      encode(createWorkflowState(workflowId, { status: 'running' })),
    );
    await expect(
      updateWorkflowState(internals, workflowId, { status: 'failed' }, 'self'),
    ).rejects.toMatchObject({ code: 'EngineDeposedError' });
  });

  it('mutateWorkflowTags never rotates wf-owner-epoch — non-terminal external mutations do not end the run (ADR 0002)', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'mutate-tags-no-rotation';
    await storage.put(
      KEYS.workflow(workflowId),
      encode(createWorkflowState(workflowId, { tags: ['solo'] })),
    );
    const seededEpochBytes = encodeEpoch(7);
    await storage.put(KEYS.workflowOwnerEpoch(workflowId), seededEpochBytes);

    const internals = createInternals(storage, 2_000, {
      options: { getNow: () => 2_000, ownershipMode: 'workflow-lease' },
    });

    await expect(mutateWorkflowTags(internals, workflowId, ['solo'], 'remove')).resolves.toBe(true);

    expect(await storage.get(KEYS.workflowOwnerEpoch(workflowId))).toEqual(seededEpochBytes);
  });
});
