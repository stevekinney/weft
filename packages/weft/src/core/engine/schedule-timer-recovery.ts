/**
 * Boot recovery of the timer of an active schedule that has none (COR-1594 keeps it from striking a
 * schedule another process changed meanwhile).
 */

import { KEYS } from '../../storage/keys.ts';
import { decode } from '../codec.ts';
import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { resolveEffectiveScheduleFireAt } from './schedule-jitter.ts';
import {
  type LoadedScheduleState,
  loadScheduleState,
  ScheduleReadConditionLostError,
  scheduleReadConditions,
} from './schedule-state-read.ts';
import { createScheduleTimerId } from './state-utilities.ts';
import { writeScheduleState } from './storage-io.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

export async function recoverOrphanedScheduleTimers(internals: EngineInternals): Promise<void> {
  for await (const [key, value] of internals.storage.scan('schedule:')) {
    const scheduleKeySuffix = key.slice('schedule:'.length);
    if (scheduleKeySuffix.includes(':')) continue;

    const state = decodeScheduleState(value);
    if (state === null) continue;
    await rearmOrphanedScheduleTimer(internals, { state, bytes: value });
  }
}

/**
 * Arms the timer of an active schedule that has none, writing the schedule back only if it still
 * holds the bytes it was read as (COR-1594). A write that loses that condition read a schedule
 * another process has since changed, and that change may have armed no timer at all: the clearing
 * of a current run and the queued-run drain do not. So the schedule is read again, and the timer is
 * armed from what is stored now, for as long as the schedule is active with no current timer. It
 * stops once the schedule is gone, paused, cancelled, or has a timer.
 */
async function rearmOrphanedScheduleTimer(
  internals: EngineInternals,
  first: LoadedScheduleState,
): Promise<void> {
  let loaded: LoadedScheduleState | null = first;
  while (loaded !== null && isActiveScheduleWithTimer(loaded.state)) {
    if (await hasCurrentScheduleTimer(internals, loaded.state)) return;
    try {
      await writeScheduleState(internals, loaded.state, {
        extraConditions: scheduleReadConditions(internals, loaded.state.id, loaded),
      });
      return;
    } catch (error) {
      if (!(error instanceof ScheduleReadConditionLostError)) throw error;
    }
    loaded = await loadScheduleState(internals, first.state.id);
  }
}

function isActiveScheduleWithTimer(
  state: ScheduleState | null,
): state is ScheduleState & { nextFireAt: number } {
  return state?.status === 'active' && state.nextFireAt !== null;
}

async function hasCurrentScheduleTimer(
  internals: EngineInternals,
  state: ScheduleState & { nextFireAt: number },
): Promise<boolean> {
  const timerKey = KEYS.scheduleTick(
    resolveEffectiveScheduleFireAt(state, state.nextFireAt),
    state.id,
  );
  const timerBytes = await internals.storage.get(timerKey);
  if (timerBytes === null) {
    return false;
  }

  const timerIndexBytes = await internals.storage.get(
    `timer-idx:${createScheduleTimerId(state.id)}`,
  );
  return timerIndexBytes !== null && decode(timerIndexBytes) === timerKey;
}
