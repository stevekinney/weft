import { describe, expect, it } from 'bun:test';

import type { ConditionalBatchCondition } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { AtomicStateConflictError } from '../../atomic-state.ts';
import type { Checkpoint, WorkflowState } from '../../types.ts';
import { buildAndCommitStartBatch } from './start-commit.ts';

function createWorkflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    createdAt: 1_000,
    id: 'workflow-start-commit',
    input: null,
    startedAt: 1_000,
    status: 'running',
    type: 'workflow',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
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

function createBaseContext(storage: MemoryStorage) {
  const workflowId = 'workflow-start-commit';
  return {
    workflowId,
    checkpoint: createCheckpoint(workflowId),
    state: createWorkflowState({ id: workflowId }),
    registration: {
      handler: async function* () {},
      version: '1',
    },
    options: undefined,
    delayedStartTimer: undefined,
    persistedWorkflowStartHeaders: undefined,
    additionalStartOperations: undefined,
    purgeDeleteOperations: undefined,
    callbacks: {} as never,
    internals: {
      deposed: false,
      leaseManager: null,
      options: {
        ownershipMode: 'none',
      },
      storage,
    } as never,
  };
}

describe('start-commit lifecycle helpers', () => {
  it('commits an unfenced start batch immediately when no preconditions are present', async () => {
    const storage = new MemoryStorage();
    const context = {
      ...createBaseContext(storage),
      additionalStartOperations: [
        { type: 'put' as const, key: 'start-additional', value: new Uint8Array([1]) },
      ],
    };

    await expect(
      buildAndCommitStartBatch(context as never, () => ({
        conditions: [],
        operations: [{ type: 'put', key: 'start-idempotent', value: new Uint8Array([2]) }],
      })),
    ).resolves.toBeUndefined();
    await expect(storage.get(`wf:${context.workflowId}`)).resolves.not.toBeNull();
    await expect(storage.get('start-additional')).resolves.toEqual(new Uint8Array([1]));
    await expect(storage.get('start-idempotent')).resolves.toEqual(new Uint8Array([2]));
  });

  it('throws the idempotency sentinel when a start precondition loses its race without concurrency admission', async () => {
    const storage = new MemoryStorage();
    const context = createBaseContext(storage);
    const expectedValue = new Uint8Array([1]);
    const condition: ConditionalBatchCondition = {
      key: 'start-precondition',
      expectedValue,
    };

    await storage.put(condition.key, expectedValue);
    storage.conditionalBatch = async () => false;

    await expect(
      buildAndCommitStartBatch(context as never, () => ({
        conditions: [condition],
        operations: [],
      })),
    ).rejects.toThrow('start idempotency compare-and-swap lost to a concurrent caller');
  });

  it('exhausts workflow-concurrency retries when only concurrency conditions keep losing', async () => {
    const storage = new MemoryStorage();
    const context = createBaseContext(storage);

    storage.conditionalBatch = async () => false;

    await expect(
      buildAndCommitStartBatch(
        {
          ...context,
          buildWorkflowConcurrencyStartOperations: async () => ({
            conditions: [{ key: 'workflow-concurrency', expectedValue: null }],
            operations: [],
            stateKey: 'workflow-concurrency',
          }),
        } as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(AtomicStateConflictError);
  });

  it('treats a lost start precondition as an idempotency race even when concurrency admission is also present', async () => {
    const storage = new MemoryStorage();
    const context = createBaseContext(storage);
    const expectedValue = new Uint8Array([1]);
    const condition: ConditionalBatchCondition = {
      key: 'start-precondition-conflict',
      expectedValue,
    };

    await storage.put(condition.key, new Uint8Array([2]));
    storage.conditionalBatch = async () => false;

    await expect(
      buildAndCommitStartBatch(
        {
          ...context,
          buildWorkflowConcurrencyStartOperations: async () => ({
            conditions: [{ key: 'workflow-concurrency', expectedValue: null }],
            operations: [],
            stateKey: 'workflow-concurrency',
          }),
        } as never,
        () => ({
          conditions: [condition],
          operations: [],
        }),
      ),
    ).rejects.toThrow('start idempotency compare-and-swap lost to a concurrent caller');
  });
});
