import type { ContextOperationRequest } from '../context.ts';
import { HISTORY_CIRCUIT_BREAKER_REASON } from '../types.ts';
import { validateAttributeValueSizes } from './attributes-tags.ts';
import { createTerminationCallbacks } from './callback-creators-core.ts';
import { persistCheckpointAbandoningOnConflict } from './checkpoint-conflict-abandon.ts';
import {
  appendTimelineBatchOperations,
  persistCheckpoint,
  pruneCheckpointHistory,
  type MidOperationCommitReport,
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
    appendTimelineBatchOperations: (
      id,
      checkpointOperation,
      step,
      stepIndex,
      timestamp,
      operations,
    ) =>
      appendTimelineBatchOperations(
        getInternals(engine),
        id,
        checkpointOperation,
        step,
        stepIndex,
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
    enforceHistoryCircuitBreaker: async (id) => {
      await terminateWorkflow(
        getInternals(engine),
        id,
        'timed-out',
        createTerminationCallbacks(engine),
        HISTORY_CIRCUIT_BREAKER_REASON,
      );
    },
  };
}

/**
 * Commit a checkpoint for an operation that is still running, keeping its pending timeline entry:
 * a memo's durable retry sleep, or a `ctx.all` branch that settled before its siblings.
 */
export function persistCheckpointForDataOperation<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  operation: ContextOperationRequest,
  report: MidOperationCommitReport = {},
): Promise<void> {
  const internals = getInternals(engine);
  return persistCheckpointAbandoningOnConflict(internals, workflowId, () =>
    persistCheckpoint(
      internals,
      workflowId,
      operation,
      undefined,
      createCheckpointPersistenceCallbacks(engine),
      { timeline: 'preserve-pending', ...report },
    ),
  );
}
