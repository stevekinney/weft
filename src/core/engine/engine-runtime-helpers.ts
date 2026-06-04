import { createExpiredResponseCleanupTick } from '../engine-helpers.ts';
import type { AnyActivityDefinition } from '../types.ts';
import { createLifecycleCallbacks, createTerminationCallbacks } from './callback-creators-core.ts';
import {
  engineCleanupIntervalFinalizer,
  type EngineCleanupIntervalDisposalTracker,
} from './engine-leak-warnings.ts';
import type { Engine } from './index.ts';
import {
  drainQueuedInlineWorkflowStarts,
  flushQueuedInlineWorkflowStarts,
  type InlineLaunchQueueCallbacks,
} from './inline-launch-queue.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import { swallowPromiseRejection } from './strategy-helpers.ts';

export function isActivityDefinition(value: unknown): value is AnyActivityDefinition {
  return (
    typeof value === 'function' &&
    typeof value.name === 'string' &&
    'execute' in value &&
    typeof (value as { execute?: unknown }).execute === 'function'
  );
}

/**
 * Build the {@link InlineLaunchQueueCallbacks} for an engine. Single owner for
 * the scheduled-flush handler and the dispose-time drain so both advance a
 * queued start through exactly the same callbacks.
 */
function inlineLaunchQueueCallbacksForEngine<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): InlineLaunchQueueCallbacks {
  return {
    processPendingUpdatesAfterInlineAdvance: (workflowId) =>
      createLifecycleCallbacks(engine).processPendingUpdatesAfterInlineAdvance(workflowId),
    swallowPromiseRejection: (promise) => swallowPromiseRejection(promise),
  };
}

export function createQueuedInlineWorkflowStartHandler<
  TWorkflows extends object,
  TActivities extends object,
>(weakEngine: WeakRef<Engine<TWorkflows, TActivities>>, channel: MessageChannel): () => void {
  return function handleQueuedInlineWorkflowStart() {
    const engine = weakEngine.deref();
    if (engine === undefined) {
      channel.port1.close();
      channel.port2.close();
      return;
    }

    getInternals(engine).queuedInlineWorkflowStartFlushScheduled = false;
    void swallowPromiseRejection(
      flushQueuedInlineWorkflowStarts(
        getInternals(engine),
        inlineLaunchQueueCallbacksForEngine(engine),
      ),
    );
  };
}

/**
 * Drain pending inline launches for `engine` before teardown. Built with the
 * same inline-launch-queue callbacks as the scheduled flush handler so a drained
 * start advances identically to a normally-flushed one. Called from
 * `[Symbol.asyncDispose]` ahead of synchronous disposal (which aborts the signal
 * and would otherwise discard the queue).
 */
export async function drainQueuedInlineWorkflowStartsForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): Promise<void> {
  await drainQueuedInlineWorkflowStarts(
    getInternals(engine),
    inlineLaunchQueueCallbacksForEngine(engine),
  );
}

export function createCleanupIntervalTick<TWorkflows extends object, TActivities extends object>(
  weakEngine: WeakRef<Engine<TWorkflows, TActivities>>,
  tracker: EngineCleanupIntervalDisposalTracker,
): () => void {
  return function cleanupExpiredResponsesForLiveEngine() {
    const engine = weakEngine.deref();
    if (engine === undefined) {
      if (tracker.cleanupInterval !== null) {
        clearInterval(tracker.cleanupInterval);
        tracker.cleanupInterval = null;
      }
      return;
    }

    const internals = getInternals(engine);
    createExpiredResponseCleanupTick(internals.updateCoordinator, (source, error) =>
      createTerminationCallbacks(engine).handleCleanupError(source, error),
    )();
  };
}

export function disposeEngineCleanupInterval(internals: EngineInternals): void {
  if (internals.cleanupInterval !== null) {
    clearInterval(internals.cleanupInterval ?? undefined);
    internals.cleanupInterval = null;
  }
  if (internals.cleanupIntervalDisposalTracker !== null) {
    internals.cleanupIntervalDisposalTracker.disposed = true;
    internals.cleanupIntervalDisposalTracker.cleanupInterval = null;
    engineCleanupIntervalFinalizer.unregister(internals.cleanupIntervalDisposalTracker);
    internals.cleanupIntervalDisposalTracker = null;
  }
}
