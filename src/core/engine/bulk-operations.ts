import {
  KEYS,
  requireStorageCapability,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../storage/interface.ts';
import { assertScopedBulkWorkflowFilter } from '../bulk-workflow-filter.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { decode, encode } from '../codec.ts';
import { buildTimerBatchOperations } from '../scheduler.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type {
  BulkCancelResult,
  BulkDeleteResult,
  BulkOperationAction,
  BulkOperationCommitOptions,
  BulkOperationDryRunOptions,
  BulkOperationDryRunResult,
  BulkOperationError,
  BulkOperationOptions,
  BulkRetryFailedResult,
  BulkSignalAllCommitOptions,
  BulkSignalAllDryRunOptions,
  BulkSignalResult,
  BulkTagResult,
  ListFilter,
  PurgeResult,
  SearchAttributeValue,
  WorkflowState,
  WorkflowStatus,
} from '../types.ts';
import { buildTerminalWorkflowIndexOperations, bulkMutateWorkflowTags } from './attributes-tags.ts';
import { purgeInternal, purgeWorkflow, type CleanupWaiters } from './bulk-operations-purge.ts';
import {
  buildActionableBulkWorkflowFilter,
  buildBulkOperationPreparation,
  collectTerminalWorkflowSnapshots,
  normalizeBulkOperationOptions,
  prepareBulkOperation,
  resolveBulkOperationConcurrency,
  shouldPersistBulkAudit,
  toBulkOperationError,
  validateBulkConfirmation,
  withBulkAuditEvent,
} from './bulk-operations-shared.ts';
import { BulkDeleteRequiresTerminalWorkflowsError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import { BULK_OPERATION_BATCH_SIZE } from './listing.ts';
import { createTerminalCleanupTimerId } from './state-utilities.ts';
import { loadWorkflowState, runSerializedWorkflowStateWrite } from './storage-io.ts';
import { decodeWorkflowState, isTerminalWorkflowStatus } from './validation.ts';
import { buildWorkflowConcurrencyStartOperations } from './workflow-concurrency.ts';
import { buildWorkflowVisibilityIndexTransition } from './workflow-indexes.ts';

export { purgeInternal, TERMINAL_CLEANUP_DELAY_MS } from './bulk-operations-purge.ts';

// The non-terminal statuses a default bulk cancel/signal targets when the caller
// gives no explicit status filter. 'suspended' is included so bulk cancel matches
// single-workflow cancel (which is total over a suspended run) and so bulk signal
// reaches a suspended run (it buffers the signal durably and replays it on
// resume, exactly like a parked running run).
const ACTIVE_WORKFLOW_STATUSES: WorkflowStatus[] = ['pending', 'running', 'suspended'];
const FAILED_WORKFLOW_STATUSES: WorkflowStatus[] = ['failed'];
const CHECKPOINT_RETRY_CONCURRENCY_ADMISSION_MAX_ATTEMPTS = 5;

async function runBulkWorkflowPool<TItem, TResult>(
  items: readonly TItem[],
  concurrencyLimit: number,
  operation: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];

  for (let batchStart = 0; batchStart < items.length; batchStart += concurrencyLimit) {
    const batchItems = items.slice(batchStart, batchStart + concurrencyLimit);
    const settledResults = await Promise.allSettled(batchItems.map((item) => operation(item)));

    for (const settledResult of settledResults) {
      if (settledResult.status === 'fulfilled') {
        results.push(settledResult.value);
        continue;
      }

      throw settledResult.reason;
    }
  }

  return results;
}

export async function purge(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  cleanupWaiters: CleanupWaiters,
): Promise<PurgeResult> {
  return purgeInternal(
    internals,
    filter,
    { expiredOnly: false, now: internals.options.getNow() },
    cleanupWaiters,
  );
}

