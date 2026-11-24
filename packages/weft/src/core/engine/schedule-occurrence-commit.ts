/**
 * How a timer tick starts the runs of one occurrence (COR-1925): in the same batch as the schedule
 * state that names them, committed only while the schedule key still holds the bytes the tick last
 * held, as a run now does ({@link startUnderScheduleRead}). Two engines that tick one schedule on a
 * shared store then start one run between them; a start that loses throws
 * {@link ScheduleReadConditionLostError} and the tick decides the occurrence again from the
 * schedule as it is now.
 */

import type { BatchOperation } from "../../embedded/storage/src/index.ts";
import { encode } from '../codec.ts';
import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { startUnderScheduleRead } from './schedule-conditioned-start.ts';
import type { ScheduledRunStartOptions } from './schedule-run.ts';
import { ScheduleReadConditionLostError } from './schedule-state-read.ts';
import {
  advanceScheduleTimerProgress,
  type ScheduleTimerProgress,
} from './schedule-timer-writes.ts';
import { buildScheduleStateOperations } from './schedule-write-operations.ts';
import type { ScheduleCallbacks } from './schedules.ts';

/** What the tick writes to the schedule when the start that concludes an occurrence commits. */
export type OccurrenceWritePlan = {
  /** The schedule after the occurrence. */
  state: ScheduleState;
  /** Whether the write carries the schedule's next timer, as the last occurrence's does. */
  includeTimer: boolean;
  /** The rows the write carries besides the schedule and its timer (what the tick missed). */
  additionalOperations: BatchOperation[];
};

/** The commit a tick hands `applyScheduleOccurrence` so the runs it starts land with the schedule. */
export type OccurrenceCommit = {
  readonly internals: EngineInternals;
  /** The bytes the schedule key last held for the tick, which each start is conditioned on. */
  readonly progress: ScheduleTimerProgress;
  /** The write that goes with the start that concludes the occurrence, from the state it names. */
  readonly conclude: (after: ScheduleState) => OccurrenceWritePlan;
  /** Whether this decides the occurrence again after a start lost its condition. */
  readonly retry: boolean;
  /**
   * Set when the start that concludes the occurrence has committed: the schedule as it was
   * written. Unset when the occurrence started no run, and the tick writes its state.
   */
  concluded: ScheduleState | null;
};

/**
 * Starts one run of an occurrence under `commit`. A `concluding` start is the last of the
 * occurrence and commits the whole write the tick owes ({@link OccurrenceCommit.conclude}); one
 * that is not (a queued run started ahead of this occurrence's own) commits the schedule as
 * `after` names it. Resolves once the batch has committed, and advances the bytes the next start is
 * conditioned on. Throws {@link ScheduleReadConditionLostError} when the schedule changed first.
 */
export async function startOccurrenceRun(
  commit: OccurrenceCommit,
  callbacks: Pick<ScheduleCallbacks, 'startScheduledRun'>,
  state: ScheduleState,
  after: ScheduleState,
  options: ScheduledRunStartOptions,
  concluding: boolean,
): Promise<void> {
  const { internals, progress } = commit;
  let written = after;
  let bytes: Uint8Array;
  let following: BatchOperation[] = [];
  if (concluding) {
    const plan = commit.conclude(after);
    const built = buildScheduleStateOperations(plan.state, plan);
    written = plan.state;
    bytes = built.bytes;
    following = built.following;
  } else {
    bytes = encode(after);
  }
  const started = await startUnderScheduleRead(internals, callbacks, state, progress.stored.bytes, {
    ...options,
    scheduleStateAfterStart: written,
    scheduleStateOperations: following,
  });
  if (!started) throw new ScheduleReadConditionLostError(state.id);
  advanceScheduleTimerProgress(progress, { state: written, bytes });
  if (concluding) commit.concluded = written;
}
