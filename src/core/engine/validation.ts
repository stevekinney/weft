/* oxlint-disable max-lines -- ID:core-engine-validation-file-length */
import { decode } from '../codec.ts';
import { isRecord } from '../debug-output.ts';
import { normalizeFailureCategory } from '../failure-categories.ts';
import { parseCronExpression } from '../schedule.ts';
import { coerceStartWorkflowId, parseStartWorkflowDuration } from '../start-workflow-validation.ts';
import type {
  NormalizedRetentionPolicy,
  RetentionPolicy,
  ScheduleAccessOptions,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleState,
  ScheduleStatus,
  WorkflowState,
  WorkflowStatus,
  WorkflowTimelineEntry,
  WorkflowTimelineStatus,
} from '../types.ts';
import { isWorkflowTagArray } from '../workflow-tags.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';
const WORKFLOW_TIMELINE_STATUSES = new Set<WorkflowTimelineStatus>([
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);
export const SCHEDULE_STATUSES = new Set<ScheduleStatus>(['active', 'paused', 'cancelled']);
export const SCHEDULE_OVERLAP_POLICIES = new Set<ScheduleOverlapPolicy>([
  'skip',
  'queue',
  'cancel-running',
  'allow',
]);
export function isSanitizedSearchAttributeValue(
  value: unknown,
): value is import('../types.ts').SearchAttributeValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
export function isWorkflowVersionTuple(value: unknown): value is WorkflowVersionTuple {
  if (!isRecord(value) || typeof value['workflowVersion'] !== 'string') {
    return false;
  }

  if (value['agentVersion'] !== undefined && typeof value['agentVersion'] !== 'string') {
    return false;
  }

  return (
    value['toolVersions'] === undefined ||
    (Array.isArray(value['toolVersions']) &&
      value['toolVersions'].every((entry) => typeof entry === 'string'))
  );
}
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
export function isTimelineStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
// oxlint-disable-next-line complexity -- ID:core-engine-is-workflow-timeline-entry-complexity
export function isWorkflowTimelineEntry(value: unknown): value is WorkflowTimelineEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isTimelineStep(value['step']) &&
    typeof value['operationType'] === 'string' &&
    typeof value['operationLabel'] === 'string' &&
    typeof value['inputSummary'] === 'string' &&
    isFiniteNumber(value['timestamp']) &&
    WORKFLOW_TIMELINE_STATUSES.has(value['status'] as WorkflowTimelineStatus) &&
    (value['outputSummary'] === undefined || typeof value['outputSummary'] === 'string') &&
    (value['duration'] === undefined || isFiniteNumber(value['duration'])) &&
    (value['versionTuple'] === undefined || isWorkflowVersionTuple(value['versionTuple']))
  );
}
export function isValidScheduleTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function isValidScheduleStatus(value: unknown): value is ScheduleStatus {
  return typeof value === 'string' && SCHEDULE_STATUSES.has(value as ScheduleStatus);
}
export function isValidScheduleOverlapPolicy(value: unknown): value is ScheduleOverlapPolicy {
  return typeof value === 'string' && SCHEDULE_OVERLAP_POLICIES.has(value as ScheduleOverlapPolicy);
}
export function isValidScheduleIdentifier(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    coerceStartWorkflowId(value, 'schedule id');
    return true;
  } catch {
    return false;
  }
}
export function coerceScheduleId(scheduleId: string, fieldName: string): string {
  return coerceStartWorkflowId(scheduleId, fieldName);
}
export function coerceScheduleTenantId(tenantId: string, fieldName: string): string {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return tenantId;
}
export function normalizeBulkFilterNumber(
  value: unknown,
  fieldName: 'limit' | 'offset',
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`filter.${fieldName} must be a non-negative number when provided`);
  }

  return Math.floor(value);
}
export function normalizeScheduleOptions(
  options: ScheduleOptions | undefined,
): Required<Pick<ScheduleOptions, 'overlap' | 'backfill'>> & { id?: string } {
  if (options === undefined) {
    return { overlap: 'skip', backfill: false };
  }

  if (typeof options !== 'object' || options === null) {
    throw new Error('options must be an object when provided');
  }

  const { id, overlap, backfill } = options;
  const normalizedOptions: Required<Pick<ScheduleOptions, 'overlap' | 'backfill'>> & {
    id?: string;
  } = {
    overlap: 'skip',
    backfill: false,
  };

  if (id !== undefined) {
    normalizedOptions.id = coerceScheduleId(id, 'options.id');
  }

  if (overlap !== undefined) {
    if (!SCHEDULE_OVERLAP_POLICIES.has(overlap)) {
      throw new Error(
        `options.overlap must be one of ${[...SCHEDULE_OVERLAP_POLICIES].join(', ')}`,
      );
    }
    normalizedOptions.overlap = overlap;
  }

  if (backfill !== undefined) {
    if (typeof backfill !== 'boolean') {
      throw new Error('options.backfill must be a boolean when provided');
    }
    normalizedOptions.backfill = backfill;
  }

  return normalizedOptions;
}
export function normalizeScheduleAccessOptions(
  accessOptions: ScheduleAccessOptions | undefined,
): ScheduleAccessOptions | undefined {
  if (accessOptions === undefined) {
    return undefined;
  }

  if (typeof accessOptions !== 'object' || accessOptions === null) {
    throw new Error('accessOptions must be an object when provided');
  }

  const { tenantId } = accessOptions;
  if (tenantId === undefined) {
    return {};
  }

  return {
    tenantId: coerceScheduleTenantId(tenantId, 'accessOptions.tenantId'),
  };
}
// oxlint-disable-next-line complexity -- ID:core-engine-normalize-schedule-filter-complexity
export function normalizeScheduleFilter(
  filter: ScheduleFilter | undefined,
): ScheduleFilter | undefined {
  if (filter === undefined) {
    return undefined;
  }

  if (typeof filter !== 'object' || filter === null) {
    throw new Error('filter must be an object when provided');
  }

  const { status, workflowType, tenantId, limit, offset } = filter;

  if (status !== undefined) {
    const statuses = Array.isArray(status) ? status : [status];
    for (const candidateStatus of statuses) {
      if (!SCHEDULE_STATUSES.has(candidateStatus)) {
        throw new Error(`filter.status must be one of ${[...SCHEDULE_STATUSES].join(', ')}`);
      }
    }
  }

  if (workflowType !== undefined) {
    if (typeof workflowType !== 'string' || workflowType.length === 0) {
      throw new Error('filter.workflowType must be a non-empty string when provided');
    }
  }

  if (tenantId !== undefined) {
    coerceScheduleTenantId(tenantId, 'filter.tenantId');
  }

  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error('filter.limit must be a non-negative safe integer when provided');
  }

  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
    throw new Error('filter.offset must be a non-negative safe integer when provided');
  }

  return filter;
}

