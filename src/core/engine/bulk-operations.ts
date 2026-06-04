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
import {
  buildActionableBulkWorkflowFilter,
  buildBulkOperationPreparation,
  collectTerminalWorkflowSnapshots,
  normalizeBulkOperationOptions,
  prepareBulkOperation,
  shouldPersistBulkAudit,
  toBulkOperationError,
  validateBulkConfirmation,
  withBulkAuditEvent,
} from './bulk-operations-shared.ts';
import { BulkDeleteRequiresTerminalWorkflowsError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
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
  let cancelled = 0;
  const errors: BulkOperationError[] = [];

  for (const workflowId of workflowIdsToCancel) {
    try {
      await internals.engine.cancel(workflowId);
      const refreshedState = await loadWorkflowState(internals, workflowId);
      if (refreshedState?.status === 'cancelled') {
        cancelled += 1;
        continue;
      }

      errors.push({ id: workflowId, error: 'Workflow no longer cancellable' });
    } catch (error) {
      errors.push(toBulkOperationError(internals, workflowId, error));
    }
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
  let signalled = 0;
  let failed = 0;

  for (const workflowId of workflowIdsToSignal) {
    try {
      await internals.engine.signal(workflowId, name, payload);
      signalled += 1;
    } catch {
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

    for (const workflowState of workflowStatesToDelete) {
      await purgeWorkflow(internals, workflowState, cleanupWaiters);
      deleted += 1;
    }
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
