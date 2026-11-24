import type { BatchOperation, ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";

/**
 * Options accepted by {@link Engine.pauseSchedule}, {@link Engine.resumeSchedule},
 * and {@link Engine.cancelSchedule} (COR-67). A consumer that keeps its own
 * durable projection in step with the engine's schedule state uses these to
 * fold that projection's write into the SAME storage commit that persists the
 * schedule's status transition, so the two are atomic — both land, or neither
 * does. Without this, the caller's own record is fire-and-forget after the
 * engine's commit: a crash between the two writes (or a rejected commit)
 * leaves them observably out of sync.
 *
 * `additionalOperations` are put/delete operations against the caller's OWN
 * storage keys — never one of Weft's reserved prefixes (see
 * `WEFT_RESERVED_KEY_PREFIXES`) — appended to the same batch as the schedule
 * state write. `extraConditions` are optional expected-value guards, also
 * against the caller's own keys: every listed key must currently hold the
 * given value (`null` means "must be absent") or the ENTIRE commit — the
 * caller's operations AND the schedule state transition — is rejected and
 * NEITHER lands.
 *
 * When `extraConditions` is supplied and loses the compare-and-swap,
 * `onExtraConditionsLost` (if provided) supplies the thrown error, so the
 * caller can distinguish "my own guard was stale" (a concurrent write to one
 * of my keys) from any other failure. Omitting it falls back to a generic
 * "lost its precondition" `Error`. A lost engine-owned fence (for example this
 * engine losing its lease) is never reported through `onExtraConditionsLost`
 * — that surfaces as `EngineDeposedError` instead, exactly as it does for
 * every other engine-owned write.
 *
 * @example
 * ```ts
 * import { Engine, workflow, type ScheduleTransitionOptions } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'report' }).execute(async function* () { return 'ok'; }));
 * const handle = await engine.schedule('report', null, '0 9 * * *', { id: 'daily-report' });
 *
 * const options: ScheduleTransitionOptions = {
 *   additionalOperations: [
 *     {
 *       type: 'put',
 *       key: 'app:projection:daily-report:paused',
 *       value: new TextEncoder().encode('true'),
 *     },
 *   ],
 * };
 * await engine.pauseSchedule('daily-report', options);
 * engine[Symbol.dispose]();
 * ```
 */
export interface ScheduleTransitionOptions {
  /**
   * Apply the transition only if the schedule's {@link ScheduleMetadata.revision} is still this
   * value. The comparison is made inside the schedule's serialized write, before the transition
   * decides whether it changes anything, so a caller holding a stale view is refused even when
   * the call would have been a no-op. The write is conditioned on the exact bytes the comparison
   * read, so of two transitions naming the same revision, from this engine or another sharing the
   * store, exactly one commits. A mismatch rejects with
   * {@link ScheduleStaleRevisionError} and writes nothing, the caller's
   * `additionalOperations` included. Omitted, the transition applies whatever the revision is.
   */
  expectedRevision?: number;
  /**
   * Caller-owned put/delete operations committed atomically with the schedule
   * state transition. A key under one of Weft's reserved prefixes
   * (`WEFT_RESERVED_KEY_PREFIXES`) is refused with {@link ScheduleReservedKeyError}.
   */
  additionalOperations?: BatchOperation[];
  /**
   * Caller-owned expected-value guards. The commit — the caller's operations
   * AND the schedule state transition together — is rejected unless every
   * condition currently holds. Each names a key of the caller's own: a key under one of
   * Weft's reserved prefixes (`WEFT_RESERVED_KEY_PREFIXES`), the schedule's own key among
   * them, is refused with {@link ScheduleReservedKeyError} before anything is read or written.
   */
  extraConditions?: ConditionalBatchCondition[];
  /**
   * Builds the error thrown when `extraConditions` loses the compare-and-swap.
   * Omit to get a generic "lost its precondition" `Error`.
   */
  onExtraConditionsLost?: () => Error;
}
