import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decode, encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import {
  bulkMutateWorkflowTags,
  cleanupAttributeIndex,
  mutateWorkflowTags,
} from './attributes-tags.ts';

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

function createInternals(storage: MemoryStorage, now = 2_000) {
  return {
    deposed: false,
    leaseManager: null,
    options: {
      getNow: () => now,
      ownershipMode: 'none',
    },
    registrations: new Map(),
    storage,
    workflowStateWriteChains: new Map(),
    scheduleStateOperationChains: new Map(),
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
});
