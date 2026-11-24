import { KEYS } from '../../storage/keys.ts';
import { WorkerDeploymentVersionRemovedError } from '../../worker/deployment-version-removed-error.ts';
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
  WorkflowStatus,
} from '../types.ts';
import {
  MAX_BULK_CONFIRMATION_TOKEN_LENGTH,
  MAX_BULK_OPERATION_REQUEST_ID_LENGTH,
} from '../types/bulk.ts';
import { normalizeWorkflowTags } from '../workflow-tags.ts';
import {
  snapshotMatchingWorkflowSnapshots,
  type BulkWorkflowSnapshot,
  type ScannedRuns,
} from './bulk-scanned-runs.ts';
import { BulkOperationConfirmationError, EngineDisposedError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import { trackPurgeWrite } from './purge-write-tracking.ts';

export const BULK_OPERATION_SAMPLE_LIMIT = 20;
export const DEFAULT_BULK_OPERATION_CONCURRENCY = 1;
const DEFAULT_BULK_OPERATION_PRINCIPAL: BulkOperationPrincipal = { method: 'in-process' };

export type BulkWorkflowPoolResult<TItem, TResult> =
  | { item: TItem; status: 'fulfilled'; value: TResult }
  | { item: TItem; status: 'rejected'; reason: unknown };

/**
 * Shared bounded-concurrency runner every bulk operation (cancel, retry,
 * signal, delete) uses to drive its per-workflow work: runs `items` in
 * fixed-size batches of `concurrencyLimit`, capturing each item's outcome
 * rather than letting one rejection abort the batch (mirrors
 * `Promise.allSettled`, but keyed back to the originating `item` so a
 * caller can map a failure to the workflow it belongs to).
 */
export async function runBulkWorkflowPool<TItem, TResult>(
  items: readonly TItem[],
  concurrencyLimit: number,
  operation: (item: TItem) => Promise<TResult>,
): Promise<BulkWorkflowPoolResult<TItem, TResult>[]> {
  const results: BulkWorkflowPoolResult<TItem, TResult>[] = [];

  for (let batchStart = 0; batchStart < items.length; batchStart += concurrencyLimit) {
    const batchItems = items.slice(batchStart, batchStart + concurrencyLimit);
    results.push(
      ...(await Promise.all(
        batchItems.map(async (item): Promise<BulkWorkflowPoolResult<TItem, TResult>> => {
          try {
            return { item, status: 'fulfilled', value: await operation(item) };
          } catch (reason) {
            return { item, status: 'rejected', reason };
          }
        }),
      )),
    );
  }

  return results;
}

export type BulkOperationPreparation = {
  workflowIds: string[];
  /** The run each id held in the scan the token names; see `bulkRunMoved`. */
  runs: ScannedRuns;
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
    runs: new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.workflowExecutionToken])),
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
  copyDefinedFields(summary, filter, ['type', 'scheduleId']);
  const normalizedTags = normalizeWorkflowTags(filter.tags);
  if (normalizedTags !== undefined) {
    summary.tags = normalizedTags;
  }
  if (filter.attributes !== undefined) {
    summary.attributes = summarizeAttributeFilters(filter.attributes);
  }
  // Every condition that chose the runs is kept, so the preview and the audit record say what
  // the operation acted on, never a wider filter than it matched.
  copyDefinedFields(summary, filter, ['failedStep', 'retrying', 'limit', 'offset']);

  return summary;
}

/** The fields of a bulk filter copied as they are: each one set, in the order named, so the summary
 * keeps one key order for its digest. */
function copyDefinedFields(
  summary: BulkOperationFilterSummary,
  filter: ListFilter,
  keys: readonly ('type' | 'scheduleId' | 'failedStep' | 'retrying' | 'limit' | 'offset')[],
): void {
  for (const key of keys) {
    const value = filter[key];
    if (value !== undefined) Object.assign(summary, { [key]: value });
  }
}

/** The attribute conditions of a bulk filter, each copied and in a stable order. */
function summarizeAttributeFilters(
  attributes: NonNullable<ListFilter['attributes']>,
): NonNullable<BulkOperationFilterSummary['attributes']> {
  return attributes
    .map((attribute) => ({
      key: searchAttributeName(attribute.key),
      ...(attribute.value === undefined
        ? {}
        : { value: Array.isArray(attribute.value) ? [...attribute.value] : attribute.value }),
      ...(attribute.gt === undefined ? {} : { gt: attribute.gt }),
      ...(attribute.lt === undefined ? {} : { lt: attribute.lt }),
      ...(attribute.gte === undefined ? {} : { gte: attribute.gte }),
      ...(attribute.lte === undefined ? {} : { lte: attribute.lte }),
    }))
    .toSorted((left, right) => computeSemanticHash(left).localeCompare(computeSemanticHash(right)));
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
      // `null` for a run stored before the token existed, so the hash never reads `undefined`.
      run: snapshot.workflowExecutionToken ?? null,
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

/**
 * Persist the audit event of a bulk operation that is about to fail part-way: `affectedCount` is
 * what did commit, and the failure is recorded on the event (`failedCount`, and up to the sample
 * limit of the errors), so the record of what the operation changed is not lost with the throw.
 */
export function persistFailedBulkAuditEvent(
  internals: EngineInternals,
  preparation: BulkOperationPreparation,
  options: BulkOperationCommitOptions,
  affectedCount: number,
  errors: readonly BulkOperationError[],
): Promise<BulkOperationAuditEvent> {
  return persistBulkOperationAuditEvent(internals, preparation, options, affectedCount, errors);
}

async function persistBulkOperationAuditEvent(
  internals: EngineInternals,
  preparation: BulkOperationPreparation,
  options: BulkOperationCommitOptions,
  affectedCount: number,
  errors: readonly BulkOperationError[] = [],
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
    ...(errors.length === 0
      ? {}
      : {
          failedCount: errors.length,
          errors: errors.slice(0, BULK_OPERATION_SAMPLE_LIMIT),
        }),
  };

  // A disposed engine issues no new writes: the bulk operation's own writes
  // already landed, and the record is skipped (a purge that failed part-way adds this
  // refusal to the failures it throws). One already issued is tracked so async
  // disposal lets it land.
  if (internals.disposed) throw new EngineDisposedError();
  await trackPurgeWrite(
    internals,
    internals.storage.put(
      KEYS.bulkOperationAudit(timestamp, requestId, preparation.confirmationToken),
      encode(auditEvent),
    ),
  );
  return auditEvent;
}

export function normalizeBulkOperationOptions<TOptions extends BulkOperationOptions>(
  options: TOptions,
): TOptions {
  const bulkConcurrency = options.bulkConcurrency;
  if (
    bulkConcurrency !== undefined &&
    (!Number.isSafeInteger(bulkConcurrency) || bulkConcurrency < 1)
  ) {
    throw new Error('Field "bulkConcurrency" must be a positive integer');
  }

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

export function resolveBulkOperationConcurrency(options: BulkOperationOptions): number {
  return options.bulkConcurrency ?? DEFAULT_BULK_OPERATION_CONCURRENCY;
}

export function toBulkOperationError(
  _internals: EngineInternals,
  workflowId: string,
  error: unknown,
): BulkOperationError {
  return {
    id: workflowId,
    error: error instanceof Error ? error.message : String(error),
    // A run whose deployment build has been removed is told apart from every other failure.
    ...(error instanceof WorkerDeploymentVersionRemovedError ? { reason: 'version-removed' } : {}),
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
