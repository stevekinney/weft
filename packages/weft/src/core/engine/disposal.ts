import { WorkflowSourceLoadCancelledEvent } from '../events/workflow-source-events.ts';
import { disposeEngineCleanupInterval } from './engine-runtime-helpers.ts';
import { EngineDisposedError } from './errors.ts';
import { disposeQueuedInlineWorkflowStarts } from './inline-launch-queue.ts';
import type { EngineInternals } from './internals.ts';
import { rejectAllSleepTimerAcknowledgements } from './sleep-timer-acknowledgements.ts';

function settleSleepResolverReadyWaitersForTesting(internals: EngineInternals): void {
  for (const waiters of internals.sleepResolverReadyWaitersForTesting?.values() ?? []) {
    for (const notifyReady of waiters) notifyReady();
  }
  internals.sleepResolverReadyWaitersForTesting?.clear();
}

/**
 * Cancel every pending cross-engine result-poll timer — see
 * `pendingResultPollTimers`'s doc on `EngineInternals`. Split out of
 * `disposeEngine` purely to keep that function's own cyclomatic complexity
 * under the repository's ceiling.
 */
function clearPendingResultPollTimers(internals: EngineInternals): void {
  for (const timer of internals.pendingResultPollTimers) clearTimeout(timer);
  internals.pendingResultPollTimers.clear();
}

/**
 * Reject pending result waiters before clearing so external `handle.result()`
 * callers observe a deterministic rejection instead of a promise that never
 * settles. Mirrors the signalWaiters settle-before-clear precedent above.
 * (update/review waiters are internal generator wait-frames awaited only by
 * the now-disposed engine; abandoning them is correct, and resolving them
 * would step a workflow generator against torn-down machinery. External
 * update/review callers are bounded by their own response timeouts.) Split
 * out of `disposeEngine` for the same complexity-ceiling reason as
 * {@link clearPendingResultPollTimers}.
 */
function rejectPendingResultResolvers(internals: EngineInternals): void {
  for (const waiter of internals.resultResolvers.values()) {
    waiter.reject(new EngineDisposedError());
  }
}

/**
 * Dynamic workflow sources (WFT-13/14, WFT-15/16): abort every outstanding
 * `resolveWorkflowSource()` caller's own per-call controller (the shared
 * per-`(name, revision)` load itself is NOT aborted — it keeps running to
 * completion independent of any individual waiter, per the single-flight
 * contract; see `core/engine/source-resolution.ts`). Clearing
 * `resolutionsInFlight` after aborting means a `resolveWorkflowSource()`
 * call made after this point never joins a zombie promise — it observes
 * `internals.disposed` and rejects immediately instead.
 *
 * Captures every `(name, revision)` key whose diagnostics are still
 * `loading` BEFORE clearing, and dispatches exactly one
 * `WorkflowSourceLoadCancelledEvent` per key via `dispatchEvent` —
 * disposal aborts every waiter controller synchronously, but each
 * waiter's own `finally` (which would otherwise detect "last waiter
 * releasing while loading") only runs on a later microtask, by which time
 * this function has already cleared the diagnostics it would have read;
 * doing the sweep here, synchronously, before clearing, is what makes the
 * event fire exactly once per key instead of never. Split out of
 * `disposeEngine` for the same complexity-ceiling reason as
 * {@link clearPendingResultPollTimers}.
 */
function disposeSourceResolutionState(
  internals: EngineInternals,
  dispatchEvent: (event: Event) => void,
): void {
  for (const controller of internals.sources.waiterControllers) {
    controller.abort(new EngineDisposedError());
  }
  const stillLoading: Array<{ name: string; revision: string; kind: 'module' }> = [];
  for (const [name, byRevision] of internals.sources.diagnostics) {
    for (const [revision, entry] of byRevision) {
      if (entry.state === 'loading') stillLoading.push({ name, revision, kind: entry.kind });
    }
  }
  internals.sources.waiterControllers.clear();
  internals.sources.resolutionsInFlight.clear();
  internals.sources.byName.clear();
  internals.sources.resolved.clear();
  internals.sources.waitersByKey.clear();
  internals.sources.lastResolvedRevisionByName.clear();
  internals.sources.diagnostics.clear();
  for (const { name, revision, kind } of stillLoading) {
    dispatchEvent(new WorkflowSourceLoadCancelledEvent(name, revision, kind));
  }
}

/**
 * Synchronous teardown for an {@link Engine}. Moved verbatim from
 * `Engine[Symbol.dispose]` — the operation order is correctness-sensitive
 * (abort before clearing waiters, dispose strategies before nulling them) and
 * is preserved exactly. `Engine[Symbol.dispose]` and `[Symbol.asyncDispose]`
 * both delegate here. `dispatchEvent` defaults to a no-op so every existing
 * direct-internals test that calls this with one argument keeps compiling
 * and running — only `Engine`'s own two call sites pass the real
 * `engine.dispatchEvent` binding, which is what lets
 * `disposeSourceResolutionState` fire `workflow-source:load-cancelled`.
 */
export function disposeEngine(
  internals: EngineInternals,
  dispatchEvent: (event: Event) => void = () => {},
): void {
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
  disposeLeaseManager(internals);
  internals.handleCache.clear();
  rejectPendingResultResolvers(internals);
  rejectAllSleepTimerAcknowledgements(internals, new EngineDisposedError());
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
  disposeSourceResolutionState(internals, dispatchEvent);
  clearPendingResultPollTimers(internals);
  internals.sleepResolvers.clear();
  internals.sleepResolversByWorkflow.clear();
  settleSleepResolverReadyWaitersForTesting(internals);
  internals.sleepTimerAcknowledgementWaiters.clear();
  internals.durableInlineOperations.clear();
  internals.sleepTimersFiredWithoutResolver.clear();
  internals.checkpoints.clear();
  internals.pendingExecutionStateOwnerId = undefined;
  internals.pendingParentWorkflowId = undefined;
  internals.pendingParentWorkflowExecutionToken = undefined;
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
  internals.pendingAtomicWorkflowCommitSideEffects.clear();
  internals.pendingAsyncActivityResolutions.clear();
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

/**
 * Tear down the ownership lease: stop renewals and detach the manager. This does
 * NOT release the holder key — releasing is left to the caller so each disposal
 * path issues exactly one release. `Engine[Symbol.dispose]` fires a best-effort
 * release after this returns; `Engine[Symbol.asyncDispose]` awaits the release
 * after in-memory teardown (so the holder key is durably gone before it resolves,
 * giving `await using` a clean handoff). A no-op when `ownership: 'lease'` was
 * never configured. The manager is captured by the caller before this nulls the
 * field, since `stop()` only halts renewals — it does not delete the holder.
 */
function disposeLeaseManager(internals: EngineInternals): void {
  if (internals.leaseManager !== null) {
    internals.leaseManager.stop();
    internals.leaseManager = null;
  }
}