async function runBulkCancellation(
  internals: EngineInternals,
  filter: ListFilter,
  options: BulkOperationOptions = {},
): Promise<BulkCancelResult | BulkOperationDryRunResult> {
  options = normalizeBulkOperationOptions(options);
  assertScopedBulkWorkflowFilter(filter);
  const actionableFilter = buildActionableBulkWorkflowFilter(
    internals,
    filter,
    ACTIVE_WORKFLOW_STATUSES,
  );
  const preparation = await prepareBulkOperation(
    internals,
    'cancel',
    actionableFilter,
    filter,
    {},
    options,
  );
  if (options.dryRun === true) return preparation.preview;

  validateBulkConfirmation(options, preparation);
  const workflowIdsToCancel = preparation.workflowIds;
  const bulkConcurrency = resolveBulkOperationConcurrency(options);
  let cancelled = 0;
  const errors: BulkOperationError[] = [];

  const cancellationResults = await runBulkWorkflowPool(
    workflowIdsToCancel,
    bulkConcurrency,
    async (workflowId) => {
      try {
        await internals.engine.cancel(workflowId);
        const refreshedState = await loadWorkflowState(internals, workflowId);
        if (refreshedState?.status === 'cancelled') {
          return { status: 'cancelled' as const };
        }

        return {
          status: 'failed' as const,
          error: { id: workflowId, error: 'Workflow no longer cancellable' },
        };
      } catch (error) {
        return {
          status: 'failed' as const,
          error: toBulkOperationError(internals, workflowId, error),
        };
      }
    },
  );

  for (const cancellationResult of cancellationResults) {
    if (cancellationResult.status === 'cancelled') {
      cancelled += 1;
      continue;
    }

    errors.push(cancellationResult.error);
  }

  const result: BulkCancelResult = { cancelled, failed: errors.length, errors };
  if (!shouldPersistBulkAudit(options)) return result;
  return withBulkAuditEvent(internals, preparation, options, result, cancelled);
}

export async function cancelAll(
  internals: EngineInternals,
  filter: ListFilter,
  options: BulkOperationDryRunOptions,
): Promise<BulkOperationDryRunResult>;
export async function cancelAll(
  internals: EngineInternals,
  filter: ListFilter,
  options?: BulkOperationCommitOptions,
): Promise<BulkCancelResult>;
export async function cancelAll(
  internals: EngineInternals,
  filter: ListFilter,
  options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
): Promise<BulkCancelResult | BulkOperationDryRunResult>;
export async function cancelAll(
  internals: EngineInternals,
  filter: ListFilter,
  options: BulkOperationOptions = {},
): Promise<BulkCancelResult | BulkOperationDryRunResult> {
  return runBulkCancellation(internals, filter, options);
}

async function runBulkFailedWorkflowRetry(
  internals: EngineInternals,
  filter: ListFilter,
  options: BulkOperationOptions = {},
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
      try {
        await retryFailedWorkflow(internals, workflowId);
        return { status: 'retried' as const };
      } catch (error) {
        return {
          status: 'failed' as const,
          error: toBulkOperationError(internals, workflowId, error),
        };
      }
    },
  );

  for (const retryResult of retryResults) {
    if (retryResult.status === 'retried') {
      retried += 1;
      continue;
    }

    errors.push(retryResult.error);
  }

  const result: BulkRetryFailedResult = { retried, failed: errors.length, errors };
  if (!shouldPersistBulkAudit(options)) return result;
  return withBulkAuditEvent(internals, preparation, options, result, retried);
}

export async function retryFailedAll(
  internals: EngineInternals,
  filter: ListFilter,
  options: BulkOperationDryRunOptions,
): Promise<BulkOperationDryRunResult>;
export async function retryFailedAll(
  internals: EngineInternals,
  filter: ListFilter,
  options?: BulkOperationCommitOptions,
): Promise<BulkRetryFailedResult>;
export async function retryFailedAll(
  internals: EngineInternals,
  filter: ListFilter,
  options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
): Promise<BulkRetryFailedResult | BulkOperationDryRunResult>;
export async function retryFailedAll(
  internals: EngineInternals,
  filter: ListFilter,
  options: BulkOperationOptions = {},
): Promise<BulkRetryFailedResult | BulkOperationDryRunResult> {
  return runBulkFailedWorkflowRetry(internals, filter, options);
}

