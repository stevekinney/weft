import { isJSONValue } from '../../json.ts';
import { canonicalTimeZone, isValidTimeZone } from '../../schedule.ts';
import { parseDuration } from '../../scheduler.ts';
import { coerceStartWorkflowId } from '../../start-workflow-validation.ts';
import type {
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleRevisionPolicy,
  ScheduleUpdateOptions,
} from '../../types.ts';

export const SCHEDULE_OVERLAP_POLICIES = new Set<ScheduleOverlapPolicy>([
  'skip',
  'queue',
  'cancel-running',
  'allow',
]);

export const SCHEDULE_REVISION_POLICIES = new Set<ScheduleRevisionPolicy>([
  'active-at-fire',
  'pinned',
]);

type NormalizedScheduleOptions = Required<Pick<ScheduleOptions, 'overlap' | 'backfill'>> & {
  initialStatus?: 'active' | 'paused';
  id?: string;
  description?: string;
  jitterMs?: number;
  timeZone?: string;
  revisionPolicy?: ScheduleRevisionPolicy;
  metadata?: Record<string, unknown>;
};

type NormalizedScheduleUpdateOptions = {
  workflowType?: string;
  input?: unknown;
  description?: string;
  metadata?: Record<string, unknown>;
  overlap?: ScheduleOverlapPolicy;
  backfill?: boolean;
  jitterMs?: number;
  timeZone?: string;
  revisionPolicy?: ScheduleRevisionPolicy;
};

export function normalizeScheduleOptions(
  options: ScheduleOptions | undefined,
): NormalizedScheduleOptions {
  if (options === undefined) return { overlap: 'skip', backfill: false };
  if (typeof options !== 'object' || options === null) {
    throw new Error('options must be an object when provided');
  }

  return {
    ...normalizeInitialStatus(options.initialStatus),
    overlap: normalizeScheduleOverlap(options.overlap),
    backfill: normalizeScheduleBackfill(options.backfill),
    ...(options.id !== undefined && { id: coerceStartWorkflowId(options.id, 'options.id') }),
    ...(options.description !== undefined && {
      description: normalizeScheduleDescription(options.description),
    }),
    ...(options.jitter !== undefined && {
      jitterMs: normalizeScheduleJitter(options.jitter, 'options.jitter'),
    }),
    ...(options.timeZone !== undefined && {
      timeZone: normalizeScheduleTimeZone(options.timeZone),
    }),
    ...(options.revisionPolicy !== undefined && {
      revisionPolicy: normalizeScheduleRevisionPolicy(
        options.revisionPolicy,
        'options.revisionPolicy',
      ),
    }),
    ...(options.metadata !== undefined && {
      metadata: normalizeScheduleMetadata(options.metadata),
    }),
  };
}

export function normalizeScheduleUpdateOptions(
  options: ScheduleUpdateOptions | undefined,
): NormalizedScheduleUpdateOptions {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null) {
    throw new Error('options must be an object when provided');
  }

  return {
    ...normalizeScheduleRunFields(options),
    ...(options.overlap !== undefined && { overlap: normalizeScheduleOverlap(options.overlap) }),
    ...(options.backfill !== undefined && {
      backfill: normalizeScheduleBackfill(options.backfill),
    }),
    ...(options.jitter !== undefined && {
      jitterMs: normalizeScheduleJitter(options.jitter, 'options.jitter'),
    }),
    ...(options.timeZone !== undefined && {
      timeZone: normalizeScheduleTimeZone(options.timeZone),
    }),
    ...(options.revisionPolicy !== undefined && {
      revisionPolicy: normalizeScheduleRevisionPolicy(
        options.revisionPolicy,
        'options.revisionPolicy',
      ),
    }),
  };
}

/**
 * A schedule's metadata: a plain JSON object, never an array, a class instance or a non-JSON value.
 * The result is a deep copy, validated as a copy: the engine awaits storage before it writes, and a
 * caller that changes the object it passed meanwhile must not change what is stored.
 */
export function normalizeScheduleMetadata(metadata: unknown): Record<string, unknown> {
  if (isScheduleMetadata(metadata)) {
    try {
      const snapshot: unknown = structuredClone(metadata);
      if (isScheduleMetadata(snapshot)) return snapshot;
    } catch {
      // A value the platform cannot copy is not JSON; the refusal below names it.
    }
  }
  throw new Error('options.metadata must be a plain JSON object when provided');
}

