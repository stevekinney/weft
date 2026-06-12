import type { EngineInternals } from './internals.ts';

/**
 * Re-drive every in-process `ctx.waitUntil` waiter registered for a workflow.
 * Called after an inline `onUpdate` handler runs (`tryInlineUpdateHandler`),
 * since the handler may have mutated the workflow-local state a predicate reads.
 * Each call wakes the parked `processWaitConditionOperation`, which re-evaluates
 * its predicate against the (possibly mutated) state.
 *
 * Weft signals are pull-only (`ctx.waitForSignal`) and run no state-mutating
 * handler, so signal delivery is intentionally NOT a re-drive trigger — `onUpdate`
 * is the push path. Lives in its own module so `updates.ts` can call it without
 * an import cycle through `operations-coordination.ts`.
 */
export function notifyConditionWaiters(internals: EngineInternals, workflowId: string): void {
  // At most one active wait-condition per workflow (see EngineInternals.
  // conditionWaiters), so this is a single keyed lookup, not a fan-out. The
  // resolver is absent when the workflow has no active `waitUntil` — e.g. an
  // `onUpdate` arrived before the workflow reached `waitUntil`, or after it
  // already completed. That is a harmless no-op poke.
  const resolve = internals.conditionWaiters.get(workflowId);
  if (resolve) resolve();
}
