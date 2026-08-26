/**
 * Owner-side coordinated-update polling (WFT-79), mirroring
 * `owner-side-signal-poll.ts`'s mechanism and rationale.
 *
 * **The problem.** `updates.ts`'s `deliverCoordinatedUpdateToWaiterIfAvailable`
 * discards a delivery attempt when this engine no longer holds the claim
 * generation it parked the waiter under (`confirmWakeOwnership`), leaving the
 * durable coordinated-update request in place for the true owner to deliver.
 * But nothing DRIVES the true owner to look: `schedulePendingInlineUpdateDrain`
 * only fires a `setTimeout(0)` drain on the engine that RECEIVED the
 * `engine.update()`/`submitCoordinatedUpdate()` call, and the owning engine's
 * maintenance task polls the durable signal buffer and child-result state,
 * never pending coordinated updates. If the true owner is parked on
 * `ctx.waitForUpdate()`, or simply has no reason to re-check because nothing
 * else is advancing it, the caller's request sits durable and undelivered
 * until something unrelated happens to drive that workflow.
 *
 * **The fix.** The owning engine re-checks its own held workflows' pending
 * coordinated-update queues on the same cadence it renews their claims, and
 * drains any workflow with at least one buffered request — by any engine.
 * This bounds cross-engine update delivery latency at one renewal interval,
 * the same bound ADR 0002 already gives cross-engine signal delivery.
 *
 * **Scope and independence.** This module is the poll pass alone: given this
 * engine's held workflow ids, probe each for pending coordinated updates, and
 * drain the ones that have any. It does not read `pending-updates.ts` or
 * `updates.ts` directly — the dependencies below are small structural types
 * this module owns, so it stays independent of those modules' concrete
 * shapes. Draining is expected to be satisfied by composing
 * `processPendingUpdatesForHandlers` (drains inline `ctx.onUpdate()`
 * handlers) and `deliverCoordinatedUpdateToWaiterIfAvailable`-per-pending-
 * update (drains `ctx.waitForUpdate()` waiters) — both already idempotent and
 * fenced on this engine's own claim generation, so a poll racing a
 * concurrent delivery (the normal `setTimeout(0)` drain, or another poll
 * tick) is always safe to re-run. This module is also NOT a recurring task
 * by itself (compare `workflow-claim-renewal-task.ts`) — it is production-
 * wired by `ownership-bootstrap.ts`, which composes `EngineInternals` into a
 * real {@link OwnerSideUpdatePollTarget}, and by
 * `workflow-claim-renewal-task.ts`, which calls {@link runOwnerSideUpdatePoll}
 * against that target from the same lifecycle cadence that drives claim
 * renewal and signal polling.
 *
 * @module core/engine/owner-side-update-poll
 */

/**
 * The minimal structural shape this poll needs. Satisfied in production by
 * `ownership-bootstrap.ts`'s adapter, composed from `EngineInternals` —
 * without this module importing it.
 */
export type OwnerSideUpdatePollTarget = {
  /**
   * Every workflow id this engine currently holds a live claim for, active or
   * parked. Read fresh at the start of every pass — implementations may
   * return a live or a defensive-copy array; this poll never mutates it and
   * takes its own snapshot before iterating.
   *
   * Expected to be satisfied by `WorkflowClaimRegistry.listHeldWorkflowIds`,
   * the same source `workflow-claim-renewal-task.ts`'s own renewal sub-pass
   * uses.
   */
  listHeldWorkflowIds(): readonly string[];
  /**
   * Whether `workflowId` currently has at least one durably-buffered
   * coordinated-update request, without consuming any of them.
   *
   * Expected to be satisfied by
   * `internals.updateCoordinator.getPendingUpdates(workflowId).length > 0`.
   */
  hasPendingUpdates(workflowId: string): Promise<boolean>;
  /**
   * Drain every pending coordinated update currently buffered for
   * `workflowId`: deliver to a registered `ctx.onUpdate()` handler, or to a
   * parked `ctx.waitForUpdate()` waiter, whichever applies. Idempotent and
   * self-fenced on this engine's own current claim generation — safe to call
   * even when a concurrent drain (the normal post-request `setTimeout(0)`
   * trigger, or another poll tick) is racing it.
   */
  drainPendingUpdates(workflowId: string): Promise<void>;
};

/** One held workflow's outcome within a single update-poll pass. */
export type OwnerSideUpdatePollOutcome =
  | { workflowId: string; status: 'drained' }
  | { workflowId: string; status: 'no-pending-updates' }
  | { workflowId: string; status: 'drain-failed'; error: unknown };

/** The result of one full owner-side update poll pass ({@link runOwnerSideUpdatePoll}). */
export type OwnerSideUpdatePollResult = {
  /** `getNow()` read at the start of the pass, before any probe. */
  startedAt: number;
  /** `getNow()` read after every probe/drain has settled. */
  finishedAt: number;
  /** One entry per held workflow id the pass attempted, in iteration order. */
  outcomes: OwnerSideUpdatePollOutcome[];
  /** `outcomes.filter(o => o.status === 'drained').length`, precomputed for observability consumers. */
  drainedCount: number;
};

/** Options for {@link runOwnerSideUpdatePoll}. */
export type OwnerSideUpdatePollOptions = {
  target: OwnerSideUpdatePollTarget;
  /** Wall-clock source (ms), injected so tests never depend on real time. */
  getNow: () => number;
};

/**
 * Run exactly one owner-side update poll pass: snapshot this engine's
 * currently-held workflow ids, probe each for pending coordinated updates,
 * and drain the ones that have any. A drain failure for one workflow is
 * captured as a `'drain-failed'` outcome and never stops the remaining held
 * workflows in the same pass from being probed and, where pending, drained.
 */
export async function runOwnerSideUpdatePoll(
  options: OwnerSideUpdatePollOptions,
): Promise<OwnerSideUpdatePollResult> {
  const { target, getNow } = options;
  const startedAt = getNow();

  const heldWorkflowIds = target.listHeldWorkflowIds();
  const outcomes: OwnerSideUpdatePollOutcome[] = [];

  for (const workflowId of heldWorkflowIds) {
    const pending = await target.hasPendingUpdates(workflowId);
    if (!pending) {
      outcomes.push({ workflowId, status: 'no-pending-updates' });
      continue;
    }
    try {
      await target.drainPendingUpdates(workflowId);
      outcomes.push({ workflowId, status: 'drained' });
    } catch (error) {
      outcomes.push({ workflowId, status: 'drain-failed', error });
    }
  }

  const finishedAt = getNow();
  return {
    startedAt,
    finishedAt,
    outcomes,
    drainedCount: outcomes.filter((outcome) => outcome.status === 'drained').length,
  };
}
