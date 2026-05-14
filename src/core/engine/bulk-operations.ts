/* oxlint-disable max-lines -- ID:core-engine-bulk-operations-file-length */

import type { BatchOperation, Storage as WeftStorage } from '../../storage/interface.ts';
import {
  KEYS,
  encodeStorageKeyComponent,
  storageKeys,
  tryDecodeStorageKeyComponent,
} from '../../storage/interface.ts';
import { assertScopedBulkWorkflowFilter } from '../bulk-workflow-filter.ts';
import { decode, encode } from '../codec.ts';
import { computeSemanticHash } from '../effect-log/index.ts';
import { buildIndexOperations, searchAttributeName } from '../search-attributes.ts';
import type {
  BulkCancelResult,
  BulkDeleteResult,
  BulkOperationAction,
  BulkOperationAuditEvent,
  BulkOperationCommitOptions,
  BulkOperationDryRunOptions,
  BulkOperationDryRunResult,
  BulkOperationError,
  BulkOperationFilterSummary,
  BulkOperationOptions,
  BulkOperationPrincipal,
  BulkOperationScopeSummary,
  BulkSignalAllCommitOptions,
  BulkSignalAllDryRunOptions,
  BulkSignalResult,
  BulkTagResult,
  ListFilter,
  NormalizedRetentionPolicy,
  PurgeResult,
  SearchAttributeValue,
  WorkflowState,
  WorkflowStatus,
} from '../types.ts';
import {
  MAX_BULK_CONFIRMATION_TOKEN_LENGTH,
  MAX_BULK_OPERATION_REQUEST_ID_LENGTH,
} from '../types/bulk.ts';
import { buildWorkflowTagIndexOperations, normalizeWorkflowTags } from '../workflow-tags.ts';
import { bulkMutateWorkflowTags } from './attributes-tags.ts';
import {
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
} from './errors.ts';
import type { EngineInternals } from './internals.ts';
import {
  BULK_OPERATION_BATCH_SIZE,
  streamWorkflowStateBatches,
  streamWorkflowStates,
} from './listing.ts';
import { createTerminalCleanupTimerId } from './state-utilities.ts';
import { loadWorkflowState } from './storage-io.ts';
import {
  decodeWorkflowState,
  isTerminalWorkflowStatus,
  resolveRetentionForStatus,
} from './validation.ts';
import { buildWorkflowVisibilityIndexTransition } from './workflow-indexes.ts';

export const TERMINAL_CLEANUP_DELAY_MS = 60_000;

type PurgeParameters = {
  expiredOnly: boolean;
  now: number;
  limit?: number;
};

type CleanupWaiters = (workflowId: string) => void;

const ACTIVE_WORKFLOW_STATUSES: WorkflowStatus[] = ['pending', 'running'];
const BULK_OPERATION_SAMPLE_LIMIT = 20;
const DEFAULT_BULK_OPERATION_PRINCIPAL: BulkOperationPrincipal = { method: 'in-process' };

type BulkWorkflowSnapshot = {
  id: string;
  type: string;
  status: WorkflowStatus;
  updatedAt: number;
  tenantId?: string;
};

type BulkOperationPreparation = {
  workflowIds: string[];
  confirmationToken: string;
  preview: BulkOperationDryRunResult;
  scope: BulkOperationScopeSummary;
};

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

async function runBulkTagAddition(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  options: BulkOperationOptions = {},
): Promise<BulkTagResult | BulkOperationDryRunResult> {
  return mutateTagsWithBulkControls(internals, filter, tags, 'add', options);
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
  return runBulkTagAddition(internals, filter, tags, options);
}

