import type { EngineInternals } from './internals.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

/**
 * Re-drive every in-process `ctx.waitUntil` waiter registered for a workflow.
 * Called after an inline `onUpdate` handler runs (`tryInlineUpdateHandler`) —
 * since the handler may have mutated the workflow-local state a predicate
 * reads — and, via `operations-time.ts`'s `resolveConditionTimer`, when a
 * `ctx.waitUntil()` deadline timer fires. Each call wakes the parked
 * `processWaitConditionOperation`, which re-evaluates its predicate against
 * the (possibly mutated) state.
 *
 * Weft signals are pull-only (`ctx.waitForSignal`) and run no state-mutating
 * handler, so signal delivery is intentionally NOT a re-drive trigger — `onUpdate`
 * is the push path. Lives in its own module so `updates.ts` can call it without
 * an import cycle through `operations-coordination.ts`.
 *
 * **`wakeOwnershipCheck` under `ownership: 'workflow-lease'`.** This is a
 * claim-requiring wake site (ADR 0002's `wait-condition` kind): resolving
 * `conditionWaiters` drives a parked generator turn. Every existing caller of
 * this function (`updates.ts`, `pending-updates.ts`,
 * `operations-time.ts`) calls it synchronously with no `await` and must stay
 * that way — this function's signature stays `void`, never `Promise<void>`,
 * so none of them becomes a floating-promise lint violation. Under `'none'`/
 * `'lease'` (`workflowClaimRegistry === null`) the resolver is looked up and
 * called synchronously — byte-identical to before this check existed. Under
 * `'workflow-lease'` the ownership re-read runs as a fire-and-forget async
 * check, and the resolver is looked up fresh (never captured before the
 * await) once that check settles, so a newer waiter registered in the
 * meantime is never resolved by a stale reference.
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
