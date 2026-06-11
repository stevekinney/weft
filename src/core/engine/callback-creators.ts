import { KEYS } from '../../storage/interface.ts';
import type { ContextOperationRequest } from '../context.ts';
import { HISTORY_CIRCUIT_BREAKER_REASON } from '../types.ts';
import { validateAttributeValueSizes } from './attributes-tags.ts';
import {
  createConstraintCallbacks,
  createLifecycleCallbacks,
  createTerminationCallbacks,
  registerEnsureRetentionSweepInterval,
} from './callback-creators-core.ts';
import { createOperationRouterCallbacks } from './callback-creators-router.ts';
import {
  appendTimelineBatchOperations,
  persistCheckpoint,
  pruneCheckpointHistory,
  validateDevelopmentCheckpoint,
} from './checkpoint-io.ts';
import { evaluateConstraints } from './constraints.ts';
import type { Engine } from './index.ts';
import {
  getParkedWorkflowResumeDisposition,
  parkInlineWorkflowAfterCheckpoint,
  resumeParkedInlineWorkflow,
  type InlineParkingCallbacks,
} from './inline-parking.ts';
import { getInternals } from './internals.ts';
import { processOperation, translateOperationRequest } from './operations-router.ts';
import {
  ensureRetentionSweepInterval,
  hasConfiguredRetention,
  runRetentionSweep,
  setNextRetentionSweepAt,
} from './retention.ts';
import { hasBufferedSignal } from './signals.ts';
import { loadWorkflowState, runSerializedWorkflowStateWrite } from './storage-io.ts';
import { swallowPromiseRejection } from './strategy-helpers.ts';
import { cleanupWaiters, terminateWorkflow, type TerminationCallbacks } from './termination.ts';

// Keep the callback factory families available from the engine callback module
// that owns their shared construction surface.
export { createUpdateCallbacks } from './callback-creators-bundles.ts';
export {
  createBroadcastCallbacks,
  createGuardCallbacks,
  createInlineLaunchQueueCallbacks,
  createLifecycleCallbacks,
  createRegistrationCallbacks,
  createTerminationCallbacks,
} from './callback-creators-core.ts';

export type { TerminationCallbacks };

export function createInlineParkingCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): InlineParkingCallbacks {
  return {
    createLifecycleCallbacks: () => createLifecycleCallbacks(engine),
    createTerminationCallbacks: () => createTerminationCallbacks(engine),
    evaluateConstraints: (workflowId) =>
      evaluateConstraints(getInternals(engine), workflowId, createConstraintCallbacks(engine)),
    getParkedWorkflowResumeDisposition: (workflowId) =>
      getParkedWorkflowResumeDisposition(
        getInternals(engine),
        workflowId,
        createInlineParkingCallbacks(engine),
      ),
    hasBufferedSignal: (workflowId, signalName) =>
      hasBufferedSignal(getInternals(engine), workflowId, signalName),
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    parkInlineWorkflowAfterCheckpoint: (workflowId, operation) =>
      parkInlineWorkflowAfterCheckpoint(
        getInternals(engine),
        workflowId,
        operation,
        createInlineParkingCallbacks(engine),
      ),
    persistCheckpoint: (workflowId, operation, workerCheckpointBytes) =>
      persistCheckpointForEngine(engine, workflowId, operation, workerCheckpointBytes),
    processOperation: (workflowId, operation) =>
      processOperation(
        getInternals(engine),
        workflowId,
        operation,
        createOperationRouterCallbacks(engine),
      ),
    readCheckpointBytes: (workflowId) =>
      getInternals(engine).storage.get(KEYS.checkpoint(workflowId)),
    resumeParkedInlineWorkflow: (workflowId) =>
      resumeParkedInlineWorkflow(
        getInternals(engine),
        workflowId,
        createInlineParkingCallbacks(engine),
      ),
    runSerializedWorkflowStateWrite: (workflowId, writeOperation) =>
      runSerializedWorkflowStateWrite(getInternals(engine), workflowId, writeOperation),
    translateOperationRequest: (operationRequest) =>
      translateOperationRequest(getInternals(engine), operationRequest),
    validateDevelopmentCheckpoint: (workflowId) =>
      validateDevelopmentCheckpoint(getInternals(engine), workflowId, {
        dispatchEvent: (event) => {
          engine.dispatchEvent(event);
        },
      }),
  };
}

export function persistCheckpointForEngine<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  operation: ContextOperationRequest,
  workerCheckpointBytes?: ArrayBuffer,
): Promise<void> {
  return persistCheckpoint(getInternals(engine), workflowId, operation, workerCheckpointBytes, {
    appendTimelineBatchOperations: (id, checkpointOperation, step, timestamp, operations) =>
      appendTimelineBatchOperations(
        getInternals(engine),
        id,
        checkpointOperation,
        step,
        timestamp,
        operations,
      ),
    swallowPromiseRejection: (promise) => {
      void swallowPromiseRejection(promise);
    },
    validateAttributeValueSizes,
    pruneCheckpointHistory: (id, step) => pruneCheckpointHistory(getInternals(engine), id, step),
    dispatchEvent: (event) => {
      engine.dispatchEvent(event);
    },
    enforceHistoryCircuitBreaker: (id) =>
      terminateWorkflow(
        getInternals(engine),
        id,
        'timed-out',
        createTerminationCallbacks(engine),
        HISTORY_CIRCUIT_BREAKER_REASON,
      ),
  });
}

function ensureRetentionSweepIntervalForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): void {
  ensureRetentionSweepInterval(getInternals(engine), {
    hasConfiguredRetention: () => hasConfiguredRetention(getInternals(engine)),
    runRetentionSweep: () =>
      runRetentionSweep(
        getInternals(engine),
        (source, error) => createTerminationCallbacks(engine).handleCleanupError(source, error),
        (workflowId) =>
          cleanupWaiters(getInternals(engine), workflowId, createTerminationCallbacks(engine)),
      ),
    setNextRetentionSweepAt: () => setNextRetentionSweepAt(getInternals(engine)),
  });
}

// Wire the retention-sweep hook into the core registry at module load.
registerEnsureRetentionSweepInterval((engine) => ensureRetentionSweepIntervalForEngine(engine));
