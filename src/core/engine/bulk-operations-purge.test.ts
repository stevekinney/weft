import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import {
  clearPurgedWorkflowInMemoryState,
  collectWorkflowPurgeDeleteOperations,
  purgeInternal,
  purgeWorkflow,
} from './bulk-operations-purge.ts';
import { encodeEpoch } from './lease-codec.ts';
import { createTerminalCleanupTimerId } from './state-utilities.ts';
import { decodeEpoch, encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

function createWorkflowState(
  workflowId: string,
  updatedAt: number,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: updatedAt,
    id: workflowId,
    input: null,
    result: 'done',
    startedAt: updatedAt,
    status: 'completed',
    type: 'workflow',
    updatedAt,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

function createInternals(
  storage: MemoryStorage,
  now = 10_000,
  ownershipMode: 'none' | 'lease' | 'workflow-lease' = 'none',
) {
  return {
    checkpoints: new Map(),
    deposed: false,
    eventLogHeads: new Map(),
    handleCache: new Map(),
    heartbeatDetails: new Map(),
    lastHeartbeatDetailsByStep: new Map(),
    leaseManager: null,
    workflowClaimRegistry: null,
    options: {
      getNow: () => now,
      ownershipMode,
      retention: undefined,
    },
    pendingAsyncActivities: new Map(),
    pendingAsyncActivityResolutions: new Map(),
    registrations: new Map(),
    resultResolvers: new Map(),
    storage,
    workflowHeaders: new Map(),
    workflowNestingDepths: new Map(),
    workflowTypeByWorkflowId: new Map(),
    workflowVersionTuples: new Map(),
  } as never;
}

describe('bulk purge helpers', () => {
  it('removes pending async activities for the purged workflow only', () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage) as {
      pendingAsyncActivities: Map<string, { workflowId: string }>;
    };

    internals.pendingAsyncActivities.set('token-a', { workflowId: 'purged-workflow' });
    internals.pendingAsyncActivities.set('token-b', { workflowId: 'other-workflow' });

    clearPurgedWorkflowInMemoryState(internals as never, 'purged-workflow', () => {});

    expect(internals.pendingAsyncActivities.has('token-a')).toBe(false);
    expect(internals.pendingAsyncActivities.has('token-b')).toBe(true);
  });

  it('applies the smaller of the filter limit and fallback limit during purge', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);

    for (const [index, workflowId] of ['purge-a', 'purge-b', 'purge-c'].entries()) {
      const updatedAt = 1_000 + index;
      await storage.put(
        KEYS.workflow(workflowId),
        encode(createWorkflowState(workflowId, updatedAt)),
      );
      await storage.put(KEYS.terminalWorkflow(updatedAt, workflowId), new Uint8Array());
    }

    const result = await purgeInternal(
      internals,
      { status: 'completed', limit: 2 },
      { expiredOnly: false, now: 10_000, limit: 1 },
      () => {},
    );

    expect(result).toEqual({ deleted: 1 });
  });

  it('deletes workflow-linked fleet events during purge', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    const purgedWorkflowId = 'purge-fleet-event';
    await storage.put(
      KEYS.workflow(purgedWorkflowId),
      encode(createWorkflowState(purgedWorkflowId, 1_000)),
    );
    await storage.put(KEYS.terminalWorkflow(1_000, purgedWorkflowId), new Uint8Array());
    await storage.put(
      KEYS.fleetEvent(0),
      encode({
        kind: 'workflow:completed',
        workflowId: purgedWorkflowId,
        sequence: 0,
        cursor: '0',
        emittedAtMs: 1_000,
        payload: { workflowId: purgedWorkflowId, result: 'secret' },
      }),
    );
    await storage.put(KEYS.fleetEventByWorkflow(purgedWorkflowId, 0), new Uint8Array());
    await storage.put(
      KEYS.fleetEvent(1),
      encode({
        kind: 'workflow:completed',
        workflowId: 'other-workflow',
        sequence: 1,
        cursor: '1',
        emittedAtMs: 1_001,
        payload: { workflowId: purgedWorkflowId, result: 'kept' },
      }),
    );
    await storage.put(KEYS.fleetEventByWorkflow('other-workflow', 1), new Uint8Array());
    await storage.put(KEYS.fleetEvent(2), Uint8Array.of(0xc1));

    const result = await purgeInternal(
      internals,
      { status: 'completed' },
      { expiredOnly: false, now: 10_000 },
      () => {},
    );

    expect(result).toEqual({ deleted: 1 });
    expect(await storage.get(KEYS.fleetEvent(0))).toBeNull();
    expect(await storage.get(KEYS.fleetEventByWorkflow(purgedWorkflowId, 0))).toBeNull();
    expect(await storage.get(KEYS.fleetEvent(1))).not.toBeNull();
    expect(await storage.get(KEYS.fleetEventByWorkflow('other-workflow', 1))).not.toBeNull();
    expect(await storage.get(KEYS.fleetEvent(2))).not.toBeNull();
  });

  it('collects deadline, terminal-cleanup, and update-response delete keys', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    const state = createWorkflowState('purge-delete-keys', 2_000, {
      executionDeadline: 2_500,
      status: 'cancelled',
      terminalCleanupToken: 'cleanup-token',
    });

    await storage.put(KEYS.update(state.id, 'update-a'), encode({ updateId: 'update-a' }));
    await storage.put(KEYS.update(state.id, ''), encode({ updateId: '' }));

    const operations = await collectWorkflowPurgeDeleteOperations(internals, state);
    const deleteKeys = new Set(
      operations
        .filter((operation) => operation.type === 'delete')
        .map((operation) => operation.key),
    );
    const terminalCleanupKey = KEYS.terminalCleanup(
      state.updatedAt + 60_000,
      createTerminalCleanupTimerId(true, state.terminalCleanupToken!),
    );

    expect(deleteKeys.has(KEYS.deadline(state.executionDeadline!, state.id))).toBe(true);
    expect(deleteKeys.has(`timer-idx:deadline:${state.id}`)).toBe(true);
    expect(deleteKeys.has(terminalCleanupKey)).toBe(true);
    expect(deleteKeys.has(KEYS.update(state.id, 'update-a'))).toBe(true);
    expect(deleteKeys.has(KEYS.updateResponse('update-a'))).toBe(true);
    expect(deleteKeys.has(KEYS.updateResponse(''))).toBe(false);
    expect(deleteKeys.has(KEYS.teardownSucceeded(state.id))).toBe(true);
    expect(deleteKeys.has(KEYS.teardownDeadLetter(state.id))).toBe(false);
  });

  it('surfaces lost lease preconditions while purging a workflow', async () => {
    const storage = new MemoryStorage();
    const epochBytes = encodeEpoch(1);
    const state = createWorkflowState('purge-precondition-loss', 2_000);
    await storage.put(KEYS.leaseEpoch(), epochBytes);
    storage.conditionalBatch = async () => false;
    const internals = createInternals(storage) as {
      deposed: boolean;
      leaseManager?: { currentEpochBytes: () => Uint8Array } | null;
      options: { getNow: () => number; ownershipMode: 'none' | 'lease'; retention?: undefined };
      storage: MemoryStorage;
      tearDownAfterDeposition?: null;
    };
    internals.leaseManager = { currentEpochBytes: () => epochBytes };
    internals.options = {
      getNow: () => 10_000,
      ownershipMode: 'lease',
      retention: undefined,
    };
    internals.tearDownAfterDeposition = null;

    await expect(purgeWorkflow(internals as never, state, () => {})).rejects.toThrow(
      `Purge commit for workflow "${state.id}" lost its precondition.`,
    );
  });

  it('purgeWorkflow under "workflow-lease" rotates wf-owner-epoch and deletes wf-owner-holder (ADR 0002, "intentionally external")', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage, 10_000, 'workflow-lease');
    const state = createWorkflowState('purge-rotation', 3_000);
    await storage.put(KEYS.workflow(state.id), encode(state));
    await storage.put(KEYS.workflowOwnerEpoch(state.id), encodeEpoch(4));
    await storage.put(
      KEYS.workflowOwnerHolder(state.id),
      encodeWorkflowClaimHolder({
        engineId: 'stale-owner',
        epoch: 4,
        expiresAt: 999_999,
        claimedAt: 1_000,
      }),
    );

    await purgeWorkflow(internals, state, () => {});

    const rotatedEpoch = decodeEpoch((await storage.get(KEYS.workflowOwnerEpoch(state.id)))!);
    expect(rotatedEpoch).toBe(5);
    expect(await storage.get(KEYS.workflowOwnerHolder(state.id))).toBeNull();
  });

  it('purgeWorkflow under "none" leaves wf-owner-epoch untouched (byte-for-byte unchanged)', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    const state = createWorkflowState('purge-no-rotation', 3_000);
    await storage.put(KEYS.workflow(state.id), encode(state));

    await purgeWorkflow(internals, state, () => {});

    expect(await storage.get(KEYS.workflowOwnerEpoch(state.id))).toBeNull();
  });
});
