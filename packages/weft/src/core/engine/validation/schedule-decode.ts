import { decode } from '../../codec.ts';
import { isRecord } from '../../debug-output.ts';
import { isValidTimeZone } from '../../schedule.ts';
import type { ScheduleQueuedRun, ScheduleState } from '../../types.ts';
import { decodeScheduleCadence } from './schedule-cadence.ts';
import { isScheduleMetadata } from './schedule-options.ts';
import { decodeScheduleRevisionPolicyFields } from './schedule-revision.ts';
import { rejectInvalidScheduleRecord } from './schedule-warnings.ts';
import {
  isValidScheduleIdentifier,
  isValidScheduleOverlapPolicy,
  isValidScheduleStatus,
  isValidScheduleTimestamp,
} from './schedule.ts';

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
  | 'metadata'
  | 'backfill'
  | 'jitterMs'
  | 'timeZone'
  | 'createdAt'
  | 'updatedAt'
  | 'lastFireAt'
  | 'lastMissedFireAt'
  | 'nextFireAt'
  | 'skippedOccurrences'
  | 'currentWorkflowId'
  | 'missedFireCount'
  | 'skippedCount'
  | 'lastSkippedAt'
  | 'queuedRuns'
  | 'revision'
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

/**
 * A record written before schedules had metadata has none. A value that is not a plain JSON object
 * rejects the record, as a description that is not a string does.
 */
