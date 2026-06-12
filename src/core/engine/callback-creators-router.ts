import {
  createActivityOperationCallbacks,
  createChildWorkflowOperationCallbacks,
  createConditionOperationCallbacks,
  createCoordinationOperationCallbacks,
  createDataOperationCallbacks,
  createStateOperationCallbacks,
  createStreamOperationCallbacks,
  createTimeOperationCallbacks,
  createUpdateCallbacks,
  executeSubOperationForEngine,
  processReviewOperationForEngine,
  runOperationWithResultForEngine,
  runOperationWithoutResultForEngine,
} from './callback-creators-bundles.ts';
import { registerOperationRouterCallbacksFactory } from './callback-creators-router-registry.ts';
import { processChildWorkflowOperation } from './child-workflow.ts';
import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { processActivityOperation } from './operations-activity.ts';
import {
  processParallelOperation,
  processRaceOperation,
  processRunAllOperation,
  processWaitSignalOperation,
} from './operations-coordination.ts';
import {
  processArchiveOperation,
  processLoadOperation,
  processMemoOperation,
  processOffloadOperation,
} from './operations-data.ts';
import { type OperationRouterCallbacks } from './operations-router.ts';
import { processSpeculateOperation } from './operations-speculate.ts';
import { processStateCommitOperation, processStateReadOperation } from './operations-state.ts';
import { processStreamOperation } from './operations-stream.ts';
import { processSleepOperation } from './operations-time.ts';
import { processWaitConditionOperation } from './operations-wait-condition.ts';
import { feedOperationResult } from './strategy-helpers.ts';
import { processWaitReviewOperation } from './sub-operation.ts';
import { finalizePendingTimelineEntry } from './termination.ts';
import { processWaitUpdateOperation } from './updates.ts';

export function createOperationRouterCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): OperationRouterCallbacks {
  return {
    processActivityOperation: (workflowId, operation) =>
      processActivityOperation(
        getInternals(engine),
        workflowId,
        operation,
        createActivityOperationCallbacks(engine),
      ),
    processSleepOperation: (workflowId, operation) =>
      processSleepOperation(
        getInternals(engine),
        workflowId,
        operation,
        createTimeOperationCallbacks(engine),
      ),
    processWaitSignalOperation: (workflowId, operation) =>
      processWaitSignalOperation(
        getInternals(engine),
        workflowId,
        operation,
        createCoordinationOperationCallbacks(engine),
      ),
    processWaitUpdateOperation: (workflowId, operation) =>
      processWaitUpdateOperation(
        getInternals(engine),
        workflowId,
        operation,
        createUpdateCallbacks(engine),
      ),
    processWaitConditionOperation: (workflowId, operation) =>
      processWaitConditionOperation(
        getInternals(engine),
        workflowId,
        operation,
        createConditionOperationCallbacks(engine),
      ),
    processParallelOperation: (workflowId, operation) =>
      processParallelOperation(
        getInternals(engine),
        workflowId,
        operation,
        createCoordinationOperationCallbacks(engine),
      ),
    processRaceOperation: (workflowId, operation) =>
      processRaceOperation(
        getInternals(engine),
        workflowId,
        operation,
        createCoordinationOperationCallbacks(engine),
      ),
    processMemoOperation: (workflowId, operation) =>
      processMemoOperation(
        getInternals(engine),
        workflowId,
        operation,
        createDataOperationCallbacks(engine),
      ),
    processChildWorkflowOperation: (workflowId, operation) =>
      processChildWorkflowOperation(
        getInternals(engine),
        workflowId,
        operation,
        createChildWorkflowOperationCallbacks(engine),
      ),
    processOffloadOperation: (workflowId, operation) =>
      processOffloadOperation(
        getInternals(engine),
        workflowId,
        operation,
        createDataOperationCallbacks(engine),
      ),
    processLoadOperation: (workflowId, operation) =>
      processLoadOperation(
        getInternals(engine),
        workflowId,
        operation,
        createDataOperationCallbacks(engine),
      ),
    processArchiveOperation: (workflowId, operation) =>
      processArchiveOperation(
        getInternals(engine),
        workflowId,
        operation,
        createDataOperationCallbacks(engine),
      ),
    processStateReadOperation: (workflowId, operation) =>
      processStateReadOperation(
        getInternals(engine),
        workflowId,
        operation,
        createStateOperationCallbacks(engine),
      ),
    processStateCommitOperation: (workflowId, operation) =>
      processStateCommitOperation(
        getInternals(engine),
        workflowId,
        operation,
        createStateOperationCallbacks(engine),
      ),
    processRunAllOperation: (workflowId, operation) =>
      processRunAllOperation(
        getInternals(engine),
        workflowId,
        operation,
        createCoordinationOperationCallbacks(engine),
      ),
    processSpeculateOperation: (workflowId, operation) =>
      processSpeculateOperation(getInternals(engine), workflowId, operation, {
        runOperationWithResult: (id, subOperation, execute) =>
          runOperationWithResultForEngine(engine, id, subOperation, execute),
        executeSubOperation: (id, subOperation, signal, speculativeState) =>
          executeSubOperationForEngine(engine, id, subOperation, signal, speculativeState),
      }),
    processStreamOperation: (workflowId, operation) =>
      processStreamOperation(
        getInternals(engine),
        workflowId,
        operation,
        createStreamOperationCallbacks(engine),
      ),
    processWaitReviewOperation: (workflowId, operation) =>
      processWaitReviewOperation(getInternals(engine), workflowId, operation, {
        runOperationWithoutResult: (id, subOperation, execute) =>
          runOperationWithoutResultForEngine(engine, id, subOperation, execute),
        processReviewOperation: (id, options) =>
          processReviewOperationForEngine(engine, id, options),
      }),
    finalizePendingTimelineEntry: (workflowId, status, value) =>
      finalizePendingTimelineEntry(getInternals(engine), workflowId, status, value),
    feedOperationResult: (workflowId, result, error) =>
      feedOperationResult(getInternals(engine), workflowId, result, error),
  };
}

// Register the router factory so the bundles module can reach the router
// lazily without a static import edge back to this file.
registerOperationRouterCallbacksFactory(
  <TW extends object, TA extends object>(engine: Engine<TW, TA>) =>
    createOperationRouterCallbacks(engine),
);
