import { parseCronExpression } from '../../schedule.ts';
import { parseDuration } from '../../scheduler.ts';
import type {
  ScheduleFilter,
  ScheduleOverlapPolicy,
  ScheduleRevisionPolicy,
  ScheduleSpec,
  ScheduleStatus,
} from '../../types.ts';
import { assertDecodableWorkflowId, isDecodableWorkflowId } from '../../workflow-identifiers.ts';
import { SCHEDULE_OVERLAP_POLICIES, SCHEDULE_REVISION_POLICIES } from './schedule-options.ts';

export {
  normalizeScheduleOptions,
  normalizeScheduleUpdateOptions,
  SCHEDULE_OVERLAP_POLICIES,
  SCHEDULE_REVISION_POLICIES,
} from './schedule-options.ts';
export { rejectInvalidScheduleRecord } from './schedule-warnings.ts';

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

export function isValidScheduleRevisionPolicy(value: unknown): value is ScheduleRevisionPolicy {
  return (
    typeof value === 'string' && SCHEDULE_REVISION_POLICIES.has(value as ScheduleRevisionPolicy)
  );
}

/**
 * Whether `value` is a schedule-related workflow id that decoded persisted
 * data may still carry. Deliberately reuses the pre-WFT-95 decode predicate
 * (not the fresh-admission `.`/`..` rejection), because every caller of this
 * function — `decodeScheduleIdentityFields`, `decodeScheduleRunMetadata`,
 * and the persisted `currentWorkflowId`/`queuedRuns[].workflowId` fields in
 * this module — reads already-persisted data. A schedule created before
 * WFT-95 with `id: '.'` or `'..'` must remain decodable and keep firing
 * after upgrade.
 */
export function isValidScheduleIdentifier(value: unknown): value is string {
  return typeof value === 'string' && isDecodableWorkflowId(value);
}

/**
 * Coerce a caller-supplied `scheduleId` used to look up or control an
 * already-persisted schedule — `getSchedule`, `pauseSchedule`,
 * `resumeSchedule`, `cancelSchedule`, and `updateSchedule` all call this,
 * never schedule creation (that admission path is
 * `normalizeScheduleOptions`'s direct `coerceStartWorkflowId(options.id, …)`
 * call, which keeps the strict `.`/`..` rejection). Deliberately uses the
 * decode-compatible `assertDecodableWorkflowId`, not the admission-only
 * `.`/`..` rejection (WFT-95 review): a schedule created before that
 * rejection landed may already carry `id: '.'` or `'..'`, and callers must
 * still be able to inspect, pause, resume, cancel, or update it instead of
 * having every control operation reject a schedule they can't otherwise
 * reach.
 */
export function coerceScheduleId(scheduleId: unknown, fieldName: string): string {
  // `assertDecodableWorkflowId` now takes `unknown`, guards `typeof` itself,
  // and narrows via `asserts id is string` (WFT-95 review), so this no
  // longer needs its own check or cast.
  assertDecodableWorkflowId(scheduleId, fieldName);
  return scheduleId;
}

/**
 * A recurrence specification normalized into the discriminated cadence the
 * engine persists. Interval periods are resolved to whole milliseconds.
 */
export type NormalizedScheduleSpec =
  { kind: 'cron'; cronExpression: string } | { kind: 'interval'; intervalMs: number };

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
