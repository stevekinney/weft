import type { ContextOperationRequest } from '../context.ts';
import { UpdateCompletedEvent } from '../events.ts';
import type { HumanReviewOptions } from '../review/index.ts';
import {
  broadcast as broadcastFromInternals,
  dispatchPendingUpdateReceived as dispatchPendingUpdateReceivedFromBroadcast,
} from './broadcast.ts';
import {
  createBroadcastCallbacks,
  createGuardCallbacks,
  createLifecycleCallbacks,
  createPendingUpdateCallbacks,
  createTerminationCallbacks,
} from './callback-creators-core.ts';
// Lazy access to the operation router via a registry — breaks the static
// cycle (router imports these bundle factories; the *ForEngine helpers below
// need the router-callback bundle).
import { callRouterCallbacks } from './callback-creators-router-registry.ts';
import {
  createReviewOperationCallbacks,
  handleScheduleTimerForEngine,
} from './callback-creators-schedule.ts';
import type { ChildWorkflowOperationCallbacks } from './child-workflow.ts';
import { guardTerminalWorkflow, guardTerminalWorkflowAfterCoordinatedRequest } from './guards.ts';
import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import {
  beginWorkflowExecution,
  loadWorkflowStartHeaders,
  parseStartOptionDuration,
  setWorkflowStartHeaders,
  startWorkflow,
  workflowVersionTupleFromState,
} from './lifecycle.ts';
import type { ActivityOperationCallbacks } from './operations-activity.ts';
import type { CoordinationOperationCallbacks } from './operations-coordination.ts';
import type { DataOperationCallbacks } from './operations-data.ts';
import {
  completeOperation,
  runOperationWithResult,
  runOperationWithoutResult,
  type OperationWithCallerStack,
} from './operations-router.ts';
import type { StateOperationCallbacks } from './operations-state.ts';
import type { StreamOperationCallbacks } from './operations-stream.ts';
import type { TimeOperationCallbacks } from './operations-time.ts';
import { schedulePendingInlineUpdateDrain } from './pending-updates.ts';
import { processReviewOperation } from './reviews.ts';
import { loadWorkflowState, runSerializedWorkflowStateWrite } from './storage-io.ts';
import {
  getComposedActivityInterceptor,
  getComposedWorkflowInterceptor,
} from './strategy-helpers.ts';
import { executeSubOperation } from './sub-operation.ts';
import {
  ensureTerminalCleanupTracked,
  failWorkflow,
  runDeferredTerminalCleanup,
} from './termination.ts';
import {
  createCoordinatedUpdateResponder,
  deliverCoordinatedUpdateToWaiterIfAvailable,
  findPendingUpdateByName,
  type UpdateCallbacks,
} from './updates.ts';

export function createChildWorkflowOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): ChildWorkflowOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    start: (type, input, options) =>
      startWorkflow(
        getInternals(engine),
        type,
        input,
        options,
        undefined,
        createLifecycleCallbacks(engine),
      ),
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    getHandle: (workflowId) => engine.getHandle(workflowId),
    getComposedWorkflowInterceptor: () => getComposedWorkflowInterceptor(getInternals(engine)),
  };
}

export function createActivityOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): ActivityOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    getComposedActivityInterceptor: () => getComposedActivityInterceptor(getInternals(engine)),
    getComposedWorkflowInterceptor: () => getComposedWorkflowInterceptor(getInternals(engine)),
  };
}

export function createCoordinationOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): CoordinationOperationCallbacks {
  return {
    completeOperation: (workflowId, value) => completeOperationForEngine(engine, workflowId, value),
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    executeSubOperation: (workflowId, operation, signal, speculativeState) =>
      executeSubOperationForEngine(engine, workflowId, operation, signal, speculativeState),
    getActivityOperationCallbacks: () => createActivityOperationCallbacks(engine),
  };
}

export function createDataOperationCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): DataOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
  };
}

export function createStateOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): StateOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    ensureTerminalCleanupTracked: (workflowId) =>
      ensureTerminalCleanupTracked(getInternals(engine), workflowId),
  };
}

export function createStreamOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): StreamOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    handleCleanupError: (source, error, workflowId) =>
      createTerminationCallbacks(engine).handleCleanupError(source, error, workflowId),
  };
}

export function createTimeOperationCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): TimeOperationCallbacks {
  return {
    completeOperation: (workflowId, value) => completeOperationForEngine(engine, workflowId, value),
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    failWorkflow: (workflowId, error) =>
      failWorkflow(getInternals(engine), workflowId, error, createTerminationCallbacks(engine)),
    runSerializedWorkflowStateWrite: (workflowId, writeOperation) =>
      runSerializedWorkflowStateWrite(getInternals(engine), workflowId, writeOperation),
    beginWorkflowExecution: (
      workflowId,
      workflowType,
      input,
      checkpoint,
      executionDeadline,
      executionStateOwnerId,
      registration,
    ) =>
      beginWorkflowExecution(
        getInternals(engine),
        workflowId,
        workflowType,
        input,
        checkpoint,
        executionDeadline,
        executionStateOwnerId,
        registration,
        createLifecycleCallbacks(engine),
      ),
    workflowVersionTupleFromState: (state) =>
      workflowVersionTupleFromState(getInternals(engine), state, createLifecycleCallbacks(engine)),
    setWorkflowStartHeaders: (workflowId, headers) =>
      setWorkflowStartHeaders(
        getInternals(engine),
        workflowId,
        headers,
        createLifecycleCallbacks(engine),
      ),
    loadWorkflowStartHeaders: (workflowId) =>
      loadWorkflowStartHeaders(getInternals(engine), workflowId, createLifecycleCallbacks(engine)),
    parseStartOptionDuration: (value, fieldName) =>
      parseStartOptionDuration(
        getInternals(engine),
        value,
        fieldName,
        createLifecycleCallbacks(engine),
      ),
    runDeferredTerminalCleanup: (workflowId, timerId) =>
      runDeferredTerminalCleanup(
        getInternals(engine),
        workflowId,
        timerId,
        createTerminationCallbacks(engine),
      ),
    handleScheduleTimer: (entry) => handleScheduleTimerForEngine(engine, entry),
    timeout: (workflowId) => engine.timeout(workflowId),
  };
}

