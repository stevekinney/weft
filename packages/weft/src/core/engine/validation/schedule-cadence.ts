/**
 * Decode a persisted schedule record's cadence fields (`cronExpression` XOR
 * `intervalMs`). Split out of `schedule.ts` purely to stay under this
 * repository's 500-line-per-file ceiling (the same precedent
 * `lifecycle/start.ts`/`decode-revision.ts` set for WFT-17/18) — there is no
 * behavioral reason to import this module directly instead of `schedule.ts`,
 * which re-exports nothing from here because `decodeScheduleCadence` is
 * consumed only by `decodeScheduleIdentityFields` in that file.
 *
 * @module core/engine/validation/schedule-cadence
 */

import { parseCronExpression } from '../../schedule.ts';
import { rejectInvalidScheduleRecord } from './schedule-warnings.ts';

/** Decode the cadence fields (`cronExpression` XOR `intervalMs`) of a persisted schedule record, or `null` (and warn) on a malformed record. */
export function decodeScheduleCadence(
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
