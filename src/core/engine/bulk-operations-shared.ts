import { KEYS } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import { computeSemanticHash } from '../effect-log/index.ts';
import { searchAttributeName } from '../search-attributes.ts';
import type {
  BulkOperationAction,
  BulkOperationAuditEvent,
  BulkOperationCommitOptions,
  BulkOperationDryRunResult,
  BulkOperationError,
  BulkOperationFilterSummary,
  BulkOperationOptions,
  BulkOperationPrincipal,
  BulkOperationScopeSummary,
  ListFilter,
  WorkflowState,
  WorkflowStatus,
} from '../types.ts';
import {
  MAX_BULK_CONFIRMATION_TOKEN_LENGTH,
  MAX_BULK_OPERATION_REQUEST_ID_LENGTH,
} from '../types/bulk.ts';
import { normalizeWorkflowTags } from '../workflow-tags.ts';
import {
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
} from './errors.ts';
import type { EngineInternals } from './internals.ts';
import { streamWorkflowStateBatches } from './listing.ts';
import { isTerminalWorkflowStatus } from './validation.ts';

export const BULK_OPERATION_SAMPLE_LIMIT = 20;
const DEFAULT_BULK_OPERATION_PRINCIPAL: BulkOperationPrincipal = { method: 'in-process' };

export type BulkWorkflowSnapshot = {
  id: string;
  type: string;
  status: WorkflowStatus;
  updatedAt: number;
};

export type BulkOperationPreparation = {
  workflowIds: string[];
  confirmationToken: string;
  preview: BulkOperationDryRunResult;
  scope: BulkOperationScopeSummary;
};

export function buildActionableBulkWorkflowFilter(
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

export async function prepareBulkOperation(
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

export function buildBulkOperationPreparation(
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

export function validateBulkConfirmation(
  options: BulkOperationCommitOptions,
  preparation: BulkOperationPreparation,
): void {
  if (options.confirmationToken === undefined) return;
  if (options.confirmationToken === preparation.confirmationToken) return;

  throw new BulkOperationConfirmationError();
}

export function shouldPersistBulkAudit(options: BulkOperationCommitOptions): boolean {
  return (
    options.confirmationToken !== undefined ||
    options.requestId !== undefined ||
    options.principal !== undefined
  );
}

export async function withBulkAuditEvent<TResult extends object>(
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

export function normalizeBulkOperationOptions<TOptions extends BulkOperationOptions>(
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

export function toBulkOperationError(
  _internals: EngineInternals,
  workflowId: string,
  error: unknown,
): BulkOperationError {
  return {
    id: workflowId,
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function snapshotMatchingWorkflowSnapshots(
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

export function workflowStateToBulkSnapshot(state: WorkflowState): BulkWorkflowSnapshot {
  return {
    id: state.id,
    type: state.type,
    status: state.status,
    updatedAt: state.updatedAt,
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

export async function collectTerminalWorkflowSnapshots(
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