/**
 * Type predicate that validates a decoded `tenant` field is shaped like a
 * {@link import('../tenant.ts').TenantContext}. Returns true only when `tenant`
 * is `undefined`, or an object with a non-empty string `id` and (when present)
 * an `attributes` object. Defensive because `state.tenant` is fed directly
 * surfaced to workflow code as `ctx.tenant`; a corrupt or tampered storage
 * record could otherwise inject a forged tenant identity into security
 * decisions.
 *
 * `null` is rejected intentionally — the canonical "no tenant" value is
 * `undefined`. A stored `null` indicates corruption.
 */
export function isValidDecodedTenant(
  value: unknown,
): value is import('../tenant.ts').TenantContext | undefined {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) return false;
  const attributes = record['attributes'];
  if (attributes !== undefined && (attributes === null || typeof attributes !== 'object')) {
    return false;
  }
  return true;
}
export function isValidDecodedTags(value: unknown): value is string[] | undefined {
  return value === undefined || isWorkflowTagArray(value);
}
export function decodeWorkflowState(bytes: Uint8Array): WorkflowState {
  // bytes were written by encode(WorkflowState) — shape is guaranteed by our own storage
  const state = decode(bytes) as WorkflowState;
  // Defensive check on the security-relevant tenant field. Other fields are
  // trusted by construction, but `tenant` feeds directly into workflow decision
  // functions so we refuse to propagate a forged identity. On invalid shape we
  // log a warning and fall back to `undefined` (the safe default) rather than
  // throwing — refusing to decode would break recovery for unrelated workflows
  // sharing the same storage backend.
  if (!isValidDecodedTenant(state.tenant)) {
    console.warn(
      `[weft] Decoded workflow state for "${String(state.id)}" has an invalid tenant field; ` +
        `falling back to undefined tenant. This usually indicates corruption or tampering of ` +
        `the storage record.`,
    );
    delete state.tenant;
  }
  if (!isValidDecodedTags(state.tags)) {
    console.warn(
      `[weft] Decoded workflow state for "${String(state.id)}" has invalid tags; ` +
        'dropping the malformed tag list from the decoded state.',
    );
    delete state.tags;
  }
  if (state.failureCategory !== undefined && state.failureCategory !== null) {
    const normalizedFailureCategory = normalizeFailureCategory(state.failureCategory);
    if (normalizedFailureCategory === undefined) {
      delete state.failureCategory;
    } else {
      state.failureCategory = normalizedFailureCategory;
    }
  }
  if (state.executionStateOwnerId !== undefined) {
    try {
      coerceStartWorkflowId(state.executionStateOwnerId, 'executionStateOwnerId');
    } catch {
      console.warn(
        `[weft] Decoded workflow state for "${String(state.id)}" has an invalid ` +
          'executionStateOwnerId field; falling back to the workflow id as the execution owner. ' +
          'This usually indicates corruption or tampering of the storage record.',
      );
      delete state.executionStateOwnerId;
    }
  }
  return state;
}
export function rejectInvalidScheduleRecord(scheduleId: string | undefined, message: string): null {
  const prefix =
    scheduleId === undefined
      ? '[weft] Ignoring malformed schedule record'
      : `[weft] Ignoring malformed schedule "${scheduleId}"`;
  console.warn(`${prefix} ${message}.`);
  return null;
}
export function decodeScheduleIdentityFields(
  decoded: Record<string, unknown>,
): Pick<ScheduleState, 'id' | 'workflowType' | 'cronExpression' | 'status' | 'overlap'> | null {
  const id = decoded['id'];
  if (!isValidScheduleIdentifier(id)) {
    return rejectInvalidScheduleRecord(undefined, 'with invalid id');
  }

  const workflowType = decoded['workflowType'];
  if (typeof workflowType !== 'string' || workflowType.length === 0) {
    return rejectInvalidScheduleRecord(id, 'with invalid workflowType');
  }

  const cronExpression = decoded['cronExpression'];
  if (typeof cronExpression !== 'string') {
    return rejectInvalidScheduleRecord(id, 'with invalid cronExpression');
  }
  try {
    parseCronExpression(cronExpression);
  } catch {
    return rejectInvalidScheduleRecord(id, 'with invalid cronExpression');
  }

  const status = decoded['status'];
  if (!isValidScheduleStatus(status)) {
    return rejectInvalidScheduleRecord(id, 'with invalid status');
  }

  const overlap = decoded['overlap'];
  if (!isValidScheduleOverlapPolicy(overlap)) {
    return rejectInvalidScheduleRecord(id, 'with invalid overlap policy');
  }

  return {
    id,
    workflowType,
    cronExpression,
    status,
    overlap,
  };
}
// oxlint-disable-next-line complexity -- ID:core-engine-decode-schedule-runtime-fields-complexity
export function decodeScheduleRuntimeFields(
  decoded: Record<string, unknown>,
  scheduleId: string,
): Pick<
  ScheduleState,
  | 'backfill'
  | 'createdAt'
  | 'updatedAt'
  | 'lastFireAt'
  | 'nextFireAt'
  | 'currentWorkflowId'
  | 'queuedRuns'
  | 'tenant'