export function createUpdateCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): UpdateCallbacks {
  return {
    dispatchEvent: (event) => engine.dispatchEvent(event),
    broadcast: (message) =>
      broadcastFromInternals(getInternals(engine), message, createBroadcastCallbacks(engine)),
    completeOperation: (id, value) => completeOperationForEngine(engine, id, value),
    guardTerminalWorkflow: (id) =>
      guardTerminalWorkflow(getInternals(engine), id, createGuardCallbacks(engine)),
    guardTerminalWorkflowAfterCoordinatedRequest: (id, updateId) =>
      guardTerminalWorkflowAfterCoordinatedRequest(
        getInternals(engine),
        id,
        updateId,
        createGuardCallbacks(engine),
      ),
    persistCoordinatedUpdateResponse: (id, updateName, updateId, idempotencyKey, value) =>
      persistCoordinatedUpdateResponse(engine, id, updateName, updateId, idempotencyKey, value),
    deliverCoordinatedUpdateToWaiterIfAvailable: (id, updateRequest, dispatchReceivedEvent) =>
      deliverCoordinatedUpdateToWaiterIfAvailable(
        getInternals(engine),
        id,
        updateRequest,
        dispatchReceivedEvent,
        createUpdateCallbacks(engine),
      ),
    dispatchPendingUpdateReceived: (id, updateName, updateRequest) =>
      dispatchPendingUpdateReceivedFromBroadcast(
        getInternals(engine),
        id,
        updateName,
        updateRequest,
        createBroadcastCallbacks(engine),
      ),
    createCoordinatedUpdateResponder: (id, updateName, updateRequest) =>
      createCoordinatedUpdateResponder(getInternals(engine), id, updateName, updateRequest, {
        persistCoordinatedUpdateResponse: (workflowId, name, updateId, idempotencyKey, value) =>
          persistCoordinatedUpdateResponse(
            engine,
            workflowId,
            name,
            updateId,
            idempotencyKey,
            value,
          ),
      }),
    findPendingUpdateByName: (id, name) => findPendingUpdateByName(getInternals(engine), id, name),
    schedulePendingInlineUpdateDrain: (workflowId) =>
      schedulePendingInlineUpdateDrain(
        getInternals(engine),
        workflowId,
        createPendingUpdateCallbacks(engine),
      ),
  };
}

async function persistCoordinatedUpdateResponse<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  updateName: string,
  updateId: string,
  idempotencyKey: string | undefined,
  value: unknown,
): Promise<void> {
  const internals = getInternals(engine);
  const responseOperations = internals.updateCoordinator.buildResponseOperations(
    updateId,
    workflowId,
    value,
    undefined,
    idempotencyKey,
  );
  try {
    await internals.storage.batch(responseOperations);
    engine.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, updateName, value));
    broadcastFromInternals(
      internals,
      { type: 'update:completed', workflowId, updateId },
      createBroadcastCallbacks(engine),
    );
  } catch (error: unknown) {
    createTerminationCallbacks(engine).handleCleanupError(
      'writeCoordinatedUpdateResponse',
      error,
      workflowId,
    );
  }
}

export function completeOperationForEngine<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  value: unknown,
): void {
  return completeOperation(getInternals(engine), workflowId, value, callRouterCallbacks(engine));
}

export async function runOperationWithResultForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  operation: OperationWithCallerStack,
  execute: () => Promise<unknown>,
): Promise<void> {
  return runOperationWithResult(
    getInternals(engine),
    workflowId,
    operation,
    execute,
    callRouterCallbacks(engine),
  );
}

export async function runOperationWithoutResultForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  operation: OperationWithCallerStack,
  execute: () => Promise<void>,
): Promise<void> {
  return runOperationWithoutResult(
    getInternals(engine),
    workflowId,
    operation,
    execute,
    callRouterCallbacks(engine),
  );
}

export async function executeSubOperationForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  operation: ContextOperationRequest,
  signal?: AbortSignal,
  speculativeState?: import('./speculative-execution-state.ts').SpeculativeExecutionState,
): Promise<unknown> {
  return executeSubOperation(
    getInternals(engine),
    workflowId,
    operation,
    {
      createActivityOperationCallbacks: () => createActivityOperationCallbacks(engine),
      createChildWorkflowOperationCallbacks: () => createChildWorkflowOperationCallbacks(engine),
      createCoordinationOperationCallbacks: () => createCoordinationOperationCallbacks(engine),
      createStateOperationCallbacks: () => createStateOperationCallbacks(engine),
    },
    signal,
    speculativeState,
  );
}

export async function processReviewOperationForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  options: HumanReviewOptions,
): Promise<void> {
  return processReviewOperation(
    getInternals(engine),
    workflowId,
    options,
    createReviewOperationCallbacks(engine),
  );
}
