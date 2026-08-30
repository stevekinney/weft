/**
 * ADR 0002 row `reactivateFailedWorkflowFromCheckpoint` → `engine.resume`
 * (bulk retry): claim-acquiring. `bulk-operations-retry-direct.test.ts`
 * exercises `retryFailedAll` under `ownership: 'none'`; this file isolates
 * the `commitFailedWorkflowReactivation` claim-fold branch under
 * `ownership: 'workflow-lease'`, using the SAME lightweight
 * manually-constructed-`internals` pattern (a real `WorkflowClaimRegistry`
 * dropped in directly, `internals.engine.resume` mocked so this file stays
 * scoped to the reactivation write and does not re-exercise
 * `lifecycle/resume.ts`, which has its own coverage).
 */
import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { serializeCheckpoint } from '../checkpoint/serialization.ts';
import { encode } from '../codec.ts';
import type { Checkpoint, WorkflowState } from '../types.ts';
import { retryFailedAll } from './bulk-operations.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

function createFailedState(workflowId: string): WorkflowState {
  return {
    createdAt: 1_000,
    error: 'failed',
    id: workflowId,
    input: { workflowId },
    startedAt: 1_000,
    status: 'failed',
    type: 'retryable',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
  };
}

function createCheckpoint(workflowId: string): Checkpoint {
  return {
    accumulatedResults: [],
    createdAt: 1_000,
    locals: {},
    schemaVersion: 2,
    searchAttributes: {},
    step: 0,
    version: '1',
    workflowId,
  };
}

function createInternals(storage: MemoryStorage, registry: WorkflowClaimRegistry | null) {
  return {
    deposed: false,
    engine: {
      resume: mock(async () => {}),
      start: mock(async () => ({ id: 'started' })),
    },
    leaseManager: null,
    options: { getNow: () => 2_000, ownershipMode: 'workflow-lease' },
    registrations: new Map([['retryable', { handler: async function* () {}, version: '1' }]]),
    scheduler: { cancel: mock(async () => {}) },
    storage,
    workflowClaimRegistry: registry,
    workflowStateWriteChains: new Map(),
    scheduleStateOperationChains: new Map(),
  } as never;
}

async function seedFailedWorkflow(storage: MemoryStorage, workflowId: string): Promise<void> {
  await storage.put(KEYS.workflow(workflowId), encode(createFailedState(workflowId)));
  await storage.put(KEYS.checkpoint(workflowId), serializeCheckpoint(createCheckpoint(workflowId)));
}

describe('bulk-operations.ts: retryFailedAll folds acquire() under workflow-lease', () => {
  it('reactivates a failed workflow and records the folded claim', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'bulk-retry-fold-success';
    await seedFailedWorkflow(storage, workflowId);
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: () => 2_000,
      claimTtlMs: 60_000,
      claimRenewIntervalMs: 5_000,
    });
    const internals = createInternals(storage, registry);

    const result = await retryFailedAll(internals, { status: 'failed' });

    expect(result).toEqual({ retried: 1, failed: 0, errors: [] });
    expect(registry.currentEpoch(workflowId)).toBe(1);
    expect(
      (internals as { engine: { resume: (id: string) => Promise<void> } }).engine.resume,
    ).toHaveBeenCalledWith(workflowId);
  });

  it('reports WorkflowClaimUnavailableError as a per-item bulk error, without retrying admission, when another engine already holds the claim', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'bulk-retry-fold-contested';
    await seedFailedWorkflow(storage, workflowId);

    const competitor = new WorkflowClaimRegistry({
      storage,
      engineId: 'ghost-engine',
      getNow: () => 2_000,
      claimTtlMs: 60_000,
      claimRenewIntervalMs: 5_000,
    });
    const competitorAcquireResult = await competitor.acquire(workflowId);
    expect(competitorAcquireResult.status).toBe('acquired');

    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'engine-a',
      getNow: () => 2_000,
      claimTtlMs: 60_000,
      claimRenewIntervalMs: 5_000,
    });
    const internals = createInternals(storage, registry);

    const result = await retryFailedAll(internals, { status: 'failed' });

    expect(result.retried).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.id).toBe(workflowId);
    expect(result.errors[0]?.error).toContain('Could not acquire the ownership claim for workflow');
    // The loser never acquired a claim for this workflow.
    expect(registry.currentEpoch(workflowId)).toBeNull();
    expect(
      (internals as { engine: { resume: (id: string) => Promise<void> } }).engine.resume,
    ).not.toHaveBeenCalled();
  });
});