async function runBulkTagRemoval(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  options: BulkOperationOptions = {},
): Promise<BulkTagResult | BulkOperationDryRunResult> {
  return mutateTagsWithBulkControls(internals, filter, tags, 'remove', options);
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
  return runBulkTagRemoval(internals, filter, tags, options);
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

export async function purgeInternal(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  parameters: PurgeParameters,
  cleanupWaiters: CleanupWaiters,
): Promise<PurgeResult> {
  const { effectiveLimit, manualOffset } = resolvePurgeWindow(internals, filter, parameters.limit);

  if (effectiveLimit === 0) return { deleted: 0 };

  let remainingOffset = manualOffset;
  let deleted = 0;

  const workflowStateStream =
    parameters.expiredOnly && filter === undefined
      ? streamExpiredRetentionWorkflowStates(internals, parameters.now)
      : streamWorkflowStates(internals, filter);

  for await (const state of workflowStateStream) {
    if (!shouldPurgeWorkflowState(internals, state, parameters.expiredOnly, parameters.now)) {
      continue;
    }

    if (remainingOffset > 0) {
      remainingOffset -= 1;
      continue;
    }

    await purgeWorkflow(internals, state, cleanupWaiters);
    deleted += 1;

    if (effectiveLimit !== undefined && deleted >= effectiveLimit) {
      break;
    }
  }

  return { deleted };
}

function buildActionableBulkWorkflowFilter(
  _internals: EngineInternals,
  filter: ListFilter,
  actionableStatuses: WorkflowStatus[],
): ListFilter {
  const requestedStatuses =
    filter.status === undefined
      ? actionableStatuses
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
  const effectiveStatuses = requestedStatuses.filter((status) =>
    actionableStatuses.includes(status),
  );

  if (effectiveStatuses.length === 0) {
    return { ...filter, status: [] };
  }

  if (effectiveStatuses.length !== 1) {
    return { ...filter, status: effectiveStatuses };
  }

  const [effectiveStatus] = effectiveStatuses;
  return { ...filter, status: effectiveStatus ?? [] };
}

async function prepareBulkOperation(
  internals: EngineInternals,
  action: BulkOperationAction,
  scanFilter: ListFilter,
  tokenFilter: ListFilter,
  actionParameters: Record<string, unknown>,
  options: BulkOperationOptions,
): Promise<BulkOperationPreparation> {
  const snapshots = await snapshotMatchingWorkflowSnapshots(internals, scanFilter);
  return buildBulkOperationPreparation(action, tokenFilter, actionParameters, snapshots, options);
}

function buildBulkOperationPreparation(
  action: BulkOperationAction,
  filter: ListFilter,
  actionParameters: Record<string, unknown>,
  snapshots: readonly BulkWorkflowSnapshot[],
  options: BulkOperationOptions,
): BulkOperationPreparation {
  const filterSummary = summarizeBulkFilter(filter);
  const scope = summarizeBulkOperationScope(filterSummary, snapshots);
  const requestId = resolveBulkOperationRequestId(
    action,
    filterSummary,
    actionParameters,
    scope,
    options,
  );
  const confirmationToken = deriveBulkConfirmationToken(
    action,
    filterSummary,
    actionParameters,
    snapshots,
  );
  const sampleWorkflowIds = scope.sampleWorkflowIds;

  return {
    workflowIds: snapshots.map((snapshot) => snapshot.id),
    confirmationToken,
    scope,
    preview: {
      dryRun: true,
      action,
      matched: snapshots.length,
      requestId,
      scope,
      sampleWorkflowIds,
      confirmationToken,
      confirmationTokenVersion: 1,
    },
  };
}

function summarizeBulkOperationScope(
  filter: BulkOperationFilterSummary,
  snapshots: readonly BulkWorkflowSnapshot[],
): BulkOperationScopeSummary {
  const sampleWorkflowIds = snapshots
    .slice(0, BULK_OPERATION_SAMPLE_LIMIT)
    .map((snapshot) => snapshot.id);

  return {
    matched: snapshots.length,
    filter,
    statuses: uniqueSorted(snapshots.map((snapshot) => snapshot.status)),
    workflowTypes: uniqueSorted(snapshots.map((snapshot) => snapshot.type)),
    tenantIds: uniqueSorted(
      snapshots
        .map((snapshot) => snapshot.tenantId)
        .filter((tenantId): tenantId is string => tenantId !== undefined),
    ),
    sampleWorkflowIds,
    sampleLimit: BULK_OPERATION_SAMPLE_LIMIT,
  };
}

function summarizeBulkFilter(filter: ListFilter): BulkOperationFilterSummary {
  const summary: BulkOperationFilterSummary = {};

  if (filter.status !== undefined) {
    summary.status = Array.isArray(filter.status) ? uniqueSorted(filter.status) : filter.status;
  }
  if (filter.type !== undefined) {
    summary.type = filter.type;
  }
  const normalizedTags = normalizeWorkflowTags(filter.tags);
  if (normalizedTags !== undefined) {
    summary.tags = normalizedTags;
  }
  if (filter.attributes !== undefined) {
    summary.attributes = filter.attributes
      .map((attribute) => ({
        key: searchAttributeName(attribute.key),
        ...(attribute.value === undefined ? {} : { value: attribute.value }),
        ...(attribute.gt === undefined ? {} : { gt: attribute.gt }),
        ...(attribute.lt === undefined ? {} : { lt: attribute.lt }),
        ...(attribute.gte === undefined ? {} : { gte: attribute.gte }),
        ...(attribute.lte === undefined ? {} : { lte: attribute.lte }),
      }))
      .toSorted((left, right) =>
        computeSemanticHash(left).localeCompare(computeSemanticHash(right)),
      );
  }
  if (filter.limit !== undefined) {
    summary.limit = filter.limit;
  }
  if (filter.offset !== undefined) {
    summary.offset = filter.offset;
  }

  return summary;
}

function resolveBulkOperationRequestId(
  action: BulkOperationAction,
  filterSummary: BulkOperationFilterSummary,
  actionParameters: Record<string, unknown>,
  scope: BulkOperationScopeSummary,
  options: BulkOperationOptions,
): string {
  const explicitRequestId = options.requestId?.trim();
  if (explicitRequestId !== undefined && explicitRequestId.length > 0) {
    return explicitRequestId;
  }

  return `bulk:${computeSemanticHash({
    action,
    actionParameters: sanitizeBulkTokenValue(actionParameters),
    filterSummary,
    matched: scope.matched,
    sampleWorkflowIds: scope.sampleWorkflowIds,
  })}`;
}

function deriveBulkConfirmationToken(
  action: BulkOperationAction,
  filterSummary: BulkOperationFilterSummary,
  actionParameters: Record<string, unknown>,
  snapshots: readonly BulkWorkflowSnapshot[],
): string {
  return `bulk:${computeSemanticHash({
    version: 1,
    action,
    actionParameters: sanitizeBulkTokenValue(actionParameters),
    filterSummary,
    workflows: snapshots.map((snapshot) => ({
      id: snapshot.id,
      status: snapshot.status,
    })),
  })}`;
}

function validateBulkConfirmation(
  options: BulkOperationCommitOptions,
  preparation: BulkOperationPreparation,
): void {
  if (options.confirmationToken === undefined) return;
  if (options.confirmationToken === preparation.confirmationToken) return;

  throw new BulkOperationConfirmationError();
}

function shouldPersistBulkAudit(options: BulkOperationCommitOptions): boolean {
  return (
    options.confirmationToken !== undefined ||
    options.requestId !== undefined ||
    options.principal !== undefined
  );
}

async function withBulkAuditEvent<TResult extends object>(
  internals: EngineInternals,
  preparation: BulkOperationPreparation,
  options: BulkOperationCommitOptions,
  result: TResult,
  affectedCount: number,
): Promise<TResult & { auditEvent: BulkOperationAuditEvent }> {
  const auditEvent = await persistBulkOperationAuditEvent(
    internals,
    preparation,
    options,
    affectedCount,
  );
  return { ...result, auditEvent };
}

async function persistBulkOperationAuditEvent(
  internals: EngineInternals,
  preparation: BulkOperationPreparation,
  options: BulkOperationCommitOptions,
  affectedCount: number,
): Promise<BulkOperationAuditEvent> {
  const timestamp = internals.options.getNow();
  const explicitRequestId = options.requestId?.trim();
  const requestId =
    explicitRequestId !== undefined && explicitRequestId.length > 0
      ? explicitRequestId
      : preparation.preview.requestId;
  const auditEvent: BulkOperationAuditEvent = {
    type: 'bulk-operation:audit',
    action: preparation.preview.action,
    requestId,
    timestamp,
    principal: options.principal ?? DEFAULT_BULK_OPERATION_PRINCIPAL,
    filterSummary: preparation.scope.filter,
    scope: preparation.scope,
    affectedCount,
    sampleWorkflowIds: preparation.scope.sampleWorkflowIds,
    confirmationToken: preparation.confirmationToken,
  };

  await internals.storage.put(
    KEYS.bulkOperationAudit(timestamp, requestId, preparation.confirmationToken),
    encode(auditEvent),
  );
  return auditEvent;
}

function normalizeBulkOperationOptions<TOptions extends BulkOperationOptions>(
  options: TOptions,
): TOptions {
  const confirmationToken = 'confirmationToken' in options ? options.confirmationToken : undefined;
  if (
    confirmationToken !== undefined &&
    confirmationToken.length > MAX_BULK_CONFIRMATION_TOKEN_LENGTH
  ) {
    throw new Error(
      `Field "confirmationToken" must be at most ${String(MAX_BULK_CONFIRMATION_TOKEN_LENGTH)} characters`,
    );
  }

  if (
    options.requestId !== undefined &&
    options.requestId.length > MAX_BULK_OPERATION_REQUEST_ID_LENGTH
  ) {
    throw new Error(
      `Field "requestId" must be at most ${String(MAX_BULK_OPERATION_REQUEST_ID_LENGTH)} characters`,
    );
  }

  return options;
}

function toBulkOperationError(
  _internals: EngineInternals,
  workflowId: string,
  error: unknown,
): BulkOperationError {
  return {
    id: workflowId,
    error: error instanceof Error ? error.message : String(error),
  };
}

function getMinimumRetentionMs(internals: EngineInternals): number | null {
  let minimumRetentionMs: number | null = null;

  const considerRetentionPolicy = (policy: NormalizedRetentionPolicy | null | undefined): void => {
    for (const retentionMs of [
      policy?.completed,
      policy?.failed,
      policy?.cancelled,
      policy?.timedOut,
    ]) {
      if (retentionMs === undefined) continue;

      minimumRetentionMs =
        minimumRetentionMs === null ? retentionMs : Math.min(minimumRetentionMs, retentionMs);
    }
  };

  considerRetentionPolicy(internals.options.retention);
  for (const registration of internals.registrations.values()) {
    considerRetentionPolicy(registration.retention);
  }

  return minimumRetentionMs;
}

async function* streamExpiredRetentionWorkflowStates(
  internals: EngineInternals,
  now: number,
): AsyncGenerator<WorkflowState> {
  const minimumRetentionMs = getMinimumRetentionMs(internals);
  if (minimumRetentionMs === null) return;

  const terminalWorkflowPrefix = KEYS.terminalWorkflowPrefix();
  const newestPossibleExpiredUpdatedAt = now - minimumRetentionMs;
  const upperBound = `${terminalWorkflowPrefix}${String(newestPossibleExpiredUpdatedAt).padStart(16, '0')}:\xff`;

  for await (const [key] of internals.storage.scan(terminalWorkflowPrefix, {
    lte: upperBound,
  })) {
    const encodedWorkflowId = key.slice(key.lastIndexOf(':') + 1);
    const workflowId = tryDecodeStorageKeyComponent(encodedWorkflowId);
    if (workflowId === null) continue;

    const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
    if (!stateBytes) {
      await internals.storage.delete(key);
      continue;
    }

    const state = decodeWorkflowState(stateBytes);
    if (!isTerminalWorkflowStatus(state.status)) continue;

    yield state;
  }
}

async function snapshotMatchingWorkflowSnapshots(
  internals: EngineInternals,
  filter?: ListFilter,
): Promise<BulkWorkflowSnapshot[]> {
  const snapshots: BulkWorkflowSnapshot[] = [];

  // Snapshot ids before mutating workflow state entries so storage scans
  // cannot skip or re-visit workflows when backends reorder after writes.
  for await (const batch of streamWorkflowStateBatches(internals, filter))
    for (const state of batch) snapshots.push(workflowStateToBulkSnapshot(state));

  return snapshots;
}

function workflowStateToBulkSnapshot(state: WorkflowState): BulkWorkflowSnapshot {
  return {
    id: state.id,
    type: state.type,
    status: state.status,
    updatedAt: state.updatedAt,
    ...(state.tenant?.id === undefined ? {} : { tenantId: state.tenant.id }),
  };
}

function uniqueSorted<const T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function sanitizeBulkTokenValue(value: unknown): unknown {
  if (isBulkTokenPrimitive(value)) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return '[function]';
  if (Array.isArray(value)) return value.map(sanitizeBulkTokenValue);

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).toSorted()) {
    result[key] = sanitizeBulkTokenValue(record[key]);
  }
  return result;
}

