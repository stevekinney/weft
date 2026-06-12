import { disposeEngineCleanupInterval } from './engine-runtime-helpers.ts';
import { EngineDisposedError } from './errors.ts';
import { disposeQueuedInlineWorkflowStarts } from './inline-launch-queue.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Synchronous teardown for an {@link Engine}. Moved verbatim from
 * `Engine[Symbol.dispose]` — the operation order is correctness-sensitive
 * (abort before clearing waiters, dispose strategies before nulling them) and
 * is preserved exactly. `Engine[Symbol.dispose]` and `[Symbol.asyncDispose]`
 * both delegate here.
 */
export function disposeEngine(internals: EngineInternals): void {
  internals.disposed = true;
  internals.alertManager?.[Symbol.dispose]();
  internals.alertManager = null;
  internals.abortController.abort();
  for (const resolveSignalWaiter of internals.signalWaiters.values()) {
    resolveSignalWaiter();
  }
  internals.signalWaiters.clear();
  internals.signalWaitersByWorkflow.clear();
  for (const resolveConditionWaiter of internals.conditionWaiters.values()) {
    resolveConditionWaiter();
  }
  internals.conditionWaiters.clear();
  disposeQueuedInlineWorkflowStarts(internals);
  internals.scheduler[Symbol.dispose]();
  internals.strategy[Symbol.dispose]();
  internals.activityWorkerDispatcher?.[Symbol.dispose]();
  internals.activityWorkerDispatcher = null;
  internals.inlineStrategy = null;
  disposeEngineCleanupInterval(internals);
  if (internals.retentionSweepInterval !== null) {
    clearInterval(internals.retentionSweepInterval ?? undefined);
    internals.retentionSweepInterval = null;
  }
  internals.nextRetentionSweepAt = null;
  disposeSecondInstanceDetection(internals);
  internals.handleCache.clear();
  // Reject pending result waiters before clearing so external `handle.result()`
  // callers observe a deterministic rejection instead of a promise that never
  // settles. Mirrors the signalWaiters settle-before-clear precedent above.
  // (update/review waiters are internal generator wait-frames awaited only by
  // the now-disposed engine; abandoning them is correct, and resolving them
  // would step a workflow generator against torn-down machinery. External
  // update/review callers are bounded by their own response timeouts.)
  for (const waiter of internals.resultResolvers.values()) {
    waiter.reject(new EngineDisposedError());
  }
  internals.resultResolvers.clear();
  internals.updateWaiters.clear();
  internals.updateWaitersByWorkflow.clear();
  internals.reviewWaiters.clear();
  internals.reviewWaitersByWorkflow.clear();
  internals.reviewEscalationHandlers.clear();
  internals.workflowReviewIds.clear();
  internals.parkedInlineWorkflows.clear();
  internals.terminalizingWorkflows.clear();
  internals.deliveredPendingUpdateIds.clear();
  internals.reviewTimerIds.clear();
  for (const controller of internals.pendingWebhooks) controller.abort();
  internals.pendingWebhooks.clear();
  internals.sleepResolvers.clear();
  internals.sleepResolversByWorkflow.clear();
  internals.checkpoints.clear();
  internals.pendingExecutionStateOwnerId = undefined;
  internals.workflowNestingDepths.clear();
  // Release per-run `services` held in engine memory. Only terminal cleanup and
  // start-rollback delete these entries, so a run that never reaches a terminal
  // state would otherwise strand its credential-bearing closures live past
  // dispose. Clearing here closes that leak on engine teardown.
  internals.workflowServices.clear();
  internals.workflowHeaders.clear();
  internals.pendingStarts.clear();
  internals.pendingScheduleCreations.clear();
  internals.eventLogHeads.clear();
  internals.pendingTimelineEntries.clear();
  internals.workflowVersionTuples.clear();
  internals.workflowFeedListeners.clear();
  internals.activityRegistriesByWorkflow.clear();
  internals.workflowDefinitionsByName.clear();
  internals.workflowTypeByWorkflowId.clear();
  internals.broadcastChannel?.close();
  internals.broadcastChannel = null;
}

/**
 * Tear down the best-effort second-instance detector: clear its interval and
 * fire its best-effort heartbeat cleanup. The `stop()` delete is fire-and-forget —
 * disposal is synchronous and must not await a storage round-trip. A no-op when
 * detection was never enabled.
 */
function disposeSecondInstanceDetection(internals: EngineInternals): void {
  if (internals.secondInstanceDetectionInterval !== null) {
    clearInterval(internals.secondInstanceDetectionInterval ?? undefined);
    internals.secondInstanceDetectionInterval = null;
  }
  if (internals.secondInstanceDetector !== null) {
    void internals.secondInstanceDetector.stop();
    internals.secondInstanceDetector = null;
  }
}
