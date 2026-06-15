import { HISTORY_CIRCUIT_BREAKER_REASON } from '../types.ts';
import {
  broadcast as broadcastFromInternals,
  forwardEventToHandle as forwardEventToHandleFromBroadcast,
  type BroadcastCallbacks,
} from './broadcast.ts';
import type { ConstraintCallbacks } from './constraints.ts';
import type { GuardCallbacks } from './guards.ts';
import { createWorkflowHandleWithResultPromise } from './handle-result.ts';
import type { Engine } from './index.ts';
import {
  hasLocalCheckpointOwnership,
  isInlineWorkflowLocallyOwned,
  queueInlineWorkflowExecutionStart,
  type InlineLaunchQueueCallbacks,
} from './inline-launch-queue.ts';
import { getInternals } from './internals.ts';
import { processPendingUpdatesAfterReplay, type LifecycleCallbacks } from './lifecycle.ts';
import {
  processPendingUpdatesAfterInlineAdvance,
  processPendingUpdatesForHandlers,
} from './pending-updates.ts';
import { resolveWorkflowTypeTarget, type RegistrationCallbacks } from './registration.ts';
import { cleanupReviews } from './reviews.ts';
import {
  commitFencedWorkflowStateOperations,
  loadWorkflowState,
  runSerializedWorkflowStateWrite,
} from './storage-io.ts';
import {
  feedOperationResult,
  getComposedWorkflowInterceptor,
  swallowPromiseRejection,
} from './strategy-helpers.ts';
import {
  failWorkflow,
  handleCleanupError,
  terminateWorkflow,
  type TerminationCallbacks,
} from './termination.ts';

/**
 * Public update-broadcast hook shape used by callback-bundle factories that
 * dispatch `update:completed` events back to engine consumers.
 */
export type PendingUpdateBroadcastCallbacks = {
  dispatchEvent: (event: Event) => boolean;
  broadcast: (message: { type: 'update:completed'; workflowId: string; updateId: string }) => void;
};

export function createPendingUpdateCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): PendingUpdateBroadcastCallbacks {
  return {
    dispatchEvent: (event) => engine.dispatchEvent(event),
    broadcast: (message) =>
      broadcastFromInternals(getInternals(engine), message, createBroadcastCallbacks(engine)),
  };
}

export function createInlineLaunchQueueCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): InlineLaunchQueueCallbacks {
  return {
    processPendingUpdatesAfterInlineAdvance: (workflowId) =>
      processPendingUpdatesAfterInlineAdvanceForEngine(engine, workflowId),
    swallowPromiseRejection: (promise) => swallowPromiseRejection(promise),
  };
}

export async function processPendingUpdatesAfterInlineAdvanceForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, workflowId: string): Promise<void> {
  try {
    await processPendingUpdatesAfterInlineAdvance(
      getInternals(engine),
      workflowId,
      createPendingUpdateCallbacks(engine),
    );
  } catch (error: unknown) {
    createTerminationCallbacks(engine).handleCleanupError(
      'processPendingUpdates',
      error,
      workflowId,
    );
  }
}

export function createLifecycleCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): LifecycleCallbacks {
  return {
    dispatchEvent: (event) => {
      engine.dispatchEvent(event);
    },
    getHandle: (workflowId) => engine.getHandle(workflowId),
    createWorkflowHandleWithResultPromise: (workflowId) =>
      createWorkflowHandleWithResultPromise(getInternals(engine), workflowId),
    runSerializedWorkflowStateWrite: (workflowId, writeOperation) =>
      runSerializedWorkflowStateWrite(getInternals(engine), workflowId, writeOperation),
    getComposedWorkflowInterceptor: () => getComposedWorkflowInterceptor(getInternals(engine)),
    resolveWorkflowTypeTarget: (target) =>
      resolveWorkflowTypeTarget(getInternals(engine), target, createRegistrationCallbacks(engine)),
    processPendingUpdatesAfterReplay: (workflowId) => {
      void processPendingUpdatesAfterReplay(getInternals(engine), workflowId, {
        processPendingUpdatesForHandlers: (id) =>
          processPendingUpdatesForHandlers(
            getInternals(engine),
            id,
            createPendingUpdateCallbacks(engine),
          ),
        handleCleanupError: (source, error, id) =>
          createTerminationCallbacks(engine).handleCleanupError(source, error, id),
      });
    },
    processPendingUpdatesAfterInlineAdvance: (workflowId) =>
      processPendingUpdatesAfterInlineAdvanceForEngine(engine, workflowId),
    processPendingUpdatesForHandlers: (workflowId) =>
      processPendingUpdatesForHandlers(
        getInternals(engine),
        workflowId,
        createPendingUpdateCallbacks(engine),
      ),
    queueInlineWorkflowExecutionStart: (start) =>
      queueInlineWorkflowExecutionStart(
        getInternals(engine),
        start,
        createInlineLaunchQueueCallbacks(engine),
      ),
    isInlineWorkflowLocallyOwned: (workflowId, workflowStatus) =>
      isInlineWorkflowLocallyOwned(getInternals(engine), workflowId, workflowStatus),
    hasLocalCheckpointOwnership: (workflowId, workflowStatus) =>
      hasLocalCheckpointOwnership(getInternals(engine), workflowId, workflowStatus),
    handleCleanupError: (source, error, workflowId) =>
      createTerminationCallbacks(engine).handleCleanupError(source, error, workflowId),
    swallowPromiseRejection: (promise) => swallowPromiseRejection(promise),
    enforceHistoryCircuitBreaker: (workflowId) =>
      terminateWorkflow(
        getInternals(engine),
        workflowId,
        'timed-out',
        createTerminationCallbacks(engine),
        HISTORY_CIRCUIT_BREAKER_REASON,
      ),
    failWorkflowForUnavailableServices: (workflowId, error) =>
      failWorkflow(
        getInternals(engine),
        workflowId,
        error,
        createTerminationCallbacks(engine),
        'system',
      ),
    failWorkflowForCheckpointDecodeError: (workflowId, error) =>
      failWorkflow(
        getInternals(engine),
        workflowId,
        error,
        createTerminationCallbacks(engine),
        'system',
      ),
  };
}