/**
 * `options` with its metadata replaced by a validated copy, for an engine method to take before its
 * first await. Without metadata, or with options that are not an object, they come back as they were
 * (later validation refuses the latter).
 */
export function snapshotScheduleMetadata<TOptions extends { metadata?: unknown }>(
  options: TOptions | undefined,
): TOptions | undefined {
  if (typeof options !== 'object' || options === null || options.metadata === undefined) {
    return options;
  }
  return { ...options, metadata: normalizeScheduleMetadata(options.metadata) };
}

/** Whether `value` is a plain JSON object: not `null`, an array, a class instance or a non-JSON value. */
export function isScheduleMetadata(value: unknown): value is Record<string, unknown> {
  return isJSONValue(value) && typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeScheduleRevisionPolicy(
  value: unknown,
  fieldName: string,
): ScheduleRevisionPolicy {
  if (!SCHEDULE_REVISION_POLICIES.has(value as ScheduleRevisionPolicy)) {
    throw new Error(`${fieldName} must be one of ${[...SCHEDULE_REVISION_POLICIES].join(', ')}`);
  }
  return value as ScheduleRevisionPolicy;
}

/**
 * A schedule's time zone: `UTC` or an IANA name the runtime knows. The message names the field as
 * `options.timeZone` so a caller that maps errors to a wire fault can tell it from a bad cadence.
 */
function normalizeScheduleTimeZone(timeZone: unknown): string {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(
      'options.timeZone must be a valid IANA time zone name such as "America/Los_Angeles", or "UTC"',
    );
  }
  return canonicalTimeZone(timeZone);
}

/**
 * The workflow type and input an update moves a schedule to, and the description and metadata it
 * gives it, when it names them.
 */
function normalizeScheduleRunFields(
  options: ScheduleUpdateOptions,
): Pick<NormalizedScheduleUpdateOptions, 'workflowType' | 'input' | 'description' | 'metadata'> {
  return {
    ...(options.workflowType !== undefined && {
      workflowType: normalizeScheduleWorkflowType(options.workflowType),
    }),
    ...(options.input !== undefined && { input: options.input }),
    ...(options.description !== undefined && {
      description: normalizeScheduleDescription(options.description),
    }),
    ...(options.metadata !== undefined && {
      metadata: normalizeScheduleMetadata(options.metadata),
    }),
  };
}

function normalizeScheduleWorkflowType(workflowType: unknown): string {
  if (typeof workflowType !== 'string' || workflowType.trim() === '') {
    throw new Error('options.workflowType must be a non-empty string when provided');
  }
  return workflowType;
}

function normalizeScheduleDescription(description: unknown): string {
  if (typeof description !== 'string') {
    throw new Error('options.description must be a string when provided');
  }
  return description;
}

function normalizeScheduleOverlap(overlap: unknown): ScheduleOverlapPolicy {
  if (overlap === undefined) return 'skip';
  if (!SCHEDULE_OVERLAP_POLICIES.has(overlap as ScheduleOverlapPolicy)) {
    throw new Error(`options.overlap must be one of ${[...SCHEDULE_OVERLAP_POLICIES].join(', ')}`);
  }
  return overlap as ScheduleOverlapPolicy;
}

function normalizeScheduleBackfill(backfill: unknown): boolean {
  if (backfill === undefined) return false;
  if (typeof backfill !== 'boolean') {
    throw new Error('options.backfill must be a boolean when provided');
  }
  return backfill;
}

function normalizeScheduleJitter(value: unknown, fieldName: string): number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${fieldName} must be a duration string or a number of milliseconds`);
  }

  let milliseconds: number;
  try {
    milliseconds = parseDuration(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${fieldName}: ${message}`, { cause: error });
  }

  const jitterMs = Math.ceil(milliseconds);
  if (!Number.isSafeInteger(jitterMs) || jitterMs <= 0) {
    throw new Error(`${fieldName} must resolve to a positive number of milliseconds`);
  }
  return jitterMs;
}

function normalizeInitialStatus(value: unknown): { initialStatus?: 'active' | 'paused' } {
  if (value === undefined) return {};
  if (value !== 'active' && value !== 'paused')
    throw new Error('options.initialStatus must be active or paused');
  return { initialStatus: value };
}
