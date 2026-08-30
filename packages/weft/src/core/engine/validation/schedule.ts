import { decode } from '../../codec.ts';
import { isRecord } from '../../debug-output.ts';
import { parseCronExpression } from '../../schedule.ts';
import { parseDuration } from '../../scheduler.ts';
import { coerceStartWorkflowId } from '../../start-workflow-validation.ts';
import type {
  ScheduleFilter,
  ScheduleOverlapPolicy,
  ScheduleSpec,
  ScheduleState,
  ScheduleStatus,
} from '../../types.ts';
import { SCHEDULE_OVERLAP_POLICIES } from './schedule-options.ts';

export {
  normalizeScheduleOptions,
  normalizeScheduleUpdateOptions,
  SCHEDULE_OVERLAP_POLICIES,
} from './schedule-options.ts';

export const SCHEDULE_STATUSES = new Set<ScheduleStatus>(['active', 'paused', 'cancelled']);

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

/**
 * A recurrence specification normalized into the discriminated cadence the
 * engine persists. Interval periods are resolved to whole milliseconds.
 */
export type NormalizedScheduleSpec =
  | { kind: 'cron'; cronExpression: string }
  | { kind: 'interval'; intervalMs: number };

function normalizeIntervalEvery(every: unknown): { kind: 'interval'; intervalMs: number } {
  if (typeof every !== 'string' && typeof every !== 'number') {
    throw new Error(
      'Schedule interval "every" must be a duration string or a number of milliseconds',
    );
  }
  let milliseconds: number;
  try {
    milliseconds = parseDuration(every);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid schedule interval "every": ${message}`, { cause: error });
  }
  const intervalMs = Math.ceil(milliseconds);
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('Schedule interval "every" must resolve to a positive number of milliseconds');
  }
  return { kind: 'interval', intervalMs };
}

function normalizeCronSpec(cronExpression: unknown): { kind: 'cron'; cronExpression: string } {
  if (typeof cronExpression !== 'string') {
    throw new Error('Schedule "cron" must be a string');
  }
  parseCronExpression(cronExpression);
  return { kind: 'cron', cronExpression };
}

/**
 * Normalize a schedule recurrence specification into the persisted cadence. A
 * bare string is treated as a cron expression (preserving the original
 * cron-only API). An object must supply exactly one of `cron` or `every`.
 */
export function normalizeScheduleSpec(spec: string | ScheduleSpec): NormalizedScheduleSpec {
  if (typeof spec === 'string') {
    return normalizeCronSpec(spec);
  }
  if (typeof spec !== 'object' || spec === null) {
    throw new Error('Schedule spec must be a cron string or an object with "cron" or "every"');
  }

  const hasCron = 'cron' in spec && spec.cron !== undefined;
  const hasEvery = 'every' in spec && spec.every !== undefined;
  if (hasCron === hasEvery) {
    throw new Error('Schedule spec must specify exactly one of "cron" or "every"');
  }

  return hasEvery ? normalizeIntervalEvery(spec.every) : normalizeCronSpec(spec.cron);
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

function decodeScheduleCadence(
  decoded: Record<string, unknown>,
  scheduleId: string,
): { cronExpression?: string; intervalMs?: number } | null {
  const cronExpression = decoded['cronExpression'];
  const intervalMs = decoded['intervalMs'];
  const hasCron = cronExpression !== undefined;
  const hasInterval = intervalMs !== undefined;

  if (hasCron === hasInterval) {
    return rejectInvalidScheduleRecord(
      scheduleId,
      'with conflicting or missing cadence (expected exactly one of cronExpression or intervalMs)',
    );
  }

  if (hasInterval) {
    if (typeof intervalMs !== 'number' || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      return rejectInvalidScheduleRecord(scheduleId, 'with invalid intervalMs');
    }
    return { intervalMs };
  }

  if (typeof cronExpression !== 'string') {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid cronExpression');
  }
  try {
    parseCronExpression(cronExpression);
  } catch {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid cronExpression');
  }
  return { cronExpression };
}

export function decodeScheduleIdentityFields(decoded: Record<string, unknown>):
  | (Pick<ScheduleState, 'id' | 'workflowType' | 'status' | 'overlap'> & {
      cronExpression?: string;
      intervalMs?: number;
    })
  | null {
  const id = decoded['id'];
  if (!isValidScheduleIdentifier(id)) {
    return rejectInvalidScheduleRecord(undefined, 'with invalid id');
  }

  const workflowType = decoded['workflowType'];
  if (typeof workflowType !== 'string' || workflowType.length === 0) {
    return rejectInvalidScheduleRecord(id, 'with invalid workflowType');
  }

  const cadence = decodeScheduleCadence(decoded, id);
  if (!cadence) {
    return null;
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
    status,
    overlap,
    ...cadence,
  };
}

type ScheduleRuntimeFields = Pick<
  ScheduleState,
  | 'description'
  | 'backfill'
  | 'jitterMs'
  | 'createdAt'
  | 'updatedAt'
  | 'lastFireAt'
  | 'lastMissedFireAt'
  | 'nextFireAt'
  | 'currentWorkflowId'
  | 'missedFireCount'
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

function decodeScheduleDescription(
  decoded: Record<string, unknown>,
  scheduleId: string,
): string | undefined | null {
  const description = decoded['description'];
  if (description === undefined) {
    return undefined;
  }
  if (typeof description !== 'string') {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid description');
    return null;
  }
  return description;
}

function decodeScheduleJitterMs(
  decoded: Record<string, unknown>,
  scheduleId: string,
): number | undefined | null {
  const jitterMs = decoded['jitterMs'];
  if (jitterMs === undefined) {
    return undefined;
  }
  if (typeof jitterMs !== 'number' || !Number.isSafeInteger(jitterMs) || jitterMs <= 0) {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid jitterMs');
    return null;
  }
  return jitterMs;
}

function decodeScheduleTimestamps(
  decoded: Record<string, unknown>,
  scheduleId: string,
): { createdAt: number; updatedAt: number; lastFireAt?: number; lastMissedFireAt?: number } | null {
  const createdAt = decoded['createdAt'];
  const updatedAt = decoded['updatedAt'];
  if (!isValidScheduleTimestamp(createdAt) || !isValidScheduleTimestamp(updatedAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid timestamps');
  }

  const lastFireAt = decoded['lastFireAt'];
  if (lastFireAt !== undefined && !isValidScheduleTimestamp(lastFireAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid lastFireAt');
  }

  const lastMissedFireAt = decoded['lastMissedFireAt'];
  if (lastMissedFireAt !== undefined && !isValidScheduleTimestamp(lastMissedFireAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid lastMissedFireAt');
  }

  return {
    createdAt,
    updatedAt,
    ...(lastFireAt !== undefined && { lastFireAt }),
    ...(lastMissedFireAt !== undefined && { lastMissedFireAt }),
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
): ScheduleState['queuedRuns'] | null {
  const queuedRuns = decoded['queuedRuns'];
  if (!Array.isArray(queuedRuns)) {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid queuedRuns');
    return null;
  }

  const result: ScheduleState['queuedRuns'] = [];
  const workflowIds = new Set<string>();
  for (const queuedRun of queuedRuns) {
    if (!isRecord(queuedRun)) {
      rejectInvalidScheduleRecord(scheduleId, 'with invalid queuedRuns');
      return null;
    }
    const { workflowId, queuedAt, occurrence } = queuedRun;
    if (
      !isValidScheduleIdentifier(workflowId) ||
      !isValidScheduleTimestamp(queuedAt) ||
      (occurrence !== undefined && !isValidScheduleTimestamp(occurrence))
    ) {
      rejectInvalidScheduleRecord(scheduleId, 'with invalid queuedRuns');
      return null;
    }
    if (workflowIds.has(workflowId)) {
      rejectInvalidScheduleRecord(scheduleId, 'with duplicate queued workflow ids');
      return null;
    }
    workflowIds.add(workflowId);

    result.push({ workflowId, queuedAt, ...(occurrence !== undefined && { occurrence }) });
  }
  return result;
}

function decodeScheduleMissedFireCount(
  decoded: Record<string, unknown>,
  scheduleId: string,
): number | null {
  const missedFireCount = decoded['missedFireCount'];
  if (missedFireCount === undefined) {
    return 0;
  }
  if (
    typeof missedFireCount !== 'number' ||
    !Number.isSafeInteger(missedFireCount) ||
    missedFireCount < 0
  ) {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid missedFireCount');
    return null;
  }
  return missedFireCount;
}

function decodeScheduleQueueFields(
  decoded: Record<string, unknown>,
  scheduleId: string,
): Pick<ScheduleRuntimeFields, 'missedFireCount' | 'queuedRuns'> | null {
  const queuedRuns = decodeScheduleQueuedRuns(decoded, scheduleId);
  if (queuedRuns === null) return null;

  const missedFireCount = decodeScheduleMissedFireCount(decoded, scheduleId);
  if (missedFireCount === null) return null;

  return { missedFireCount, queuedRuns };
}

function decodeScheduleOptionFields(
  decoded: Record<string, unknown>,
  scheduleId: string,
): Pick<ScheduleRuntimeFields, 'backfill' | 'description' | 'jitterMs'> | null {
  const description = decodeScheduleDescription(decoded, scheduleId);
  if (description === null) return null;

  const backfill = decodeScheduleBackfill(decoded, scheduleId);
  if (backfill === null) return null;

  const jitterMs = decodeScheduleJitterMs(decoded, scheduleId);
  if (jitterMs === null) return null;

  return {
    ...(description !== undefined && { description }),
    backfill,
    ...(jitterMs !== undefined && { jitterMs }),
  };
}

export function decodeScheduleRuntimeFields(
  decoded: Record<string, unknown>,
  scheduleId: string,
): ScheduleRuntimeFields | null {
  const optionFields = decodeScheduleOptionFields(decoded, scheduleId);
  if (optionFields === null) return null;

  const timestamps = decodeScheduleTimestamps(decoded, scheduleId);
  if (timestamps === null) return null;

  const nextFireAt = decodeScheduleNextFireAt(decoded, scheduleId);
  if (!nextFireAt.ok) return null;

  const currentWorkflow = decodeScheduleCurrentWorkflowId(decoded, scheduleId);
  if (!currentWorkflow.ok) return null;

  const queueFields = decodeScheduleQueueFields(decoded, scheduleId);
  if (queueFields === null) return null;
  if (
    currentWorkflow.value !== undefined &&
    queueFields.queuedRuns.some((queuedRun) => queuedRun.workflowId === currentWorkflow.value)
  ) {
    return rejectInvalidScheduleRecord(scheduleId, 'whose current workflow is also queued');
  }

  return {
    ...optionFields,
    ...timestamps,
    nextFireAt: nextFireAt.value,
    ...(currentWorkflow.value !== undefined && { currentWorkflowId: currentWorkflow.value }),
    ...queueFields,
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
