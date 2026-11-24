/**
 * The writes a schedule timer tick makes to the schedule it fires (COR-1594). A tick decides what
 * to write from the schedule it read, possibly some time and a whole run later, so every write is
 * conditioned on the bytes the schedule key last held for the tick, and a write that loses that
 * condition is made again only if the schedule is still as the tick left it, carrying what the
 * other writer recorded meanwhile (COR-1829).
 */

import type { BatchOperation } from "../../embedded/storage/src/index.ts";
import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { getNextScheduleOccurrence, withSkippedOccurrences } from './schedule-occurrence.ts';
import {
  type LoadedScheduleState,
  loadScheduleState,
  ScheduleReadConditionLostError,
  scheduleReadConditions,
} from './schedule-state-read.ts';
import { writeScheduleState } from './storage-io.ts';

export class ScheduleStatePersistenceError extends Error {
  constructor(
    readonly scheduleId: string,
    cause: unknown,
  ) {
    super(`Failed to persist schedule "${scheduleId}" while processing its timer`, { cause });
  }
}

/**
 * The latest state a section has, for the pause it owes a schedule whose processing failed, and
 * the state and bytes the schedule key last held for this tick (read, or written by it), which
 * its next write is conditioned on (COR-1594). They differ while a section has computed a state
 * it has not yet written.
 */
export type ScheduleTimerProgress = { state: ScheduleState; stored: LoadedScheduleState };

/**
 * Records that the schedule key now holds `stored` for this tick, and that `state` is the latest
 * the section has (the stored state unless it has already computed past it). The two move
 * together: a pause is built from `state` and conditioned on `stored`, so a `stored` that
 * advances past a `state` that does not would write the pause over what was committed in between
 * (COR-1925). This is the only place `progress.stored` is assigned, which
 * `schedule-timer-progress.test.ts` keeps true.
 */
export function advanceScheduleTimerProgress(
  progress: ScheduleTimerProgress,
  stored: LoadedScheduleState,
  state: ScheduleState = stored.state,
): void {
  progress.stored = stored;
  progress.state = state;
}

/**
 * Whether the schedule is still as this tick left it: active, at the `revision` the tick holds,
 * with the `nextFireAt` and `lastFireAt` it holds (COR-1925: another tick that fired the occurrence
 * a backfill is catching up on moves `lastFireAt` before it moves `nextFireAt`). Another process's pause, update or cancel moves the revision,
 * and another process's timer tick moves `nextFireAt`. A run now, a skip or unskip and a clearing of
 * the current run move neither: what they recorded is carried into the tick's write
 * ({@link carryConcurrentRecords}).
 */
export function isStillAsTickLeftIt(current: ScheduleState, left: ScheduleState): boolean {
  return (
    current.status === 'active' &&
    current.revision === left.revision &&
    current.nextFireAt === left.nextFireAt &&
    current.lastFireAt === left.lastFireAt
  );
}

/**
 * Writes the tick's state, conditioned on the bytes the schedule key last held for it (COR-1594).
 * A write that loses the condition read a schedule another process has since changed: the schedule
 * is read again, and the write is made again, on the new bytes, only if the schedule is still as
 * this tick left it ({@link isStillAsTickLeftIt}), with what the other process recorded carried
 * in. Otherwise whatever changed it owns the schedule and the timer from then on, nothing is
 * written, and this resolves `false`. On `true`, `progress.stored.state` is what was written.
 */
export async function persistScheduleTimerState(
  internals: EngineInternals,
  progress: ScheduleTimerProgress,
  state: ScheduleState,
  options?: { includeTimer?: boolean; additionalOperations?: BatchOperation[] },
): Promise<boolean> {
  let next = state;
  try {
    for (;;) {
      try {
        const bytes = await writeScheduleState(internals, next, {
          ...options,
          extraConditions: scheduleReadConditions(internals, next.id, progress.stored),
        });
        advanceScheduleTimerProgress(progress, { state: next, bytes });
        return true;
      } catch (error) {
        if (!(error instanceof ScheduleReadConditionLostError)) throw error;
      }
      const current = await loadScheduleState(internals, next.id);
      if (current === null || !isStillAsTickLeftIt(current.state, progress.stored.state)) {
        return false;
      }
      next = carryConcurrentRecords(next, progress.stored.state, current.state);
      advanceScheduleTimerProgress(progress, current, next);
    }
  } catch (error) {
    throw new ScheduleStatePersistenceError(next.id, error);
  }
}

/**
 * `ours`, the state the tick decided from `base`, with what another process recorded on the same
 * cadence meanwhile (`theirs`) carried in (COR-1829): the slot, queue, overlap count and skips that
 * a run now, a skip or its undoing, or the end of a run change without moving the cadence. Each field takes
 * whichever side changed it from `base`; when both did:
 *
 * - A run they recorded stays the current run: it is never written over, and a run this tick
 *   started without seeing it is left to finish, unrecorded. A slot they only cleared (the run
 *   ended) takes the run this tick started.
 * - The queue keeps their entries, without the ones this tick started, followed by the ones it added.
 * - The overlap counts add up.
 * - The skipped occurrences merge: what they skipped or took back since `base` is applied to ours
 *   (COR-2018). A skip they recorded for an occurrence this tick has already passed without honoring
 *   is dropped (COR-1985): it named that occurrence, which was not skipped, and carrying it onto the
 *   next one would skip a run nobody chose.
 */