> | null {
  const backfill = decoded['backfill'];
  if (typeof backfill !== 'boolean') {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid backfill flag');
  }

  const createdAt = decoded['createdAt'];
  const updatedAt = decoded['updatedAt'];
  if (!isValidScheduleTimestamp(createdAt) || !isValidScheduleTimestamp(updatedAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid timestamps');
  }

  const lastFireAt = decoded['lastFireAt'];
  if (lastFireAt !== undefined && !isValidScheduleTimestamp(lastFireAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid lastFireAt');
  }

  const nextFireAt = decoded['nextFireAt'];
  if (nextFireAt === undefined) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid nextFireAt');
  }
  if (nextFireAt !== null && !isValidScheduleTimestamp(nextFireAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid nextFireAt');
  }

  const currentWorkflowId = decoded['currentWorkflowId'];
  if (currentWorkflowId !== undefined && !isValidScheduleIdentifier(currentWorkflowId)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid currentWorkflowId');
  }

  const queuedRuns = decoded['queuedRuns'];
  if (typeof queuedRuns !== 'number' || !Number.isSafeInteger(queuedRuns) || queuedRuns < 0) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid queuedRuns');
  }

  const tenant = decoded['tenant'];
  if (!isValidDecodedTenant(tenant)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid tenant');
  }

  return {
    backfill,
    createdAt,
    updatedAt,
    ...(lastFireAt !== undefined && { lastFireAt }),
    nextFireAt,
    ...(currentWorkflowId !== undefined && { currentWorkflowId }),
    queuedRuns,
    ...(tenant !== undefined && { tenant }),
  };
}
export function decodeScheduleState(bytes: Uint8Array): ScheduleState | null {
  const decoded = decode(bytes);
  if (!isRecord(decoded)) {
    console.warn('[weft] Ignoring malformed schedule record with non-object payload.');
    return null;
  }

  const identity = decodeScheduleIdentityFields(decoded);
  if (!identity) {
    return null;
  }

  const runtime = decodeScheduleRuntimeFields(decoded, identity.id);
  if (!runtime) {
    return null;
  }

  return {
    ...identity,
    input: decoded['input'],
    ...runtime,
  };
}
export function normalizeRetentionDuration(
  value: import('../types.ts').Duration | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const milliseconds = parseStartWorkflowDuration(value, fieldName);
  return Math.ceil(milliseconds);
}
export function normalizeRetentionPolicy(
  policy: RetentionPolicy | undefined,
  context: string,
): NormalizedRetentionPolicy | null {
  if (!policy) {
    return null;
  }

  const normalized: NormalizedRetentionPolicy = {};
  const completed = normalizeRetentionDuration(policy.completed, `${context}.completed`);
  const failed = normalizeRetentionDuration(policy.failed, `${context}.failed`);
  const cancelled = normalizeRetentionDuration(policy.cancelled, `${context}.cancelled`);
  const timedOut = normalizeRetentionDuration(policy.timedOut, `${context}.timedOut`);

  if (completed !== undefined) {
    normalized.completed = completed;
  }
  if (failed !== undefined) {
    normalized.failed = failed;
  }
  if (cancelled !== undefined) {
    normalized.cancelled = cancelled;
  }
  if (timedOut !== undefined) {
    normalized.timedOut = timedOut;
  }

  const isEmpty =
    normalized.completed === undefined &&
    normalized.failed === undefined &&
    normalized.cancelled === undefined &&
    normalized.timedOut === undefined;

  return isEmpty ? null : normalized;
}
export function resolveRetentionForStatus(
  policy: NormalizedRetentionPolicy | null | undefined,
  status: WorkflowStatus,
): number | undefined {
  switch (status) {
    case 'completed':
      return policy?.completed;
    case 'failed':
      return policy?.failed;
    case 'cancelled':
      return policy?.cancelled;
    case 'timed-out':
      return policy?.timedOut;
    default:
      return undefined;
  }
}
export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed-out'
  );
}
export function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
