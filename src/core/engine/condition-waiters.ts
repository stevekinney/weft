import type { EngineInternals } from './internals.ts';
import { confirmWakeOwnership, type WakeOwnershipDecision } from './wake-ownership-guard.ts';

/**
 * Re-drive every in-process `ctx.waitUntil` waiter registered for a workflow.
 * Called after an inline `onUpdate` handler runs (`tryInlineUpdateHandler`) —
 * since the handler may have mutated the workflow-local state a predicate
 * reads. Wakes the parked `processWaitConditionOperation`, which re-evaluates
 * its predicate against the (possibly mutated) state.
 *
 * Weft signals are pull-only (`ctx.waitForSignal`) and run no state-mutating
 * handler, so signal delivery is intentionally NOT a re-drive trigger — `onUpdate`
 * is the push path. Lives in its own module so `updates.ts` can call it without
 * an import cycle through `operations-coordination.ts`.
 *
 * **`wakeOwnershipCheck` under `ownership: 'workflow-lease'`.** This is a
 * claim-requiring wake site (ADR 0002's `wait-condition` kind): resolving
 * `conditionWaiters` drives a parked generator turn. This function's only
 * remaining callers — `updates.ts` and `pending-updates.ts` — invoke it from
 * an `onUpdate` handler with no associated durable timer to protect, so they
 * call it synchronously with no `await` and must stay that way: this
 * function's signature stays `void`, never `Promise<void>`, so neither
 * becomes a floating-promise lint violation. Under `'none'`/`'lease'`
 * (`workflowClaimRegistry === null`) the resolver is looked up and called
 * synchronously — byte-identical to before this check existed. Under
 * `'workflow-lease'` the ownership re-read runs as a fire-and-forget async
 * check, and the resolver is looked up fresh (never captured before the
 * await) once that check settles, so a newer waiter registered in the
 * meantime is never resolved by a stale reference.
 *
 * The durable-timer-driven wake (a `wait-condition` deadline timer firing)
 * does NOT use this function — see {@link notifyConditionWaitersForTimerFire}
 * below. That caller feeds directly into the `Scheduler`'s "was this fire
 * processed" decision, so it cannot be fire-and-forget the way an
 * `onUpdate`-driven poke safely can.
 */
export function notifyConditionWaiters(internals: EngineInternals, workflowId: string): void {
  // At most one active wait-condition per workflow (see EngineInternals.
  // conditionWaiters), so this is a single keyed lookup, not a fan-out. The
  // resolver is absent when the workflow has no active `waitUntil` — e.g. an
  // `onUpdate` arrived before the workflow reached `waitUntil`, or after it
  // already completed. That is a harmless no-op poke.
  if (internals.workflowClaimRegistry === null) {
    internals.conditionWaiters.get(workflowId)?.();
    return;
  }

  void confirmWakeOwnership(internals, workflowId, 'wait-condition').then((decision) =>
    decision === 'proceed' ? internals.conditionWaiters.get(workflowId)?.() : undefined,
  );
}

/**
 * Timer-driven counterpart to {@link notifyConditionWaiters}, used only by
 * `operations-time.ts`'s `resolveConditionTimer` when a durable
 * `ctx.waitUntil()` deadline timer fires under `ownership: 'workflow-lease'`.
 *
 * Unlike the `onUpdate`-driven path above, this caller feeds directly into
 * the `Scheduler`'s `#processSelectedTimer`: once the returned promise
 * settles, the caller decides whether the Scheduler may treat this fire as
 * "processed" and durably delete the timer key. A fire-and-forget check here
 * (mirroring `notifyConditionWaiters`'s `'workflow-lease'` branch) would let
 * the Scheduler delete the timer before the ownership decision — and, on a
 * `'proceed'`, the wake dispatch itself — has actually happened, stranding a
 * parked workflow with no deterministic timeout record if the process exits
 * or disposes in that window. So this returns the raw {@link
 * WakeOwnershipDecision} instead of swallowing it: the caller uses a
 * `'discard'` to decide retain-vs-collect via
 * `sleep-timer-acknowledgements.ts`'s `resolveDiscardedTimerDisposition`,
 * the same disposal policy the `sleep` wake kind shares this hazard with.
 */
export async function notifyConditionWaitersForTimerFire(
  internals: EngineInternals,
  workflowId: string,
): Promise<WakeOwnershipDecision> {
  const decision = await confirmWakeOwnership(internals, workflowId, 'wait-condition');
  if (decision === 'proceed') {
    internals.conditionWaiters.get(workflowId)?.();
  }
  return decision;
}