export function carryConcurrentRecords(
  ours: ScheduleState,
  base: ScheduleState,
  theirs: ScheduleState,
): ScheduleState {
  const { currentWorkflowId: _current, lastSkippedAt: _skipped, ...rest } = ours;
  const currentWorkflowId = carriedCurrentRun(ours, base, theirs);
  const lastSkippedAt =
    ours.lastSkippedAt === base.lastSkippedAt
      ? theirs.lastSkippedAt
      : Math.max(ours.lastSkippedAt ?? 0, theirs.lastSkippedAt ?? 0);
  return withSkippedOccurrences(
    {
      ...rest,
      ...(currentWorkflowId !== undefined && { currentWorkflowId }),
      queuedRuns: carriedQueue(ours, base, theirs),
      skippedCount: theirs.skippedCount + ours.skippedCount - base.skippedCount,
      ...(lastSkippedAt !== undefined && { lastSkippedAt }),
    },
    carriedSkips(ours, base, theirs),
  );
}

function carriedCurrentRun(
  ours: ScheduleState,
  base: ScheduleState,
  theirs: ScheduleState,
): string | undefined {
  const theirsRecordedARun =
    theirs.currentWorkflowId !== undefined && theirs.currentWorkflowId !== base.currentWorkflowId;
  return theirsRecordedARun || ours.currentWorkflowId === base.currentWorkflowId
    ? theirs.currentWorkflowId
    : ours.currentWorkflowId;
}

function queuedIds(state: ScheduleState): Set<string> {
  return new Set(state.queuedRuns.map((run) => run.workflowId));
}

function carriedQueue(
  ours: ScheduleState,
  base: ScheduleState,
  theirs: ScheduleState,
): ScheduleState['queuedRuns'] {
  const baseIds = queuedIds(base);
  const ourIds = queuedIds(ours);
  const theirIds = queuedIds(theirs);
  return [
    ...theirs.queuedRuns.filter(
      (run) => !baseIds.has(run.workflowId) || ourIds.has(run.workflowId),
    ),
    ...ours.queuedRuns.filter(
      (run) => !baseIds.has(run.workflowId) && !theirIds.has(run.workflowId),
    ),
  ];
}

/**
 * The skipped occurrences this tick's write carries: ours, with the skips another process added
 * since `base` and without the ones it took back. The tick planned without what they added, so an
 * added occurrence at or before one the tick has already accounted for (fired it: `lastFireAt`; or
 * moved past it: `nextFireAt`) was not skipped. The skip named that occurrence, so it is dropped
 * rather than moved onto the next one (COR-1985): a person who chose to skip one run did not choose
 * to skip the one after it.
 */
function carriedSkips(ours: ScheduleState, base: ScheduleState, theirs: ScheduleState): number[] {
  const baseSkips = new Set(base.skippedOccurrences);
  const theirSkips = new Set(theirs.skippedOccurrences);
  const added = [...theirSkips].filter((at) => !baseSkips.has(at));
  const takenBack = new Set([...baseSkips].filter((at) => !theirSkips.has(at)));
  const passed = (at: number): boolean =>
    (ours.nextFireAt !== null && ours.nextFireAt !== base.nextFireAt && at < ours.nextFireAt) ||
    (ours.lastFireAt !== undefined && at <= ours.lastFireAt);
  return [
    ...(ours.skippedOccurrences ?? []).filter((at) => !takenBack.has(at)),
    ...added.filter((at) => !passed(at)),
  ];
}

/**
 * Pauses `state` after its timer processing failed, conditioned on `stored`, the bytes the
 * schedule key last held for the tick. If the condition is lost the schedule is read again: it is
 * paused from what is stored now only if it is still as the tick left it, and otherwise left to
 * whatever changed it (COR-1594).
 */
export async function pauseScheduleAfterTimerFailure(
  internals: EngineInternals,
  state: ScheduleState,
  stored: LoadedScheduleState,
  error: unknown,
): Promise<void> {
  let basis = state;
  let read = stored;
  for (;;) {
    const errorNow = internals.options.getNow();
    const pausedState: ScheduleState = {
      ...basis,
      status: 'paused',
      revision: basis.revision + 1,
      updatedAt: errorNow,
      nextFireAt: getNextScheduleOccurrence(basis, errorNow),
    };
    try {
      await writeScheduleState(internals, pausedState, {
        includeTimer: false,
        extraConditions: scheduleReadConditions(internals, state.id, read),
      });
      console.error(
        `[weft] Paused schedule "${pausedState.id}" after timer processing failed:`,
        error,
      );
      return;
    } catch (writeError) {
      if (!(writeError instanceof ScheduleReadConditionLostError)) throw writeError;
    }
    const current = await loadScheduleState(internals, state.id);
    if (current === null || !isStillAsTickLeftIt(current.state, stored.state)) return;
    basis = current.state;
    read = current;
  }
}
