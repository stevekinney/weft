import { parseDuration } from '../../scheduler.ts';
import { coerceStartWorkflowId } from '../../start-workflow-validation.ts';
import type { ScheduleOptions, ScheduleOverlapPolicy } from '../../types.ts';

export const SCHEDULE_OVERLAP_POLICIES = new Set<ScheduleOverlapPolicy>([
  'skip',
  'queue',
  'cancel-running',
  'allow',
]);

type NormalizedScheduleOptions = Required<Pick<ScheduleOptions, 'overlap' | 'backfill'>> & {
  id?: string;
  description?: string;
  jitterMs?: number;
};

export function normalizeScheduleOptions(
  options: ScheduleOptions | undefined,
): NormalizedScheduleOptions {
  if (options === undefined) return { overlap: 'skip', backfill: false };
  if (typeof options !== 'object' || options === null) {
    throw new Error('options must be an object when provided');
  }

  return {
    overlap: normalizeScheduleOverlap(options.overlap),
    backfill: normalizeScheduleBackfill(options.backfill),
    ...(options.id !== undefined && { id: coerceStartWorkflowId(options.id, 'options.id') }),
    ...(options.description !== undefined && {
      description: normalizeScheduleDescription(options.description),
    }),
    ...(options.jitter !== undefined && {
      jitterMs: normalizeScheduleJitter(options.jitter, 'options.jitter'),
    }),
  };
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
