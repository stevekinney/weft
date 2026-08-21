/**
 * Shared "fold `acquire` into an enabling write" helper for ADR 0002's
 * CLAIM-ACQUIRING entry points this stage owns: workflow start
 * (`lifecycle/start-commit.ts` — the create batch), delayed-start timer fire
 * (`operations-time.ts`), and bulk retry reactivation (`bulk-operations.ts`).
 * Scheduled runs and child-workflow launches funnel through `startWorkflow`
 * (`lifecycle/start.ts`) and inherit the fold from there — see
 * [ADR 0002 § Entry point classification](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md#entry-point-classification),
 * the `startWorkflow`/`buildAndCommitStartBatch` row, which explicitly groups
 * `ctx.startChild` and `startScheduledRun` with it.
 *
 * A claim-acquiring write establishes a claim THIS commit has never held
 * before, so it can never be fenced through `commitFencedEngineWrite` (which
 * requires an ALREADY-tracked epoch in `EngineInternals.workflowClaimRegistry`
 * — see `fenced-write.ts`'s `fencedCommitForWorkflow`). Instead, the claim's
 * OWN `acquire` conditions (holder absent, epoch matches what was just read)
 * ARE the fence for this first write: {@link prepareWorkflowClaimFold} reads
 * fresh `wf-owner-epoch:<id>` bytes and builds the pure acquire fragment via
 * `WorkflowClaimRegistry.prepareAcquireFragment`, the caller merges the
 * fragment's conditions/operations into its own enabling write, and
 * {@link commitWithWorkflowClaimFold} commits ONE atomic
 * `storageConditionalBatch`. Only after that commit succeeds does it call
 * `WorkflowClaimRegistry.recordFoldedAcquire`, installing the tracking entry
 * every later `commitFencedEngineWrite` for this workflow needs.
 *
 * Under `ownership: 'none'`/`'lease'`, or `'workflow-lease'` with no registry
 * constructed yet (Gate 1/Gate 2 wiring is a parallel/later stage) —
 * {@link prepareWorkflowClaimFold} returns `undefined` and every caller's
 * pre-existing code path runs byte-for-byte unchanged. It also returns
 * `undefined` when this engine already tracks a claim for `workflowId`: bulk
 * retry folds `acquire` into its own reactivation write, then calls
 * `engine.resume()`, which must not attempt a second acquire for the same
 * workflow (see `lifecycle/resume.ts`).
 *
 * @module core/engine/workflow-claim-fold
 */

import {
  KEYS,
  requireStorageCapability,
  storageConditionalBatch,
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../storage/interface.ts';
import type { EngineInternals } from './internals.ts';
import { WorkflowClaimUnavailableError } from './lease-errors.ts';
import { decodeWorkflowClaimHolder } from './workflow-claim-codec.ts';
import type {
  WorkflowClaimAcquirePreparation,
  WorkflowClaimRegistry,
} from './workflow-claim-registry.ts';

/** A prepared, not-yet-committed claim-acquire fold for one workflow id. */
export type WorkflowClaimFold = {
  registry: WorkflowClaimRegistry;
  workflowId: string;
  preparation: WorkflowClaimAcquirePreparation;
  conditions: ConditionalBatchCondition[];
  operations: BatchOperation[];
};

/**
 * Prepare a claim-acquire fold for `workflowId`, or `undefined` when folding
 * does not apply — see the module doc for the three cases that return
 * `undefined`. Call again on every retry attempt of the caller's own
 * enabling-write loop; never reuse a preparation across attempts, since a
 * stale epoch read dooms the retry's CAS.
 */
export async function prepareWorkflowClaimFold(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowClaimFold | undefined> {
  if (internals.options.ownershipMode !== 'workflow-lease') return undefined;
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return undefined;
  if (registry.currentEpoch(workflowId) !== null) return undefined;
  const preparation = await registry.prepareAcquireFragment(workflowId);
  return {
    registry,
    workflowId,
    preparation,
    conditions: preparation.fragment.conditions,
    operations: preparation.fragment.operations,
  };
}

/** Outcome of {@link commitWithWorkflowClaimFold}. */
export type WorkflowClaimFoldCommitResult =
  | { status: 'committed' }
  | {
      status: 'lost-race';
      /** Whether the fold's OWN conditions (not the caller's) were the ones that lost the CAS. */
      claimConflict: boolean;
    };

/**
 * Commit `operations`/`conditions` merged with `fold`'s own acquire
 * fragment, as ONE atomic `storageConditionalBatch`. On success, installs
 * the fold's tracking entry via `WorkflowClaimRegistry.recordFoldedAcquire`.
 * On a lost CAS, re-reads the fold's own conditions to report whether THEY
 * were the ones that failed — distinct from the caller's own conditions
 * (idempotency mapping, workflow-concurrency admission) — so the caller can
 * raise `WorkflowClaimUnavailableError` instead of misreporting a claim loss
 * as an unrelated precondition conflict, or vice versa.
 */
export async function commitWithWorkflowClaimFold(
  internals: EngineInternals,
  fold: WorkflowClaimFold,
  operations: BatchOperation[],
  conditions: ConditionalBatchCondition[],
  featureName: string,
): Promise<WorkflowClaimFoldCommitResult> {
  requireStorageCapability(internals.storage, 'conditionalBatch', featureName);
  const committed = await storageConditionalBatch(
    internals.storage,
    [...conditions, ...fold.conditions],
    [...operations, ...fold.operations],
  );
  if (committed) {
    fold.registry.recordFoldedAcquire(fold.workflowId, fold.preparation);
    return { status: 'committed' };
  }
  return {
    status: 'lost-race',
    claimConflict: await hasWorkflowClaimFoldConflict(internals, fold),
  };
}

/**
 * Re-read each of `fold`'s own conditions and compare to its expected bytes,
 * to determine whether the fold's conditions (rather than some unrelated
 * caller precondition already merged into the same batch) are the ones a
 * lost CAS actually reflects.
 */
async function hasWorkflowClaimFoldConflict(
  internals: EngineInternals,
  fold: WorkflowClaimFold,
): Promise<boolean> {
  for (const condition of fold.conditions) {
    const currentValue = await internals.storage.get(condition.key);
    if (!storageValuesEqual(currentValue, condition.expectedValue)) {
      return true;
    }
  }
  return false;
}

/**
 * Re-read the current holder of `workflowId` and resolve its `engineId` —
 * `null` when the holder record is absent (e.g. concurrently released
 * between the lost CAS and this read) or undecodable.
 */
async function resolveWorkflowClaimHolder(
  internals: EngineInternals,
  workflowId: string,
): Promise<string | null> {
  const raw = await internals.storage.get(KEYS.workflowOwnerHolder(workflowId));
  if (raw === null) return null;
  return decodeWorkflowClaimHolder(raw)?.engineId ?? null;
}

/**
 * Raise `WorkflowClaimUnavailableError` for `workflowId`, re-reading its
 * current holder for the `heldBy` field — the shared shape every explicit,
 * single-workflow claim-acquiring call site (start, bulk retry reactivation)
 * uses on a confirmed claim conflict, instead of each repeating the
 * re-read-then-throw.
 */
export async function throwWorkflowClaimUnavailable(
  internals: EngineInternals,
  workflowId: string,
): Promise<never> {
  throw new WorkflowClaimUnavailableError(
    workflowId,
    await resolveWorkflowClaimHolder(internals, workflowId),
  );
}