function isBulkTokenPrimitive(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

async function collectTerminalWorkflowSnapshots(
  internals: EngineInternals,
  filter: ListFilter,
): Promise<BulkWorkflowSnapshot[]> {
  const snapshots: BulkWorkflowSnapshot[] = [];
  for await (const batch of streamWorkflowStateBatches(internals, filter)) {
    for (const state of batch) {
      if (!isTerminalWorkflowStatus(state.status)) {
        throw new BulkDeleteRequiresTerminalWorkflowsError();
      }
      snapshots.push(workflowStateToBulkSnapshot(state));
    }
  }
  return snapshots;
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

function resolvePurgeWindow(
  _internals: EngineInternals,
  filter: ListFilter | undefined,
  fallbackLimit: number | undefined,
): { effectiveLimit: number | undefined; manualOffset: number } {
  return {
    manualOffset: normalizePurgeOffset(filter?.offset),
    effectiveLimit: resolvePurgeLimit(normalizePurgeLimit(filter?.limit), fallbackLimit),
  };
}

function normalizePurgeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isFinite(offset)) return 0;
  if (offset <= 0) return 0;
  return Math.floor(offset);
}

function normalizePurgeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return undefined;
  if (limit < 0) return undefined;
  return Math.floor(limit);
}

function resolvePurgeLimit(
  manualLimit: number | undefined,
  fallbackLimit: number | undefined,
): number | undefined {
  if (manualLimit === undefined) return fallbackLimit;
  if (fallbackLimit === undefined) return manualLimit;
  return Math.min(manualLimit, fallbackLimit);
}

