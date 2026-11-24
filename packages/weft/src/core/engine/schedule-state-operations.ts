import type { ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";
import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { ScheduleStaleRevisionError } from './schedule-stale-revision-error.ts';
import {
  requireScheduleState,
  ScheduleReadConditionLostError,
  scheduleReadConditions,
} from './schedule-state-read.ts';
import { runSerializedScheduleStateOperation } from './storage-io.ts';

/**
 * Run `operation` inside the schedule's serialized write, carrying a failure out of the
 * serialized body as a value and throwing it after.
 *
 * {@link runSerializedScheduleStateOperation} hands a rejection to whoever is queued behind it,
 * which is right for a timer callback that must leave its durable timer to be retried, and wrong
 * for anything else: one caller's refusal or failed write must not fail the next caller's change,
 * or a timer tick.
 */
export async function runIsolatedScheduleStateOperation<TResult>(
  internals: EngineInternals,
  scheduleId: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const outcome = await runSerializedScheduleStateOperation(
    internals,
    scheduleId,
    async (): Promise<{ ok: true; value: TResult } | { ok: false; error: unknown }> => {
      try {
        return { ok: true, value: await operation() };
      } catch (error) {
        return { ok: false, error };
      }
    },
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * Run a schedule transition (a change a caller asked for) inside the schedule's serialized
 * write: load the current state, compare `expectedRevision` with its `revision` when the caller
 * passed one, and only then let `apply` decide what to write from that state. A stale
 * `expectedRevision` throws {@link ScheduleStaleRevisionError} and writes nothing.
 *
 * The serialization is per engine process, so the write is also conditioned on the exact bytes it
 * was decided from (COR-1594): `apply` is handed the conditions and puts them in its write's
 * `extraConditions`. A write that loses them read a schedule another process has since changed.
 * The state is then read again and the transition decided again, so the `expectedRevision`
 * comparison runs against what is stored now: an unchanged revision retries (the other change
 * did not touch what the caller named), and a different one is stale. A call with no
 * `expectedRevision` applies to whatever is stored now.
 */
export async function runScheduleTransition(
  internals: EngineInternals,
  scheduleId: string,
  expectedRevision: number | undefined,
  apply: (state: ScheduleState, readConditions: ConditionalBatchCondition[]) => Promise<void>,
): Promise<void> {
  await runIsolatedScheduleStateOperation(internals, scheduleId, async () => {
    for (;;) {
      const loaded = await requireScheduleState(internals, scheduleId);
      const { state } = loaded;
      if (expectedRevision !== undefined && state.revision !== expectedRevision) {
        throw new ScheduleStaleRevisionError(scheduleId, expectedRevision, state.revision);
      }
      try {
        await apply(state, scheduleReadConditions(internals, scheduleId, loaded));
        return;
      } catch (error) {
        if (!(error instanceof ScheduleReadConditionLostError)) throw error;
      }
    }
  });
}
