import { decode } from '../../codec.ts';
import { isRecord } from '../../debug-output.ts';
import { parseCronExpression } from '../../schedule.ts';
import { coerceStartWorkflowId } from '../../start-workflow-validation.ts';
import type {
  ScheduleFilter,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleState,
  ScheduleStatus,
} from '../../types.ts';

export const SCHEDULE_STATUSES = new Set<ScheduleStatus>(['active', 'paused', 'cancelled']);
export const SCHEDULE_OVERLAP_POLICIES = new Set<ScheduleOverlapPolicy>([
  'skip',
  'queue',
  'cancel-running',
  'allow',
]);

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

function validateScheduleFilterStatus(status: ScheduleFilter['status']): void {
  if (status === undefined) return;
  const statuses = Array.isArray(status) ? status : [status];
  for (const candidateStatus of statuses) {
    if (!SCHEDULE_STATUSES.has(candidateStatus)) {
      throw new Error(`filter.status must be one of ${[...SCHEDULE_STATUSES].join(', ')}`);
    }
  }
}

function validateScheduleFilterWorkflowType(workflowType: ScheduleFilter['workflowType']): void {
  if (workflowType === undefined) return;
  if (typeof workflowType !== 'string' || workflowType.length === 0) {
    throw new Error('filter.workflowType must be a non-empty string when provided');
  }
}

function validateScheduleFilterBound(
  value: number | undefined,
  fieldName: 'limit' | 'offset',
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`filter.${fieldName} must be a non-negative safe integer when provided`);
  }
}

export function normalizeScheduleFilter(
  filter: ScheduleFilter | undefined,
): ScheduleFilter | undefined {
  if (filter === undefined) {
    return undefined;
  }

  if (typeof filter !== 'object' || filter === null) {
    throw new Error('filter must be an object when provided');
  }

  validateScheduleFilterStatus(filter.status);
  validateScheduleFilterWorkflowType(filter.workflowType);
  validateScheduleFilterBound(filter.limit, 'limit');
  validateScheduleFilterBound(filter.offset, 'offset');

  return filter;
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

type ScheduleRuntimeFields = Pick<
  ScheduleState,
  | 'backfill'
  | 'createdAt'
  | 'updatedAt'
  | 'lastFireAt'
  | 'nextFireAt'
  | 'currentWorkflowId'
  | 'queuedRuns'
>;

function decodeScheduleBackfill(
  decoded: Record<string, unknown>,
  scheduleId: string,
): boolean | null {
  const backfill = decoded['backfill'];
  if (typeof backfill !== 'boolean') {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid backfill flag');
    return null;
  }
  return backfill;
}

function decodeScheduleTimestamps(
  decoded: Record<string, unknown>,
  scheduleId: string,
): { createdAt: number; updatedAt: number; lastFireAt?: number } | null {
  const createdAt = decoded['createdAt'];
  const updatedAt = decoded['updatedAt'];
  if (!isValidScheduleTimestamp(createdAt) || !isValidScheduleTimestamp(updatedAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid timestamps');
  }

  const lastFireAt = decoded['lastFireAt'];
  if (lastFireAt !== undefined && !isValidScheduleTimestamp(lastFireAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid lastFireAt');
  }

  return {
    createdAt,
    updatedAt,
    ...(lastFireAt !== undefined && { lastFireAt }),
  };
}

function decodeScheduleNextFireAt(
  decoded: Record<string, unknown>,
  scheduleId: string,
): { ok: true; value: number | null } | { ok: false } {
  const nextFireAt = decoded['nextFireAt'];
  if (nextFireAt === undefined) {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid nextFireAt');
    return { ok: false };
  }
  if (nextFireAt !== null && !isValidScheduleTimestamp(nextFireAt)) {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid nextFireAt');
    return { ok: false };
  }
  return { ok: true, value: nextFireAt };
}

function decodeScheduleCurrentWorkflowId(
  decoded: Record<string, unknown>,
  scheduleId: string,
): { value?: string; ok: boolean } {
  const currentWorkflowId = decoded['currentWorkflowId'];
  if (currentWorkflowId === undefined) {
    return { ok: true };
  }
  if (!isValidScheduleIdentifier(currentWorkflowId)) {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid currentWorkflowId');
    return { ok: false };
  }
  return { ok: true, value: currentWorkflowId };
}

function decodeScheduleQueuedRuns(
  decoded: Record<string, unknown>,
  scheduleId: string,
): number | null {
  const queuedRuns = decoded['queuedRuns'];
  if (typeof queuedRuns !== 'number' || !Number.isSafeInteger(queuedRuns) || queuedRuns < 0) {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid queuedRuns');
    return null;
  }
  return queuedRuns;
}

export function decodeScheduleRuntimeFields(
  decoded: Record<string, unknown>,
  scheduleId: string,
): ScheduleRuntimeFields | null {
  const backfill = decodeScheduleBackfill(decoded, scheduleId);
  if (backfill === null) return null;

  const timestamps = decodeScheduleTimestamps(decoded, scheduleId);
  if (timestamps === null) return null;

  const nextFireAt = decodeScheduleNextFireAt(decoded, scheduleId);
  if (!nextFireAt.ok) return null;

  const currentWorkflow = decodeScheduleCurrentWorkflowId(decoded, scheduleId);
  if (!currentWorkflow.ok) return null;

  const queuedRuns = decodeScheduleQueuedRuns(decoded, scheduleId);
  if (queuedRuns === null) return null;

  // Legacy schedule records may carry a `tenant` field; it is ignored
  // (tolerate-and-drop) so old persisted schedules still decode.
  return {
    backfill,
    ...timestamps,
    nextFireAt: nextFireAt.value,
    ...(currentWorkflow.value !== undefined && { currentWorkflowId: currentWorkflow.value }),
    queuedRuns,
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
