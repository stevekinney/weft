/**
 * Starting a scheduled run in one batch with the schedule that names it, committed only while the
 * schedule key still holds the bytes the start was decided from (COR-1829, COR-1925). A run now and
 * a timer tick both start this way, so two engines on one store cannot both start a run for the
 * same decision: the batch of the one that loses does not commit, and nothing launches.
 */

import { storageValuesEqual } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { WorkflowAlreadyExistsError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import { StartIdempotencyRaceLostError } from './lifecycle/start-commit-errors.ts';
import type { ScheduledRunStartOptions } from './schedule-run.ts';
import { scheduleReadConditions } from './schedule-state-read.ts';
import type { ScheduleCallbacks } from './schedules.ts';

/**
 * Starts a run for `state` with `options.scheduleStateAfterStart`, the schedule that names it, in
 * one batch that commits only while the schedule key still holds `basis`. Resolves `true` when it
 * committed, or `false` when another engine changed the schedule first: the batch did not commit,
 * so no run launched and nothing the run would record (its services, its fired event) happened.
 */
export async function startUnderScheduleRead(
  internals: EngineInternals,
  callbacks: Pick<ScheduleCallbacks, 'startScheduledRun'>,
  state: { id: string } & Parameters<ScheduleCallbacks['startScheduledRun']>[0],
  basis: Uint8Array,
  options: ScheduledRunStartOptions,
): Promise<boolean> {
  const startConditions = scheduleReadConditions(internals, state.id, { bytes: basis });
  try {
    await callbacks.startScheduledRun(state, { ...options, startConditions });
  } catch (error) {
    if (
      startConditions.length > 0 &&
      (await lostToAnotherWriter(internals, state.id, basis, error))
    ) {
      return false;
    }
    throw error;
  }
  return true;
}

/**
 * Whether a start failed because the schedule changed under it, so nothing it decided committed:
 * its condition on the schedule was lost, or the queued run it was starting was already started by
 * the engine that changed the schedule.
 */
async function lostToAnotherWriter(
  internals: EngineInternals,
  scheduleId: string,
  basis: Uint8Array,
  error: unknown,
): Promise<boolean> {
  if (error instanceof StartIdempotencyRaceLostError) return true;
  if (!(error instanceof WorkflowAlreadyExistsError)) return false;
  const stored = await internals.storage.get(KEYS.schedule(scheduleId));
  return stored === null || !storageValuesEqual(stored, basis);
}