function shouldPurgeWorkflowState(
  internals: EngineInternals,
  state: WorkflowState,
  expiredOnly: boolean,
  now: number,
): boolean {
  if (!isTerminalWorkflowStatus(state.status)) return false;

  if (!expiredOnly) return true;

  const deadline = getWorkflowRetentionDeadline(internals, state);
  return deadline !== null && deadline <= now;
}

function getWorkflowRetentionDeadline(
  internals: EngineInternals,
  state: WorkflowState,
): number | null {
  if (!isTerminalWorkflowStatus(state.status)) return null;

  const policy = internals.registrations.get(state.type)?.retention ?? internals.options.retention;
  const retentionMs = resolveRetentionForStatus(policy, state.status);
  if (retentionMs === undefined) return null;

  return state.updatedAt + retentionMs;
}

async function purgeWorkflow(
  internals: EngineInternals,
  state: WorkflowState,
  cleanupWaiters: CleanupWaiters,
): Promise<void> {
  const workflowId = state.id;
  const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
  const deleteOperations = buildWorkflowIndexDeleteOperations(state, attributeBytes);
  const deleteKeys = await collectWorkflowPurgeDeleteKeys(internals, state);
  appendKeyDeleteOperations(deleteOperations, deleteKeys);
  deleteOperations.push(
    ...buildWorkflowVisibilityIndexTransition(workflowId, state, null).batchOps,
  );
  await internals.storage.batch(deleteOperations);
  internals.checkpoints.delete(workflowId);
  internals.heartbeatDetails.delete(workflowId);
  internals.eventLogHeads.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
  internals.handleCache.delete(workflowId);
  internals.resultResolvers.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
  internals.workflowNestingDepths.delete(workflowId);
  cleanupWaiters(workflowId);
}

