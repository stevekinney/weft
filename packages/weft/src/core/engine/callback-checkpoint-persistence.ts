import type { ContextOperationRequest } from '../context.ts';
import { HISTORY_CIRCUIT_BREAKER_REASON } from '../types.ts';
import { validateAttributeValueSizes } from './attributes-tags.ts';
import { createTerminationCallbacks } from './callback-creators-core.ts';
import {
  appendTimelineBatchOperations,
  persistCheckpoint,
  pruneCheckpointHistory,
  type PersistCheckpointCallbacks,
} from './checkpoint-io.ts';
import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { swallowPromiseRejection } from './strategy-helpers.ts';
import { terminateWorkflow } from './termination.ts';

export function createCheckpointPersistenceCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): PersistCheckpointCallbacks {
  return {
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
  };
}

export function persistCheckpointForDataOperation<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  operation: ContextOperationRequest,
): Promise<void> {
  return persistCheckpoint(
    getInternals(engine),
    workflowId,
    operation,
    undefined,
    createCheckpointPersistenceCallbacks(engine),
    { timeline: 'preserve-pending' },
  );
}
