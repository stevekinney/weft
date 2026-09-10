import { describe, expect, it } from 'bun:test';

import { KEYS, type ConditionalBatchCondition } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { AtomicStateConflictError } from '../../atomic-state.ts';
import type { Checkpoint, WorkflowState } from '../../types.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
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

  it('reports a duplicate id ahead of the signal sentinel when both conditions conflict', async () => {
    // PR #959 review (P1). On a caller-supplied id the `start-precondition`
    // conditions are `startOrSignal`'s `sigres:` marker, not an idempotency mapping
    // — `id` and `idempotencyKey` are mutually exclusive. Raising the sentinel first
    // sends `startOrSignal` down its `signal-already-buffered` path, which under
    // `onTerminalConflict: 'start-new'` purges the concurrent winner and starts a
    // successor with no signal folded in, parking it forever. The duplicate id must
    // win the attribution so the caller converges onto the winner instead.
    const storage = new MemoryStorage();
    const context = createBaseContext(storage);
    const workflowKey = KEYS.workflow('workflow-start-commit');
    const signalCondition: ConditionalBatchCondition = {
      key: 'sigres:v1:workflow-start-commit:release:sig-race',
      expectedValue: null,
    };

    // BOTH conditions genuinely conflict: a concurrent winner created the run and
    // its start-signal was consumed.
    await storage.put(workflowKey, new Uint8Array([1]));
    await storage.put(signalCondition.key, new Uint8Array([2]));
    storage.conditionalBatch = async () => false;

    await expect(
      buildAndCommitStartBatch(
        {
          ...context,
          duplicateIdCondition: { key: workflowKey, expectedValue: null },
        } as never,
        () => ({ conditions: [signalCondition], operations: [] }),
      ),
    ).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);
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

  it('fails closed when a lost batch shows no retryable cause at all', async () => {
    // Both base conditions still match on re-read, so nothing retryable explains the
    // miss. Attribution must not invent a retry; it reports the duplicate id, which
    // is public, non-destructive, and retryable by the caller.
    //
    // Note this deliberately does NOT model "a winner acquired and released the
    // concurrency slot": that condition is a monotonic atomic-state VERSION key
    // (`buildWorkflowConcurrencyStartOperations` conditions on `snapshot.version`
    // and writes `version + 1`; release increments again), so it can never return to
    // the loser's expected value. An earlier revision of this test asserted exactly
    // that impossible state — see the sibling test below for the real shape.
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
    ).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);
  });

  it('retries admission only on positive evidence that concurrency is what missed', async () => {
    // The retryable shape, modelled the way production actually looks: the
    // concurrency condition is a monotonic atomic-state version key, so once it has
    // moved it stays mismatched. Retrying is safe here only because the caller's
    // earlier positive duplicate-id check already ran and found the workflow record
    // still matching — the id is free right now, so the retry re-conditions on that
    // same value and ends in the public `AtomicStateConflictError` rather than
    // committing a second run. The purged-winner residual is WFT-153.
    const storage = new MemoryStorage();
    const context = createBaseContext(storage);
    const workflowKey = KEYS.workflow('workflow-start-commit');
    await storage.put('workflow-concurrency', new Uint8Array([7]));
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

  it('fails closed with WorkflowRevisionUnavailableError when a workflow-concurrency retry re-reads a catalog entry a concurrent removal already deleted', async () => {
    // WFT-17 (Codex review on PR #958): `buildCatalogEntryStartPrecondition()`
    // re-reads the catalog entry FRESH every loop attempt. Attempt 0 finds it
    // still installed, loses its CAS for an unrelated (workflow-concurrency)
    // reason, and retries; by attempt 1 a concurrent `removeWorkflowRevision()`
    // has already deleted it, so this attempt's read finds nothing and throws
    // immediately — the "already gone before this attempt even builds a
    // precondition" case, distinct from `hasCatalogEntryConflict()`'s
    // after-the-fact CAS-loss re-check (covered by the catalog-removal.test.ts
    // race test).
    const storage = new MemoryStorage();
    const entryKey = KEYS.catalogEntry('workflow', 'rev-1');
    const entryBytes = new Uint8Array([9]);
    await storage.put(entryKey, entryBytes);

    let entryReads = 0;
    const originalGet = storage.get.bind(storage);
    storage.get = async (key: string) => {
      if (key === entryKey) {
        entryReads += 1;
        // Reads 1-2 are attempt 0's precondition build and its post-conflict
        // catalog-entry re-check — both still find the entry. Read 3 is
        // attempt 1's fresh precondition build, after the simulated
        // concurrent removal.
        return entryReads <= 2 ? entryBytes : null;
      }
      return originalGet(key);
    };
    storage.conditionalBatch = async () => false;

    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'test-engine',
      getNow: () => Date.now(),
      claimTtlMs: 30_000,
      claimRenewIntervalMs: 5_000,
    });
    const context = {
      ...createBaseContext(storage),
      state: createWorkflowState({ id: 'workflow-start-commit', revision: 'rev-1' }),
      internals: {
        deposed: false,
        leaseManager: null,
        options: { ownershipMode: 'workflow-lease' },
        storage,
        workflowClaimRegistry: registry,
      } as never,
    };

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
    ).rejects.toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect(entryReads).toBe(3);
    await expect(storage.get(`wf:${context.workflowId}`)).resolves.toBeNull();
  });
});
