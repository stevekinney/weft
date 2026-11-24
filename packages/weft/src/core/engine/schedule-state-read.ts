/**
 * Reading a schedule for a change, and the condition that keeps the change from landing on top of
 * another process's (COR-1594). A writer reads the schedule with the exact bytes it was decoded
 * from, decides what to write from them, and conditions the write on those bytes through
 * {@link scheduleReadConditions}; a write that loses the condition throws
 * {@link ScheduleReadConditionLostError}, and the writer reads again.
 */

import { type ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

/** A schedule's decoded state with the exact bytes it was decoded from. */
export type LoadedScheduleState = {
  readonly state: ScheduleState;
  /** The stored value of the schedule key, which a later write is conditioned on. */
  readonly bytes: Uint8Array;
};

/** Load and decode persisted schedule state by schedule ID, with the bytes it was read from. */
export async function loadScheduleState(
  internals: EngineInternals,
  scheduleId: string,
): Promise<LoadedScheduleState | null> {
  const bytes = await internals.storage.get(KEYS.schedule(scheduleId));
  if (!bytes) return null;
  const state = decodeScheduleState(bytes);
  return state === null ? null : { state, bytes };
}

/** Load a schedule state, with the bytes it was read from. */
export async function requireScheduleState(
  internals: EngineInternals,
  scheduleId: string,
): Promise<LoadedScheduleState> {
  const loaded = await loadScheduleState(internals, scheduleId);
  if (!loaded) {
    throw new Error(`Schedule "${scheduleId}" not found`);
  }
  return loaded;
}

/**
 * Thrown by `writeScheduleState` when the schedule key no longer holds the bytes the writer
 * read, so nothing was written (COR-1594). The writer re-reads and decides again: this is the
 * loss of the compare-and-swap on the schedule itself, never of a caller-supplied condition,
 * which is reported through `onExtraConditionsLost`.
 */
export class ScheduleReadConditionLostError extends Error {
  constructor(readonly scheduleId: string) {
    super(`Schedule "${scheduleId}" changed after it was read.`);
    this.name = 'ScheduleReadConditionLostError';
  }
}

/** The conditions this module made, so one is told from a caller's by identity and never by key. */
const engineReadConditions = new WeakSet<ConditionalBatchCondition>();

/** Whether `condition` is one {@link scheduleReadConditions} made, and not a caller's. */
export function isScheduleReadCondition(condition: ConditionalBatchCondition): boolean {
  return engineReadConditions.has(condition);
}

/**
 * The condition that makes a schedule write conditional on the bytes it was decided from
 * (COR-1594), for `writeScheduleState`'s `extraConditions`. Empty on a storage without
 * `conditionalBatch`: a store that can be shared between processes has the capability, because
 * the `'lease'` and `'workflow-lease'` ownership modes require it (`ownership-mode-marker.ts`), so
 * a store that lacks it is one engine's alone.
 *
 * The condition is told from a caller's by identity ({@link isScheduleReadCondition}), so a
 * caller's condition on any key, the schedule's own included, is judged as the caller's.
 */
export function scheduleReadConditions(
  internals: EngineInternals,
  scheduleId: string,
  loaded: Pick<LoadedScheduleState, 'bytes'>,
): ConditionalBatchCondition[] {
  if (!internals.storage.capabilities().conditionalBatch) return [];
  const condition: ConditionalBatchCondition = {
    key: KEYS.schedule(scheduleId),
    expectedValue: loaded.bytes,
  };
  engineReadConditions.add(condition);
  return [condition];
}