async function retryFailedWorkflow(internals: EngineInternals, workflowId: string): Promise<void> {
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

  await internals.engine.start(state.type, state.input, {
    id: workflowId,
    onTerminalConflict: 'start-new',
    ...(state.tags !== undefined ? { tags: state.tags } : {}),
  });
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
    const checkpoint = deserializeCheckpoint(currentCheckpointBytes);
    const registration = internals.registrations.get(currentState.type);
    if (registration === undefined) {
      throw new Error(
        `No workflow registered with name "${currentState.type}" (needed to retry "${workflowId}")`,
      );
    }

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
    lastConcurrencyStateKey = concurrencyStartOperations?.stateKey ?? lastConcurrencyStateKey;

    const reactivatedState = buildReactivatedWorkflowState(internals, currentState);
    const currentAttributes = await loadSearchAttributes(internals, workflowId);
    const operations: BatchOperation[] = [
      ...buildTerminalWorkflowIndexOperations(currentState, reactivatedState),
      { type: 'put', key: KEYS.workflow(workflowId), value: encode(reactivatedState) },
      ...buildWorkflowVisibilityIndexTransition(workflowId, currentState, reactivatedState)
        .batchOps,
      ...buildRetrySearchAttributeOperations(
        workflowId,
        currentAttributes,
        checkpoint.searchAttributes,
      ),
      ...(reactivatedState.executionDeadline === undefined
        ? []
        : buildTimerBatchOperations({
            id: `deadline:${workflowId}`,
            workflowId,
            fireAt: reactivatedState.executionDeadline,
            kind: 'execution-deadline',
          })),
      ...(concurrencyStartOperations?.operations ?? []),
    ];
    const conditions = concurrencyStartOperations?.conditions ?? [];
    const committed = await commitFailedWorkflowReactivation(
      internals,
      operations,
      conditions,
      concurrencyStartOperations?.stateKey,
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

async function commitFailedWorkflowReactivation(
  internals: EngineInternals,
  operations: BatchOperation[],
  conditions: ConditionalBatchCondition[],
  stateKey: string | undefined,
): Promise<boolean> {
  if (conditions.length === 0) {
    await internals.storage.batch(operations);
    return true;
  }

  requireStorageCapability(internals.storage, 'conditionalBatch', 'retry failed workflow');
  const committed = await storageConditionalBatch(internals.storage, conditions, operations);
  if (!committed && stateKey === undefined) {
    throw new Error('Retry failed workflow compare-and-swap lost unexpectedly');
  }
  return committed;
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

export async function signalAll(
  internals: EngineInternals,
  filter: ListFilter,
  name: string,
  payload: unknown,
  options: BulkSignalAllDryRunOptions,
): Promise<BulkOperationDryRunResult>;
export async function signalAll(
  internals: EngineInternals,
  filter: ListFilter,
  name: string,
  payload: unknown,
  options: BulkSignalAllCommitOptions,
): Promise<BulkSignalResult>;
export async function signalAll(
  internals: EngineInternals,
  filter: ListFilter,
  name: string,
  payload?: unknown,
  options?: BulkOperationCommitOptions,
): Promise<BulkSignalResult>;
export async function signalAll(
  internals: EngineInternals,
  filter: ListFilter,
  name: string,
  payload: unknown,
  options: BulkOperationOptions,
): Promise<BulkSignalResult | BulkOperationDryRunResult>;
export async function signalAll(
  internals: EngineInternals,
  filter: ListFilter,
  name: string,
  payload?: unknown,
  maybeOptions?: BulkOperationOptions,
): Promise<BulkSignalResult | BulkOperationDryRunResult> {
  const options = normalizeBulkOperationOptions(maybeOptions ?? {});
  assertScopedBulkWorkflowFilter(filter);
  if (name.length === 0) throw new Error('Field "name" must be a non-empty string');
  const actionableFilter = buildActionableBulkWorkflowFilter(
    internals,
    filter,
    ACTIVE_WORKFLOW_STATUSES,
  );
  const preparation = await prepareBulkOperation(
    internals,
    'signal',
    actionableFilter,
    filter,
    { name, payload },
    options,
  );
  if (options.dryRun === true) return preparation.preview;

  validateBulkConfirmation(options, preparation);
  const workflowIdsToSignal = preparation.workflowIds;
  const bulkConcurrency = resolveBulkOperationConcurrency(options);
  let signalled = 0;
  let failed = 0;

  const signalResults = await runBulkWorkflowPool(
    workflowIdsToSignal,
    bulkConcurrency,
    async (workflowId) => {
      try {
        await internals.engine.signal(workflowId, name, payload);
        return { status: 'signalled' as const };
      } catch {
        return { status: 'failed' as const };
      }
    },
  );

  for (const signalResult of signalResults) {
    if (signalResult.status === 'signalled') {
      signalled += 1;
    } else {
      failed += 1;
    }
  }

  const result: BulkSignalResult = { signalled, failed };
  if (!shouldPersistBulkAudit(options)) return result;
  return withBulkAuditEvent(internals, preparation, options, result, signalled);
}

async function runBulkDeletion(
  internals: EngineInternals,
  filter: ListFilter,
  cleanupWaiters: CleanupWaiters,
  options: BulkOperationOptions = {},
): Promise<BulkDeleteResult | BulkOperationDryRunResult> {
  options = normalizeBulkOperationOptions(options);
  assertScopedBulkWorkflowFilter(filter);
  const candidateWorkflowSnapshots = await collectTerminalWorkflowSnapshots(internals, filter);
  const preparation = buildBulkOperationPreparation(
    'delete',
    filter,
    {},
    candidateWorkflowSnapshots,
    options,
  );
  if (options.dryRun === true) return preparation.preview;

  validateBulkConfirmation(options, preparation);
  const bulkConcurrency = resolveBulkOperationConcurrency(options);
  let deleted = 0;
  for (
    let batchStart = 0;
    batchStart < preparation.workflowIds.length;
    batchStart += BULK_OPERATION_BATCH_SIZE
  ) {
    const batchWorkflowIds = preparation.workflowIds.slice(
      batchStart,
      batchStart + BULK_OPERATION_BATCH_SIZE,
    );
    const workflowStatesToDelete = await loadTerminalWorkflowStatesForBatch(
      internals,
      batchWorkflowIds,
    );

    const deletedWorkflowIds = await runBulkWorkflowPool(
      workflowStatesToDelete,
      bulkConcurrency,
      async (workflowState) => {
        await purgeWorkflow(internals, workflowState, cleanupWaiters);
        return workflowState.id;
      },
    );
    deleted += deletedWorkflowIds.length;
  }

  const result: BulkDeleteResult = { deleted };
  if (!shouldPersistBulkAudit(options)) return result;
  return withBulkAuditEvent(internals, preparation, options, result, deleted);
}

export async function deleteAll(
  internals: EngineInternals,
  filter: ListFilter,
  cleanupWaiters: CleanupWaiters,
  options: BulkOperationDryRunOptions,
): Promise<BulkOperationDryRunResult>;
export async function deleteAll(
  internals: EngineInternals,
  filter: ListFilter,
  cleanupWaiters: CleanupWaiters,
  options?: BulkOperationCommitOptions,
): Promise<BulkDeleteResult>;
export async function deleteAll(
  internals: EngineInternals,
  filter: ListFilter,
  cleanupWaiters: CleanupWaiters,
  options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
): Promise<BulkDeleteResult | BulkOperationDryRunResult>;
export async function deleteAll(
  internals: EngineInternals,
  filter: ListFilter,
  cleanupWaiters: CleanupWaiters,
  options: BulkOperationOptions = {},
): Promise<BulkDeleteResult | BulkOperationDryRunResult> {
  return runBulkDeletion(internals, filter, cleanupWaiters, options);
}

async function loadTerminalWorkflowStatesForBatch(
  internals: EngineInternals,
  workflowIds: readonly string[],
): Promise<WorkflowState[]> {
  const workflowStates: WorkflowState[] = [];
  for (const workflowId of workflowIds) {
    const refreshedState = await loadWorkflowState(internals, workflowId);
    if (refreshedState === null) continue;
    if (!isTerminalWorkflowStatus(refreshedState.status)) {
      throw new BulkDeleteRequiresTerminalWorkflowsError();
    }
    workflowStates.push(refreshedState);
  }
  return workflowStates;
}

export async function tagAll(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  options: BulkOperationDryRunOptions,
): Promise<BulkOperationDryRunResult>;
export async function tagAll(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  options?: BulkOperationCommitOptions,
): Promise<BulkTagResult>;
export async function tagAll(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
): Promise<BulkTagResult | BulkOperationDryRunResult>;
export async function tagAll(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  options: BulkOperationOptions = {},
): Promise<BulkTagResult | BulkOperationDryRunResult> {
  return mutateTagsWithBulkControls(internals, filter, tags, 'add', options);
}

export async function untagAll(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  options: BulkOperationDryRunOptions,
): Promise<BulkOperationDryRunResult>;
export async function untagAll(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  options?: BulkOperationCommitOptions,
): Promise<BulkTagResult>;
export async function untagAll(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
): Promise<BulkTagResult | BulkOperationDryRunResult>;
export async function untagAll(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  options: BulkOperationOptions = {},
): Promise<BulkTagResult | BulkOperationDryRunResult> {
  return mutateTagsWithBulkControls(internals, filter, tags, 'remove', options);
}

async function mutateTagsWithBulkControls(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  mode: 'add' | 'remove',
  options: BulkOperationOptions,
): Promise<BulkTagResult | BulkOperationDryRunResult> {
  options = normalizeBulkOperationOptions(options);
  assertScopedBulkWorkflowFilter(filter);
  const action: BulkOperationAction = mode === 'add' ? 'tag:add' : 'tag:remove';
  const preparation = await prepareBulkOperation(
    internals,
    action,
    filter,
    filter,
    { tags },
    options,
  );
  if (options.dryRun === true) return preparation.preview;

  validateBulkConfirmation(options, preparation);
  const result = await bulkMutateWorkflowTags(
    internals,
    filter,
    tags,
    mode,
    preparation.workflowIds,
  );
  if (!shouldPersistBulkAudit(options)) return result;
  return withBulkAuditEvent(internals, preparation, options, result, result.modified);
}
