/**
 * What an engine remembers of a schedule timer it reached and kept (COR-1998), so that the
 * delivery that follows is not late for the interval the first spent standing aside.
 */
import type { ScheduleState, TimerEntry } from '../types.ts';
import type { EngineInternals } from './internals.ts';

/**
 * When this engine last reached a schedule timer that it then kept, by `<schedule>:<fire time>`
 * (COR-1998). A tick that stands aside from an occurrence because another engine's write won
 * leaves the timer in storage, and the next poll delivers it again one interval later. Lateness
 * is counted from the tick that last reached the occurrence on time, not from the occurrence, so
 * the interval spent standing aside is not charged to the run as well: the run is as late as it
 * would have been had that first tick gone on. The record is memory only, so an engine that was
 * down, or never reached the timer, counts from the occurrence, which is what a missed fire is.
 * Another engine that delivers the timer first has no sighting either, so it counts from the
 * occurrence: it polls on its own cadence and reaches an occurrence a poll interval late at most.
 * A sighting whose timer was cancelled or handled elsewhere stays until the next one is remembered,
 * which drops those older than the late limit, so the map holds the few timers in flight.
 */
const retainedTimerSightings = new WeakMap<EngineInternals, Map<string, number>>();

function retainedTimerKey(entry: TimerEntry): string {
  return `${entry.workflowId}:${entry.fireAt}`;
}

/** The time lateness is counted from: the occurrence, or a later tick that reached it and kept it. */
export function lateSinceOf(internals: EngineInternals, entry: TimerEntry): number {
  const sighting = retainedTimerSightings.get(internals)?.get(retainedTimerKey(entry));
  return sighting === undefined ? entry.fireAt : Math.max(entry.fireAt, sighting);
}

/**
 * Records that a tick at `at` reached the timer on time and kept it, and forgets the sightings
 * too old to count for anything: one older than the late limit leaves a delivery past it anyway.
 */
export function rememberRetainedTimer(
  internals: EngineInternals,
  entry: TimerEntry,
  at: number,
  lateAfterMilliseconds: number,
): void {
  let sightings = retainedTimerSightings.get(internals);
  if (sightings === undefined) {
    sightings = new Map();
    retainedTimerSightings.set(internals, sightings);
  }
  for (const [key, seenAt] of sightings) {
    if (at - seenAt > lateAfterMilliseconds) sightings.delete(key);
  }
  sightings.set(retainedTimerKey(entry), at);
}

/** Drops the sighting of a timer that was handled or is no longer owed. */
export function forgetRetainedTimer(internals: EngineInternals, entry: TimerEntry): void {
  retainedTimerSightings.get(internals)?.delete(retainedTimerKey(entry));
}

/** What a tick saw of the timer it was given: when it reached it, and whether that was too late. */
export type TimerSighting = { at: number | undefined; late: boolean };

/**
 * Whether a tick at `now` reaches a non-backfill occurrence too late to start it, counting from
 * `lateSince` (the occurrence, or the tick that last reached it and kept it).
 */
export function reachedTooLate(
  state: ScheduleState,
  lateSince: number,
  now: number,
  lateAfterMilliseconds: number,
): boolean {
  return !state.backfill && now - lateSince > lateAfterMilliseconds;
}
