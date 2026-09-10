import {
  KEYS,
  requireStorageCapability,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../storage/interface.ts';
import { assertScopedBulkWorkflowFilter } from '../bulk-workflow-filter.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { decode, encode } from '../codec.ts';
import { buildTimerBatchOperations } from '../scheduler.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type {
  BulkOperationDryRunResult,
  BulkOperationError,
  BulkOperationOptions,
  BulkRetryFailedResult,
  Checkpoint,
  ListFilter,
  SearchAttributeValue,
  WorkflowState,
  WorkflowStatus,
} from '../types.ts';
import { buildTerminalWorkflowIndexOperations } from './attributes-tags.ts';
import {
  buildActionableBulkWorkflowFilter,
  normalizeBulkOperationOptions,
  prepareBulkOperation,
  resolveBulkOperationConcurrency,
  runBulkWorkflowPool,
  shouldPersistBulkAudit,
  toBulkOperationError,
  validateBulkConfirmation,
  withBulkAuditEvent,
} from './bulk-operations-shared.ts';
import { ensureWorkflowCatalogReady, isWorkflowCatalogReady } from './catalog-readiness.ts';
import { resolveExecutableRegistrationForRetry } from './dynamic-source-execution.ts';
import {
  assertLeaseHeldForEngineWork,
  commitFencedEngineWriteAllowingPreconditionFailure,
} from './fenced-write.ts';
import type { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import { startWorkflow, type LifecycleCallbacks } from './lifecycle.ts';
import { buildCatalogEntryRevisionCondition } from './lifecycle/start-commit.ts';
import { createTerminalCleanupTimerId } from './state-utilities.ts';
import { loadWorkflowState, runSerializedWorkflowStateWrite } from './storage-io.ts';
import { decodeWorkflowState } from './validation.ts';
import {
  commitWithWorkflowClaimFold,
  prepareWorkflowClaimFold,
  throwWorkflowClaimUnavailable,
} from './workflow-claim-fold.ts';
import { buildWorkflowConcurrencyStartOperations } from './workflow-concurrency.ts';
import { buildWorkflowVisibilityIndexTransition } from './workflow-indexes.ts';

const FAILED_WORKFLOW_STATUSES: WorkflowStatus[] = ['failed'];
const CHECKPOINT_RETRY_CONCURRENCY_ADMISSION_MAX_ATTEMPTS = 5;

/**
 * `bulkOperations.ts`'s `retryFailedAll()` implementation, split into its
 * own module (with the rest of the retry-failed cluster below) to keep
 * `bulk-operations.ts` under the 800-line implementation-file ceiling —
 * the same reason `bulk-operations-purge.ts` was split out earlier.
 */
export async function runBulkFailedWorkflowRetry(
  internals: EngineInternals,
  filter: ListFilter,
  options: BulkOperationOptions = {},
  /**
   * Threaded down from `Engine#retryFailedAll()`'s own `#createLifecycleCallbacks()`
   * (WFT-95 issue 2 follow-up). Needed only by `retryFailedWorkflow()`'s
   * checkpoint-absent fallback, which must call the internal `startWorkflow()`
   * directly (see its doc comment) rather than the public `engine.start()`.
   * Sourced this way — as a parameter, rather than this module importing
   * `createLifecycleCallbacks` from `callback-creators-core.ts` itself — to avoid
   * introducing a `bulk-operations-retry.ts` -> `callback-creators-core.ts` ->
   * `termination.ts` -> `termination/complete.ts` -> `bulk-operations.ts` ->
   * `bulk-operations-retry.ts` import cycle. Optional so direct-internals test
   * harnesses that never reach the checkpoint-absent fallback (e.g.
   * `bulk-operations-retry-direct.test.ts`) do not need to construct one.
   */
  callbacks?: LifecycleCallbacks,
): Promise<BulkRetryFailedResult | BulkOperationDryRunResult> {
  options = normalizeBulkOperationOptions(options);
  assertScopedBulkWorkflowFilter(filter);
  const actionableFilter = buildActionableBulkWorkflowFilter(
    internals,
    filter,
    FAILED_WORKFLOW_STATUSES,
  );
  const preparation = await prepareBulkOperation(
    internals,
    'retry-failed',
    actionableFilter,
    filter,
    {},
    options,
  );
  if (options.dryRun === true) return preparation.preview;

  validateBulkConfirmation(options, preparation);
  const bulkConcurrency = resolveBulkOperationConcurrency(options);
  let retried = 0;
  const errors: BulkOperationError[] = [];

  const retryResults = await runBulkWorkflowPool(
    preparation.workflowIds,
    bulkConcurrency,
    async (workflowId) => {
      await retryFailedWorkflow(internals, workflowId, callbacks);
      return { status: 'retried' as const };
    },
  );

  for (const retryResult of retryResults) {
    if (retryResult.status === 'rejected') {
      errors.push(toBulkOperationError(internals, retryResult.item, retryResult.reason));
      continue;
    }

    retried += 1;
  }

  const result: BulkRetryFailedResult = { retried, failed: errors.length, errors };
  if (!shouldPersistBulkAudit(options)) return result;
  return withBulkAuditEvent(internals, preparation, options, result, retried);
}

async function retryFailedWorkflow(
  internals: EngineInternals,
  workflowId: string,
  callbacks: LifecycleCallbacks | undefined,
): Promise<void> {
  const state = await loadWorkflowState(internals, workflowId);
  if (state === null) {
    throw new Error('Workflow no longer exists');
  }
  if (state.status !== 'failed') {
    throw new Error(`Workflow is ${state.status}, not failed`);
  }

  const checkpointBytes = await internals.storage.get(KEYS.checkpoint(workflowId));
  if (checkpointBytes !== null) {
    await reactivateFailedWorkflowFromCheckpoint(internals, state);
    await internals.engine.resume(workflowId);
    return;
  }

  const restartOptions = {
    id: workflowId,
    onTerminalConflict: 'start-new' as const,
    ...(state.tags !== undefined ? { tags: state.tags } : {}),
  };

  if (callbacks === undefined) {
    // No `LifecycleCallbacks` available (a direct-internals caller that never
    // constructed one, e.g. a test harness) — fall back to the pre-WFT-95
    // public `engine.start()` path, which enforces strict `.`/`..` admission.
    // Every production caller (`Engine#retryFailedAll()`) supplies `callbacks`
    // and takes the branch below instead.
    await internals.engine.start(state.type, state.input, restartOptions);
    return;
  }

  // Internal replay call site #3 (WFT-95), alongside schedule drain and child
  // reattach: this rebuilds an already-persisted, already-validated-at-the-time
  // `workflowId` from its stored input via `onTerminalConflict: 'start-new'`,
  // which is INTENDED to purge-then-replace the KNOWN terminal record loaded
  // above rather than speculatively match one. A pre-WFT-95 failed workflow
  // whose id is "." or ".." and whose checkpoint is absent must still be
  // retryable through this fallback, so this calls the internal
  // `startWorkflow` directly instead of the public `engine.start()`, which
  // enforces strict admission.
  //
  // The `loadWorkflowState()` read above and `startWorkflow`'s own atomic
  // `resolveTerminalConflictForRestart()` read are NOT the same read (WFT-95
  // TOCTOU follow-up, chatgpt-codex-connector review): under
  // `ownership: 'workflow-lease'`, another engine can purge this exact record
  // in the window between them, and an unconditional bypass would then let
  // `startWorkflow`'s fresh-create branch silently admit a reserved `.`/`..`
  // id. `'bulk-retry-only'` — not `true` — fences the bypass to
  // `resolveTerminalConflictForRestart()` actually finding the SAME terminal
  // record still there to purge-and-replace: if the race means it is gone,
  // `enforceReplayOnlyIdFence()` re-runs strict admission instead (see its
  // doc comment for the shared mechanism this shares with child-reattach's
  // `'reattach-only'` fence).
  //
  // `engine.start()` and `engine.resume()` (used by the checkpoint-backed
  // branch above) both assert the lease is held and the workflow catalog is
  // ready before doing anything else. Bypassing `engine.start()` here must not
  // silently drop those preconditions, so they are re-asserted explicitly.
  assertLeaseHeldForEngineWork(internals);
  if (!isWorkflowCatalogReady(internals.engine as unknown as Engine)) {
    await ensureWorkflowCatalogReady(internals.engine as unknown as Engine);
  }
  await startWorkflow(
    internals,
    state.type,
    state.input,
    restartOptions,
    undefined,
    callbacks,
    undefined,
    undefined,
    'bulk-retry-only',
  );
}

type ReactivatedFailedWorkflow = {
  terminalCleanupTimerId: string | undefined;
};

async function reactivateFailedWorkflowFromCheckpoint(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<void> {
  const reactivated = await runSerializedWorkflowStateWrite(internals, state.id, async () =>
    reactivateFailedWorkflowFromCheckpointSerialized(internals, state.id),
  );

  if (reactivated.terminalCleanupTimerId !== undefined) {
    await internals.scheduler.cancel(reactivated.terminalCleanupTimerId, state.id);
  }
}

async function reactivateFailedWorkflowFromCheckpointSerialized(
  internals: EngineInternals,
  workflowId: string,
): Promise<ReactivatedFailedWorkflow> {
  let lastConcurrencyStateKey: string | undefined;

  for (
    let attempt = 0;
    attempt < CHECKPOINT_RETRY_CONCURRENCY_ADMISSION_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const { currentState, checkpoint } = await loadFailedWorkflowForReactivation(
      internals,
      workflowId,
    );
    const commit = await buildReactivationCommit(internals, workflowId, currentState, checkpoint);
    lastConcurrencyStateKey = commit.concurrencyStateKey ?? lastConcurrencyStateKey;

    const committed = await commitFailedWorkflowReactivation(
      internals,
      workflowId,
      commit.operations,
      commit.conditions,
    );

    if (committed) {
      return {
        terminalCleanupTimerId:
          currentState.terminalCleanupToken === undefined
            ? undefined
            : createTerminalCleanupTimerId(false, currentState.terminalCleanupToken),
      };
    }
  }

  throw new Error(
    `Workflow concurrency admission for "${lastConcurrencyStateKey ?? workflowId}" changed too many times while retrying failed workflow "${workflowId}"`,
  );
}

type LoadedFailedWorkflow = {
  currentState: WorkflowState;
  checkpoint: Checkpoint;
};

/**
 * Re-reads the workflow's current state and checkpoint fresh on every
 * retry-loop attempt (see the loop's own doc) and validates both are still
 * in the shape a checkpoint-backed reactivation requires. Split out of
 * {@link reactivateFailedWorkflowFromCheckpointSerialized} to keep that
 * function under the complexity ceiling.
 */
async function loadFailedWorkflowForReactivation(
  internals: EngineInternals,
  workflowId: string,
): Promise<LoadedFailedWorkflow> {
  const currentStateBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (currentStateBytes === null) {
    throw new Error('Workflow no longer exists');
  }
  const currentState = decodeWorkflowState(currentStateBytes);
  if (currentState.status !== 'failed') {
    throw new Error(`Workflow is ${currentState.status}, not failed`);
  }

  const currentCheckpointBytes = await internals.storage.get(KEYS.checkpoint(workflowId));
  if (currentCheckpointBytes === null) {
    throw new Error('Checkpoint no longer exists');
  }
  return { currentState, checkpoint: deserializeCheckpoint(currentCheckpointBytes) };
}

type ReactivationCommit = {
  operations: BatchOperation[];
  conditions: ConditionalBatchCondition[];
  concurrencyStateKey: string | undefined;
};

/**
 * Resolves the failed run's own pinned revision (WFT-17), builds the
 * reactivation batch, and folds in workflow-concurrency admission — the
 * per-attempt work {@link reactivateFailedWorkflowFromCheckpointSerialized}'s
 * retry loop needs before it can try to commit. Split out to keep that
 * loop under the complexity ceiling.
 *
 * Also fences the reactivation commit on the pinned revision's durable
 * catalog entry (WFT-17/18 Codex review on PR #958): `resolveExecutableRegistrationForRetry()`
 * above can return successfully and then, in the gap before this commit
 * lands, a concurrent `removeWorkflowRevision()` can remove that exact
 * entry — `countNonTerminalRunsForRevision()`'s reference scan does not see
 * this run, because a `failed` workflow is terminal, so removal proceeds
 * believing nothing references the revision. Reusing
 * {@link buildCatalogEntryRevisionCondition} (the same precondition a fresh
 * `start()` carries) closes that gap: the reactivation CAS fails closed if
 * the entry is gone by commit time, and this run is left `failed` rather
 * than silently reactivated against a revision the catalog no longer
 * carries. Unlike the start-side precondition, this applies in EVERY
 * `ownershipMode` (not just `!== 'none'`) — a fresh start has same-process
 * protection via `inFlightStartsByRevision`, which a retry's reactivation
 * has no equivalent of, so even a single-process `ownership: 'none'` retry
 * needs this fence. A `state.revision === undefined` run (pre-revision-pinning
 * legacy record) carries no exact pin to fence on, so it is left unfenced —
 * a bounded, already-documented legacy case, consistent with
 * `decode-revision.ts`'s handling of the same gap elsewhere.
 */
async function buildReactivationCommit(
  internals: EngineInternals,
  workflowId: string,
  currentState: WorkflowState,
  checkpoint: Checkpoint,
): Promise<ReactivationCommit> {
  const { entry: registration } = await resolveExecutableRegistrationForRetry(
    internals,
    currentState.type,
    currentState.revision,
    workflowId,
  );

  const catalogEntryCondition =
    currentState.revision === undefined
      ? undefined
      : await buildCatalogEntryRevisionCondition(
          internals,
          currentState.type,
          currentState.revision,
        );

  const concurrencyStartOperations =
    registration.concurrency === undefined
      ? undefined
      : await buildWorkflowConcurrencyStartOperations(
          internals,
          currentState.type,
          workflowId,
          currentState.input,
          registration.concurrency,
        );

  const reactivatedState = buildReactivatedWorkflowState(internals, currentState);
  const currentAttributes = await loadSearchAttributes(internals, workflowId);
  const operations = buildReactivationBatchOperations(
    workflowId,
    currentState,
    reactivatedState,
    checkpoint,
    currentAttributes,
    concurrencyStartOperations?.operations,
  );

  return {
    operations,
    conditions: [
      ...(concurrencyStartOperations?.conditions ?? []),
      ...(catalogEntryCondition === undefined ? [] : [catalogEntryCondition]),
    ],
    concurrencyStateKey: concurrencyStartOperations?.stateKey,
  };
}

function buildReactivationBatchOperations(
  workflowId: string,
  currentState: WorkflowState,
  reactivatedState: WorkflowState,
  checkpoint: Checkpoint,
  currentAttributes: Record<string, SearchAttributeValue>,
  concurrencyOperations: BatchOperation[] | undefined,
): BatchOperation[] {
  const deadlineOperations =
    reactivatedState.executionDeadline === undefined
      ? []
      : buildTimerBatchOperations({
          id: `deadline:${workflowId}`,
          workflowId,
          fireAt: reactivatedState.executionDeadline,
          kind: 'execution-deadline',
        });
  return [
    ...buildTerminalWorkflowIndexOperations(currentState, reactivatedState),
    { type: 'put', key: KEYS.workflow(workflowId), value: encode(reactivatedState) },
    ...buildWorkflowVisibilityIndexTransition(workflowId, currentState, reactivatedState).batchOps,
    ...buildRetrySearchAttributeOperations(
      workflowId,
      currentAttributes,
      checkpoint.searchAttributes,
    ),
    ...deadlineOperations,
    ...(concurrencyOperations ?? []),
  ];
}

/**
 * ADR 0002: claim-acquiring — folds `acquire()` into this reactivation batch.
 * A lost claim throws; the follow-up `engine.resume()` skips re-acquiring.
 */
async function commitFailedWorkflowReactivation(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
  conditions: ConditionalBatchCondition[],
): Promise<boolean> {
  const claimFold = await prepareWorkflowClaimFold(internals, workflowId);
  if (claimFold === undefined) {
    if (conditions.length > 0) {
      requireStorageCapability(internals.storage, 'conditionalBatch', 'retry failed workflow');
    }
    return commitFencedEngineWriteAllowingPreconditionFailure(
      internals,
      workflowId,
      operations,
      conditions,
    );
  }
  const result = await commitWithWorkflowClaimFold(
    internals,
    claimFold,
    operations,
    conditions,
    'retry failed workflow claim acquisition',
  );
  if (result.status === 'committed') return true;
  return result.claimConflict ? throwWorkflowClaimUnavailable(internals, workflowId) : false;
}

function buildReactivatedWorkflowState(
  internals: EngineInternals,
  state: WorkflowState,
): WorkflowState {
  const reactivatedState: WorkflowState = {
    ...state,
    status: 'running',
    updatedAt: internals.options.getNow(),
  };
  delete reactivatedState.error;
  delete reactivatedState.errorStack;
  delete reactivatedState.failureCategory;
  delete reactivatedState.result;
  delete reactivatedState.terminationReason;
  delete reactivatedState.terminalCleanupToken;
  return reactivatedState;
}

async function loadSearchAttributes(
  internals: EngineInternals,
  workflowId: string,
): Promise<Record<string, SearchAttributeValue>> {
  const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
  if (attributeBytes === null) return {};
  return decode(attributeBytes) as Record<string, SearchAttributeValue>;
}

function buildRetrySearchAttributeOperations(
  workflowId: string,
  currentAttributes: Record<string, SearchAttributeValue>,
  checkpointAttributes: Record<string, SearchAttributeValue>,
): BatchOperation[] {
  const operations = buildIndexOperations(workflowId, currentAttributes, checkpointAttributes);
  if (Object.keys(checkpointAttributes).length === 0) {
    operations.push({ type: 'delete', key: KEYS.attribute(workflowId) });
  } else {
    operations.push({
      type: 'put',
      key: KEYS.attribute(workflowId),
      value: encode(checkpointAttributes),
    });
  }
  return operations;
}