/**
 * Build the termination callback bundle.
 *
 * The `handleScheduledWorkflowTerminal` callback is parameterized so this
 * factory does not depend on the schedule sibling module; callers wire in the
 * schedule terminal hook from `callback-creators-schedule.ts`.
 */
export function createTerminationCallbacksWith<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  handleScheduledWorkflowTerminal: (workflowId: string) => Promise<void>,
): TerminationCallbacks {
  const dispatchEvent = (event: Event): void => {
    engine.dispatchEvent(event);
  };
  return {
    dispatchEvent,
    forwardEventToHandle: (workflowId, event) =>
      forwardEventToHandleFromBroadcast(
        getInternals(engine),
        workflowId,
        event,
        createBroadcastCallbacks(engine),
      ),
    broadcast: (message) =>
      broadcastFromInternals(getInternals(engine), message, createBroadcastCallbacks(engine)),
    swallowPromiseRejection: (promise) => swallowPromiseRejection(promise),
    handleCleanupError: (source, error, workflowId) =>
      handleCleanupError(getInternals(engine), source, error, workflowId, { dispatchEvent }),
    handleScheduledWorkflowTerminal,
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    runSerializedWorkflowStateWrite: (workflowId, writeOperation) =>
      runSerializedWorkflowStateWrite(getInternals(engine), workflowId, writeOperation),
    // Lifecycle advances (suspend, completion) commit through the FENCED variant so
    // a deposed engine's terminal/suspend write loses its CAS instead of corrupting
    // the successor. Operator mutations (setAttributes) call the unfenced variant
    // directly in attributes-tags.ts and are intentionally NOT routed here.
    commitWorkflowStateOperations: (state, operations, options) =>
      commitFencedWorkflowStateOperations(getInternals(engine), state, operations, options),
    cleanupReviews: (workflowId) => cleanupReviews(getInternals(engine), workflowId),
  };
}

/**
 * Schedule terminal hook resolver. This is overwritten by the schedule
 * callback module at import time to break the otherwise circular dependency
 * between termination and schedule callback factories. Defaults to a no-op
 * during very early initialization (which never happens in practice because
 * the schedule module is always imported before any engine is constructed).
 */
let scheduledWorkflowTerminalHandler: <TW extends object, TA extends object>(
  engine: Engine<TW, TA>,
  workflowId: string,
) => Promise<void> = async () => undefined;

export function registerScheduledWorkflowTerminalHandler(
  handler: <TW extends object, TA extends object>(
    engine: Engine<TW, TA>,
    workflowId: string,
  ) => Promise<void>,
): void {
  scheduledWorkflowTerminalHandler = handler;
}

export function createTerminationCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): TerminationCallbacks {
  return createTerminationCallbacksWith(engine, (workflowId) =>
    scheduledWorkflowTerminalHandler(engine, workflowId),
  );
}

export function createRegistrationCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): RegistrationCallbacks {
  return {
    ensureRetentionSweepInterval: () => ensureRetentionSweepIntervalCallable(engine),
    dispatchEvent: (event) => engine.dispatchEvent(event),
  };
}

let retentionSweepIntervalCallable: <TW extends object, TA extends object>(
  engine: Engine<TW, TA>,
) => void = () => undefined;

export function registerEnsureRetentionSweepInterval(
  fn: <TW extends object, TA extends object>(engine: Engine<TW, TA>) => void,
): void {
  retentionSweepIntervalCallable = fn;
}

function ensureRetentionSweepIntervalCallable<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): void {
  retentionSweepIntervalCallable(engine);
}

export function createBroadcastCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): BroadcastCallbacks {
  return { dispatchEvent: (event) => engine.dispatchEvent(event) };
}

export function createGuardCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): GuardCallbacks {
  return {
    deleteRequestIfUnconsumed: (workflowId, updateId) =>
      getInternals(engine).updateCoordinator.deleteRequestIfUnconsumed(workflowId, updateId),
    getUpdateResponse: (updateId) => getInternals(engine).updateCoordinator.getResponse(updateId),
  };
}

export function createConstraintCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): ConstraintCallbacks {
  return {
    cancelWorkflowInStrategy: (workflowId) =>
      getInternals(engine).strategy.cancelWorkflow(workflowId),
    dispatchEvent: (event) => engine.dispatchEvent(event),
    failWorkflow: (workflowId, error) =>
      failWorkflow(getInternals(engine), workflowId, error, createTerminationCallbacks(engine)),
    feedOperationResult: (workflowId, outcome, originalError) =>
      feedOperationResult(getInternals(engine), workflowId, outcome, originalError),
  };
}
