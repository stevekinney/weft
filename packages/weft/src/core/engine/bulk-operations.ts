import { KEYS, storageHas } from '../../storage/interface.ts';
import { assertScopedBulkWorkflowFilter } from '../bulk-workflow-filter.ts';
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
  WorkflowState,
  WorkflowStatus,
} from '../types.ts';
import { bulkMutateWorkflowTags } from './attributes-tags.ts';
import { purgeInternal, purgeWorkflow, type CleanupWaiters } from './bulk-operations-purge.ts';
import { runBulkFailedWorkflowRetry } from './bulk-operations-retry.ts';
import {
  buildActionableBulkWorkflowFilter,
  buildBulkOperationPreparation,
  collectTerminalWorkflowSnapshots,
  normalizeBulkOperationOptions,
  prepareBulkOperation,
  resolveBulkOperationConcurrency,
  runBulkWorkflowPool,
  shouldPersistBulkAudit,
  toBulkOperationError,
  validateBulkConfirmation,
  withBulkAuditEvent,
} from './bulk-operations-shared.ts';
import { BulkDeleteRequiresTerminalWorkflowsError } from './errors.ts';
import { assertLeaseHeldForEngineWork } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import type { LifecycleCallbacks } from './lifecycle.ts';
import { BULK_OPERATION_BATCH_SIZE } from './listing.ts';
import { loadWorkflowState } from './storage-io.ts';
import { isTerminalWorkflowStatus } from './validation.ts';

export { purgeInternal, TERMINAL_CLEANUP_DELAY_MS } from './bulk-operations-purge.ts';

// The non-terminal statuses a default bulk cancel/signal targets when the caller
// gives no explicit status filter. 'suspended' is included so bulk cancel matches
// single-workflow cancel (which is total over a suspended run) and so bulk signal
// reaches a suspended run (it buffers the signal durably and replays it on
// resume, exactly like a parked running run).
const ACTIVE_WORKFLOW_STATUSES: WorkflowStatus[] = ['pending', 'running', 'suspended'];

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
      await internals.engine.cancel(workflowId);
      const refreshedState = await loadWorkflowState(internals, workflowId);
      if (refreshedState?.status === 'cancelled') {
        return { status: 'cancelled' as const };
      }

      return {
        status: 'failed' as const,
        error: { id: workflowId, error: 'Workflow no longer cancellable' },
      };
    },
  );

  for (const cancellationResult of cancellationResults) {
    if (cancellationResult.status === 'rejected') {
      errors.push(
        toBulkOperationError(internals, cancellationResult.item, cancellationResult.reason),
      );
      continue;
    }

    const { value } = cancellationResult;
    if (value.status === 'cancelled') {
      cancelled += 1;
      continue;
    }

    errors.push(value.error);
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

export async function retryFailedAll(
  internals: EngineInternals,
  filter: ListFilter,
  options: BulkOperationDryRunOptions,
): Promise<BulkOperationDryRunResult>;
export async function retryFailedAll(
  internals: EngineInternals,
  filter: ListFilter,
  options?: BulkOperationCommitOptions,
  callbacks?: LifecycleCallbacks,
): Promise<BulkRetryFailedResult>;
export async function retryFailedAll(
  internals: EngineInternals,
  filter: ListFilter,
  options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
  callbacks?: LifecycleCallbacks,
): Promise<BulkRetryFailedResult | BulkOperationDryRunResult>;
export async function retryFailedAll(
  internals: EngineInternals,
  filter: ListFilter,
  options: BulkOperationOptions = {},
  // See `runBulkFailedWorkflowRetry`'s doc comment (`bulk-operations-retry.ts`, WFT-95 issue 2) for why this is a parameter rather than constructed here.
  callbacks?: LifecycleCallbacks,
): Promise<BulkRetryFailedResult | BulkOperationDryRunResult> {
  assertLeaseHeldForEngineWork(internals);
  return runBulkFailedWorkflowRetry(internals, filter, options, callbacks);
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
    if (signalResult.status === 'fulfilled' && signalResult.value.status === 'signalled') {
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
  if (options.dryRun === true) {
    // Surface the point-in-time teardown-owed subset so the preview does not silently
    // imply every matched workflow will be deleted — the commit skips ids that still owe
    // a finalizer (#446). `matched`/scope/token still describe the full scope (they derive
    // the commit token, and the set is transient), so this is advisory only; the
    // authoritative skip list is `skippedTeardownPending` on the commit result.
    const skippedTeardownPending: string[] = [];
    for (const workflowId of preparation.workflowIds) {
      if (await storageHas(internals.storage, KEYS.teardownOwed(workflowId))) {
        skippedTeardownPending.push(workflowId);
      }
    }
    return skippedTeardownPending.length > 0
      ? { ...preparation.preview, skippedTeardownPending }
      : preparation.preview;
  }

  validateBulkConfirmation(options, preparation);
  const bulkConcurrency = resolveBulkOperationConcurrency(options);
  let deleted = 0;
  const skippedTeardownPending: string[] = [];
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

    // A workflow that still owes an engine-driven finalizer (#446) must not be
    // deleted: the purge drops the `finalizerState` payload the finalizer needs as
    // its input, silently abandoning the teardown of a paid external resource. Skip
    // it and report the id — the skip is transient (the finalizer clears the marker
    // on success/dead-letter, so a later `deleteAll` removes the record).
    const deletableStates: typeof workflowStatesToDelete = [];
    for (const workflowState of workflowStatesToDelete) {
      if (await storageHas(internals.storage, KEYS.teardownOwed(workflowState.id))) {
        skippedTeardownPending.push(workflowState.id);
      } else {
        deletableStates.push(workflowState);
      }
    }

    const deletionResults = await runBulkWorkflowPool(
      deletableStates,
      bulkConcurrency,
      async (workflowState) => {
        await purgeWorkflow(internals, workflowState, cleanupWaiters);
        return workflowState.id;
      },
    );
    const deletionErrors: unknown[] = [];

    for (const deletionResult of deletionResults) {
      if (deletionResult.status === 'fulfilled') {
        deleted += 1;
      } else {
        deletionErrors.push(deletionResult.reason);
      }
    }

    if (deletionErrors.length > 0) {
      throw new AggregateError(
        deletionErrors,
        `Bulk delete failed for ${deletionErrors.length} workflow(s) after deleting ${deleted} workflow(s)`,
      );
    }
  }

  const result: BulkDeleteResult = {
    deleted,
    ...(skippedTeardownPending.length > 0 ? { skippedTeardownPending } : {}),
  };
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