function decodeScheduleMetadata(
  decoded: Record<string, unknown>,
  scheduleId: string,
): Record<string, unknown> | undefined | null {
  const metadata = decoded['metadata'];
  if (metadata === undefined) {
    return undefined;
  }
  if (!isScheduleMetadata(metadata)) {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid metadata');
    return null;
  }
  return metadata;
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

/**
 * A record written before schedules had a time zone has none, and reads as `UTC`, the zone every
 * such schedule was run in. A value that is not a zone the runtime knows rejects the record, as a
 * cron expression that does not parse does: the schedule could not compute its next occurrence.
 */
function decodeScheduleTimeZone(
  decoded: Record<string, unknown>,
  scheduleId: string,
): string | null {
  const timeZone = decoded['timeZone'];
  if (timeZone === undefined) {
    return 'UTC';
  }
  if (!isValidTimeZone(timeZone)) {
    rejectInvalidScheduleRecord(scheduleId, 'with invalid timeZone');
    return null;
  }
  return timeZone;
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

/**
 * The occurrences a person asked to skip (COR-2018), ascending and without repeats. Absent on every
 * schedule nothing is skipped on, and then reads as absent. A record written before the set
 * replaced the single skipped occurrence (COR-1829's `skipUntil`) reads as a set of that one. Every
 * value must be a valid timestamp.
 */
function decodeScheduleSkippedOccurrences(
  decoded: Record<string, unknown>,
  scheduleId: string,
): { ok: true; value: number[] | undefined } | { ok: false } {
  const skipped = decoded['skippedOccurrences'];
  const legacy = decoded['skipUntil'];
  const values = skipped ?? (legacy === undefined ? undefined : [legacy]);
  if (values === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(values) || !values.every((value) => isValidScheduleTimestamp(value))) {
    rejectInvalidScheduleRecord(
      scheduleId,
      skipped === undefined ? 'with invalid skipUntil' : 'with invalid skippedOccurrences',
    );
    return { ok: false };
  }
  const sorted = [...new Set(values)].toSorted((left, right) => left - right);
  return { ok: true, value: sorted.length === 0 ? undefined : sorted };
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

/** One persisted queued run, or `null` when a field is invalid: `manual` is only ever `true`. */
function decodeQueuedRun(queuedRun: Record<string, unknown>): ScheduleQueuedRun | null {
  const { workflowId, queuedAt, occurrence, manual } = queuedRun;
  if (
    !isValidScheduleIdentifier(workflowId) ||
    !isValidScheduleTimestamp(queuedAt) ||
    (occurrence !== undefined && !isValidScheduleTimestamp(occurrence)) ||
    (manual !== undefined && manual !== true)
  ) {
    return null;
  }
  return {
    workflowId,
    queuedAt,
    ...(occurrence !== undefined && { occurrence }),
    ...(manual === true && { manual }),
  };
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
    const run = isRecord(queuedRun) ? decodeQueuedRun(queuedRun) : null;
    if (run === null) {
      rejectInvalidScheduleRecord(scheduleId, 'with invalid queuedRuns');
      return null;
    }
    if (workflowIds.has(run.workflowId)) {
      rejectInvalidScheduleRecord(scheduleId, 'with duplicate queued workflow ids');
      return null;
    }
    workflowIds.add(run.workflowId);
    result.push(run);
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

function decodeScheduleSkipFields(
  decoded: Record<string, unknown>,
  scheduleId: string,
): { skippedCount: number; lastSkippedAt?: number } | null {
  // Absent on records written before COR-1224; treated as zero rather than
  // rejected, so an existing schedule keeps decoding.
  const rawCount = decoded['skippedCount'];
  let skippedCount = 0;
  if (rawCount !== undefined) {
    if (typeof rawCount !== 'number' || !Number.isSafeInteger(rawCount) || rawCount < 0) {
      return rejectInvalidScheduleRecord(scheduleId, 'with invalid skippedCount');
    }
    skippedCount = rawCount;
  }

  const lastSkippedAt = decoded['lastSkippedAt'];
  if (lastSkippedAt !== undefined && !isValidScheduleTimestamp(lastSkippedAt)) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid lastSkippedAt');
  }

  return {
    skippedCount,
    ...(lastSkippedAt !== undefined && { lastSkippedAt }),
  };
}

/**
 * A record written before the schedule `revision` existed has none, and reads as `0`: it counts
 * no change yet, so its first transition makes it `1`. Any other value must be a non-negative
 * safe integer.
 */
function decodeScheduleRevision(
  decoded: Record<string, unknown>,
  scheduleId: string,
): number | null {
  const revision = decoded['revision'];
  if (revision === undefined) return 0;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid revision');
  }
  return revision;
}

/**
 * The counters and marks a schedule keeps: what its overlap policy skipped, its own revision, and
 * the occurrence a person asked to skip.
 */
function decodeScheduleCounterFields(
  decoded: Record<string, unknown>,
  scheduleId: string,
): Pick<
  ScheduleRuntimeFields,
  'skippedCount' | 'lastSkippedAt' | 'revision' | 'skippedOccurrences'
> | null {
  const skipFields = decodeScheduleSkipFields(decoded, scheduleId);
  if (skipFields === null) return null;
  const revision = decodeScheduleRevision(decoded, scheduleId);
  if (revision === null) return null;
  const skippedOccurrences = decodeScheduleSkippedOccurrences(decoded, scheduleId);
  if (!skippedOccurrences.ok) return null;
  return {
    ...skipFields,
    revision,
    ...(skippedOccurrences.value !== undefined && {
      skippedOccurrences: skippedOccurrences.value,
    }),
  };
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
): Pick<
  ScheduleRuntimeFields,
  'backfill' | 'description' | 'metadata' | 'jitterMs' | 'timeZone'
> | null {
  const description = decodeScheduleDescription(decoded, scheduleId);
  if (description === null) return null;

  const metadata = decodeScheduleMetadata(decoded, scheduleId);
  if (metadata === null) return null;

  const backfill = decodeScheduleBackfill(decoded, scheduleId);
  if (backfill === null) return null;

  const jitterMs = decodeScheduleJitterMs(decoded, scheduleId);
  if (jitterMs === null) return null;

  const timeZone = decodeScheduleTimeZone(decoded, scheduleId);
  if (timeZone === null) return null;

  return {
    ...(description !== undefined && { description }),
    ...(metadata !== undefined && { metadata }),
    backfill,
    ...(jitterMs !== undefined && { jitterMs }),
    timeZone,
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

  const counterFields = decodeScheduleCounterFields(decoded, scheduleId);
  if (counterFields === null) return null;
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
    ...counterFields,
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

  const revisionFields = decodeScheduleRevisionPolicyFields(decoded, identity.id);
  if (!revisionFields) {
    return null;
  }

  return {
    ...identity,
    input: decoded['input'],
    ...runtime,
    ...revisionFields,
  };
}
