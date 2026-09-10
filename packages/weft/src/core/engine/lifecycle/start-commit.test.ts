import { describe, expect, it } from 'bun:test';

import type { ConditionalBatchCondition } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { AtomicStateConflictError } from '../../atomic-state.ts';
import type { Checkpoint, WorkflowState } from '../../types.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import { WorkflowClaimRegistry } from '../workflow-claim-registry.ts';
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
    // These cases exercise the idempotency and workflow-concurrency conditions in
    // isolation; the duplicate-id condition has its own coverage in
    // `start-duplicate-id-race.test.ts`.
    duplicateIdCondition: undefined,
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
        },
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
        },
        () => ({
          conditions: [condition],
          operations: [],
        }),
      ),
    ).rejects.toThrow('start idempotency compare-and-swap lost to a concurrent caller');
  });

  it('attributes a lost duplicate-id CAS by elimination, even when the winner was purged', async () => {
    // The purge race Codex flagged on #959: the winning run can complete and be
    // purged (or swept by retention) between this start's failed compare-and-swap
    // and any diagnostic re-read, restoring `wf:<id>` to exactly the value the
    // condition expected. Re-reading would then see "no conflict" and leak the
    // internal `StartIdempotencyRaceLostError`, which is documented as never
    // reaching a caller. With no concurrency conditions in the batch, the
    // duplicate-id condition is the only base condition there was, so the lost
    // outcome alone is proof - no read required.
    const storage = new MemoryStorage();
    const context = createBaseContext(storage);
    const workflowKey = KEYS.workflow('workflow-start-commit');

    // Storage agrees with the condition (key absent) - as it would after a purge.
    storage.conditionalBatch = async () => false;

    await expect(
      buildAndCommitStartBatch(
        { ...context, duplicateIdCondition: { key: workflowKey, expectedValue: null } } as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);
  });

  it('still reports a duplicate id when concurrency admission is also present', async () => {
    // Both kinds of base condition present, so the outcome alone cannot say which
    // missed and the duplicate-id key is re-read to disambiguate.
    const storage = new MemoryStorage();
    const context = createBaseContext(storage);
    const workflowKey = KEYS.workflow('workflow-start-commit');
    await storage.put(workflowKey, new Uint8Array([9]));
    storage.conditionalBatch = async () => false;

    await expect(
      buildAndCommitStartBatch(
        {
          ...context,
          duplicateIdCondition: { key: workflowKey, expectedValue: null },
          buildWorkflowConcurrencyStartOperations: async () => ({
            conditions: [{ key: 'workflow-concurrency', expectedValue: null }],
            operations: [],
            stateKey: 'workflow-concurrency',
          }),
        } as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);
  });

  it('retries admission when the duplicate id is intact and only concurrency missed', async () => {
    // The complement of the case above: the duplicate-id key still matches, so the
    // miss belongs to concurrency admission, which is retryable - the start must
    // fall through to the retry loop and end in the public `AtomicStateConflictError`
    // rather than being misreported as a duplicate id.
    const storage = new MemoryStorage();
    const context = createBaseContext(storage);
    const workflowKey = KEYS.workflow('workflow-start-commit');
    storage.conditionalBatch = async () => false;

    await expect(
      buildAndCommitStartBatch(
        {
          ...context,
          duplicateIdCondition: { key: workflowKey, expectedValue: null },
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

  it('ADR 0002: folds acquire() into an idempotent start batch under ownership: "workflow-lease"', async () => {
    const storage = new MemoryStorage();
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'test-engine',
      getNow: () => Date.now(),
      claimTtlMs: 30_000,
      claimRenewIntervalMs: 5_000,
    });
    const context = {
      ...createBaseContext(storage),
      internals: {
        deposed: false,
        leaseManager: null,
        options: { ownershipMode: 'workflow-lease' },
        storage,
        workflowClaimRegistry: registry,
      } as never,
    };
    const idempotentCondition: ConditionalBatchCondition = {
      key: 'start-idempotent-precondition',
      expectedValue: null,
    };

    // A non-empty idempotency precondition alongside the claim fold exercises
    // `persistStartBatch`'s claimFold branch merging CALLER conditions (not
    // just the fold's own), distinct from an ordinary claimed start with no
    // preconditions.
    await expect(
      buildAndCommitStartBatch(context as never, () => ({
        conditions: [idempotentCondition],
        operations: [{ type: 'put', key: 'start-idempotent-mapping', value: new Uint8Array([1]) }],
      })),
    ).resolves.toBeUndefined();

    await expect(storage.get(`wf:${context.workflowId}`)).resolves.not.toBeNull();
    await expect(storage.get('start-idempotent-mapping')).resolves.toEqual(new Uint8Array([1]));
    expect(registry.currentEpoch(context.workflowId)).toBe(1);
  });
});
