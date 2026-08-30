import { hashString } from '../../runtime/portable.ts';
import type { ScheduleState } from '../types.ts';

type JitteredSchedule = Pick<ScheduleState, 'id' | 'jitterMs'>;

export function computeScheduleJitterOffset(
  scheduleId: string,
  nominalFireAt: number,
  jitterMs: number | undefined,
): number {
  if (jitterMs === undefined || jitterMs <= 0) {
    return 0;
  }

  const hash = BigInt(`0x${hashString(`${scheduleId}\0${nominalFireAt}`)}`);
  return Number(hash % BigInt(jitterMs));
}

export function resolveEffectiveScheduleFireAt(
  schedule: JitteredSchedule,
  nominalFireAt: number,
): number {
  return nominalFireAt + computeScheduleJitterOffset(schedule.id, nominalFireAt, schedule.jitterMs);
}