function buildWorkflowIndexDeleteOperations(
  state: WorkflowState,
  attributeBytes: Uint8Array | null,
): BatchOperation[] {
  return [
    ...buildSearchAttributeDeleteOperations(state.id, attributeBytes),
    ...buildTagIndexDeleteOperations(state),
  ];
}

function buildSearchAttributeDeleteOperations(
  workflowId: string,
  attributeBytes: Uint8Array | null,
): BatchOperation[] {
  if (!attributeBytes) return [];
  const currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
  return buildIndexOperations(workflowId, currentAttributes, {}).filter(isDeleteOperation);
}

function buildTagIndexDeleteOperations(state: WorkflowState): BatchOperation[] {
  return buildWorkflowTagIndexOperations(
    state.id,
    normalizeWorkflowTags(state.tags),
    undefined,
  ).filter(isDeleteOperation);
}

function isDeleteOperation(operation: BatchOperation): operation is BatchOperation {
  return operation.type === 'delete';
}

async function collectWorkflowPurgeDeleteKeys(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<Set<string>> {
  const workflowId = state.id;
  const deleteKeys = buildBaseWorkflowDeleteKeys(state);
  addExecutionDeadlineDeleteKeys(deleteKeys, state);
  addTerminalCleanupDeleteKey(deleteKeys, state);
  await addUpdateRequestDeleteKeys(internals.storage, deleteKeys, workflowId);
  await addWorkflowPrefixDeleteKeys(internals.storage, deleteKeys, workflowId);
  return deleteKeys;
}

function buildBaseWorkflowDeleteKeys(state: WorkflowState): Set<string> {
  return new Set([
    KEYS.workflow(state.id),
    KEYS.checkpoint(state.id),
    KEYS.workflowHeaders(state.id),
    KEYS.terminalCleanupNeeded(state.id),
    KEYS.attribute(state.id),
    KEYS.terminalWorkflow(state.updatedAt, state.id),
  ]);
}

function addExecutionDeadlineDeleteKeys(deleteKeys: Set<string>, state: WorkflowState): void {
  if (state.executionDeadline === undefined) return;
  deleteKeys.add(KEYS.deadline(state.executionDeadline, state.id));
  deleteKeys.add(`timer-idx:deadline:${state.id}`);
}

function addTerminalCleanupDeleteKey(deleteKeys: Set<string>, state: WorkflowState): void {
  if (state.terminalCleanupToken === undefined) return;
  const terminalCleanupTimerId = createTerminalCleanupTimerId(
    shouldCleanupTerminalOutputArtifacts(state),
    state.terminalCleanupToken,
  );
  deleteKeys.add(
    KEYS.terminalCleanup(state.updatedAt + TERMINAL_CLEANUP_DELAY_MS, terminalCleanupTimerId),
  );
}

function shouldCleanupTerminalOutputArtifacts(state: WorkflowState): boolean {
  return state.status === 'cancelled' || state.status === 'timed-out';
}

async function addUpdateRequestDeleteKeys(
  storage: WeftStorage,
  deleteKeys: Set<string>,
  workflowId: string,
): Promise<void> {
  const updateRequestPrefix = KEYS.updatePrefix(workflowId);
  const updateRequestKeys = await collectKeysForPrefix(storage, updateRequestPrefix);
  for (const key of updateRequestKeys) {
    deleteKeys.add(key);
    addUpdateResponseDeleteKey(deleteKeys, updateRequestPrefix, key);
  }
}

function addUpdateResponseDeleteKey(
  deleteKeys: Set<string>,
  updateRequestPrefix: string,
  updateRequestKey: string,
): void {
  const updateId = updateRequestKey.slice(updateRequestPrefix.length);
  if (updateId.length > 0) deleteKeys.add(KEYS.updateResponse(updateId));
}

async function addWorkflowPrefixDeleteKeys(
  storage: WeftStorage,
  deleteKeys: Set<string>,
  workflowId: string,
): Promise<void> {
  for (const prefix of workflowPurgePrefixes(workflowId)) {
    const keys = await collectKeysForPrefix(storage, prefix);
    for (const key of keys) deleteKeys.add(key);
  }
}

function workflowPurgePrefixes(workflowId: string): string[] {
  const encodedWorkflowId = encodeStorageKeyComponent(workflowId);
  return [
    `wf:${encodedWorkflowId}:ckpt:`,
    `ev:${encodedWorkflowId}:`,
    `sig:${encodedWorkflowId}:`,
    `review:${encodedWorkflowId}:`,
    `offload:${encodedWorkflowId}:`,
    `archive:${encodedWorkflowId}:`,
    `blob:${encodedWorkflowId}:`,
    `state:execution:${encodedWorkflowId}:`,
    `tool-effect:${encodedWorkflowId}:`,
    `upk:${encodedWorkflowId}:`,
  ];
}

function appendKeyDeleteOperations(
  deleteOperations: BatchOperation[],
  deleteKeys: Iterable<string>,
): void {
  for (const key of deleteKeys) deleteOperations.push({ type: 'delete', key });
}

async function collectKeysForPrefix(storage: WeftStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storageKeys(storage, prefix)) keys.push(key);
  return keys;
}
