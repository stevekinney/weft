import {
  atomicStateDataKey,
  commitAtomicStateDelete,
  commitAtomicStateValue,
  readAtomicStateSnapshot,
} from '../atomic-state.ts';
import type { ContextOperationRequest } from '../context.ts';
import type { HumanReviewOptions } from '../review/index.ts';
import {
  assertChildWorkflowNestingDepth,
  executeChildWorkflow,
  type ChildWorkflowOperationCallbacks,
} from './child-workflow.ts';
import type { EngineInternals } from './internals.ts';
import {
  executeActivityOperationResult,
  type ActivityOperationCallbacks,
} from './operations-activity.ts';
import {
  executeRunAllOperationResult,
  type CoordinationOperationCallbacks,
} from './operations-coordination.ts';
import type { OperationWithCallerStack } from './operations-router.ts';
import type { StateOperationCallbacks } from './operations-state.ts';
import type { SpeculativeExecutionState } from './speculative-execution-state.ts';
import { callMemoFunction } from './state-utilities.ts';

type SubOperationCallbacks = {
  createActivityOperationCallbacks: () => ActivityOperationCallbacks;
  createChildWorkflowOperationCallbacks: () => ChildWorkflowOperationCallbacks;
  createCoordinationOperationCallbacks: () => CoordinationOperationCallbacks;
  createStateOperationCallbacks: () => StateOperationCallbacks;
};

type WaitReviewOperationCallbacks = {
  runOperationWithoutResult: (
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<void>,
  ) => Promise<void>;
  processReviewOperation: (workflowId: string, options: HumanReviewOptions) => Promise<void>;
};

export async function processWaitReviewOperation(
  _internals: EngineInternals,
  workflowId: string,
  operation: Extract<ContextOperationRequest, { type: 'wait-review' }>,
  callbacks: WaitReviewOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithoutResult(workflowId, operation, () =>
    callbacks.processReviewOperation(workflowId, operation.reviewOptions),
  );
}

export async function executeSubOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  callbacks: SubOperationCallbacks,
  signal?: AbortSignal,
  speculativeState?: SpeculativeExecutionState,
): Promise<unknown> {
  signal?.throwIfAborted();
  const executor = subOperationExecutors[operation.type];
  if (!executor) {
    throw new Error(`Unsupported sub-operation type: ${operation.type}`);
  }

  return executor(
    {
      internals,
      workflowId,
      callbacks,
      signal,
      speculativeState,
    },
    operation as never,
  );
}

type SubOperationExecutionContext = {
  internals: EngineInternals;
  workflowId: string;
  callbacks: SubOperationCallbacks;
  signal: AbortSignal | undefined;
  speculativeState: SpeculativeExecutionState | undefined;
};

type SubOperationExecutorMap = {
  [Type in ContextOperationRequest['type']]?: (
    context: SubOperationExecutionContext,
    operation: Extract<ContextOperationRequest, { type: Type }>,
  ) => Promise<unknown>;
};

const subOperationExecutors: SubOperationExecutorMap = {
  activity: (context, operation) =>
    executeActivitySubOperation(
      context.internals,
      context.workflowId,
      operation,
      context.callbacks,
      context.speculativeState,
    ),
  'child-workflow': (context, operation) =>
    executeChildWorkflowSubOperation(
      context.internals,
      context.workflowId,
      operation,
      context.callbacks,
    ),
  memo: (_context, operation) => Promise.resolve(callMemoFunction(operation.fn)),
  'state-read': (context, operation) => executeStateReadSubOperation(context.internals, operation),
  'state-commit': (context, operation) =>
    executeStateCommitSubOperation(context.internals, operation, context.callbacks),
  parallel: (context, operation) =>
    executeParallelSubOperation(
      context.internals,
      context.workflowId,
      operation,
      context.callbacks,
      context.signal,
      context.speculativeState,
    ),
  race: (context, operation) =>
    executeRaceSubOperation(
      context.internals,
      context.workflowId,
      operation,
      context.callbacks,
      context.signal,
      context.speculativeState,
    ),
  'run-all': (context, operation) =>
    executeRunAllOperationResult(
      context.internals,
      context.workflowId,
      operation,
      context.callbacks.createCoordinationOperationCallbacks(),
      context.speculativeState,
    ),
};

async function executeActivitySubOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  callbacks: SubOperationCallbacks,
  speculativeState?: SpeculativeExecutionState,
): Promise<unknown> {
  return executeActivityOperationResult(
    internals,
    workflowId,
    operation,
    callbacks.createActivityOperationCallbacks(),
    speculativeState,
  );
}

async function executeChildWorkflowSubOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: Extract<ContextOperationRequest, { type: 'child-workflow' }>,
  callbacks: SubOperationCallbacks,
): Promise<unknown> {
  return executeChildWorkflow(
    internals,
    workflowId,
    operation,
    assertChildWorkflowNestingDepth(internals, workflowId),
    callbacks.createChildWorkflowOperationCallbacks(),
  );
}

async function executeStateReadSubOperation(
  internals: EngineInternals,
  operation: Extract<ContextOperationRequest, { type: 'state-read' }>,
): Promise<unknown> {
  return readAtomicStateSnapshot(
    internals.storage,
    atomicStateDataKey(operation.scope, operation.key),
    operation,
  );
}

async function executeStateCommitSubOperation(
  internals: EngineInternals,
  operation: Extract<ContextOperationRequest, { type: 'state-commit' }>,
  callbacks: SubOperationCallbacks,
): Promise<unknown> {
  const dataKey = atomicStateDataKey(operation.scope, operation.key);
  const result =
    operation.mode === 'delete'
      ? await commitAtomicStateDelete(internals.storage, dataKey, operation.expectedVersion)
      : await commitAtomicStateValue(
          internals.storage,
          dataKey,
          operation.expectedVersion,
          operation.value,
        );
  if (result.applied && operation.scope.type === 'execution') {
    await callbacks
      .createStateOperationCallbacks()
      .ensureTerminalCleanupTracked(operation.scope.ownerWorkflowId);
  }
  return result;
}

async function executeParallelSubOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: Extract<ContextOperationRequest, { type: 'parallel' }>,
  callbacks: SubOperationCallbacks,
  signal?: AbortSignal,
  speculativeState?: SpeculativeExecutionState,
): Promise<unknown> {
  signal?.throwIfAborted();

  const subOperationPromises = operation.operations.map((subOperation) =>
    executeSubOperation(internals, workflowId, subOperation, callbacks, signal, speculativeState),
  );
  return Promise.all(subOperationPromises);
}

async function executeRaceSubOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: Extract<ContextOperationRequest, { type: 'race' }>,
  callbacks: SubOperationCallbacks,
  signal?: AbortSignal,
  speculativeState?: SpeculativeExecutionState,
): Promise<unknown> {
  signal?.throwIfAborted();

  const controller = new AbortController();
  const abortNestedRace = () => {
    controller.abort(signal?.reason);
  };
  signal?.addEventListener('abort', abortNestedRace, { once: true });
  const subOperations = operation.operations.map((subOperation) =>
    executeSubOperation(
      internals,
      workflowId,
      subOperation,
      callbacks,
      controller.signal,
      speculativeState,
    ),
  );
  void Promise.allSettled(subOperations);
  try {
    return await Promise.race(subOperations);
  } finally {
    signal?.removeEventListener('abort', abortNestedRace);
    controller.abort();
  }
}
