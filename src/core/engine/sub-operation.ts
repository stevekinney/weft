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
import {
  executeSleepSubOperation,
  executeWaitSignalSubOperation,
} from './coordination-branch-executors.ts';
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
  sleep: (context, operation) =>
    executeSleepSubOperation(context.internals, operation, context.signal),
  'wait-signal': (context, operation) =>
    executeWaitSignalSubOperation(context.internals, context.workflowId, operation, context.signal),
  'wait-condition': () => {
    // `ctx.waitUntil` cannot be a `ctx.race` / `ctx.all` / `ctx.speculate` branch
    // in v1: a condition wait holds its predicate closure and re-evaluates
    // in-process, and there is no abortable sub-operation executor for it yet.
    // Every coordinator (race/all/speculate/run-all) routes sub-operations
    // through this same map, so this one throw covers all of them. Throw a clear,
    // actionable error rather than letting it fall through to the generic
    // "Unsupported sub-operation type" path.
    throw new Error(
      'ctx.waitUntil() cannot be used as a ctx.race() / ctx.all() / ctx.speculate() branch. ' +
        'Use `yield* ctx.waitUntil(...)` directly, or gate it behind a signal/update the coordinator resolves.',
    );
  },
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

  // A nested `ctx.all` keeps `Promise.all`'s reject-fast result semantics (the
  // outer coordinator owns durability and partial-result preservation), but it
  // must NOT leave abortable siblings — a sleep or wait-signal branch — parked
  // when one branch rejects. Without an AbortController, a rejecting sibling
  // would leave a parked wait-signal waiter registered until engine disposal.
  // A dedicated controller, aborted as soon as the all settles (reject OR
  // resolve), releases those waiters. The parent `signal` is chained into it so
  // a grandparent abort (e.g. this nested all losing an outer race) still
  // propagates down to the branches. Activity branches ignore the signal and run
  // to completion either way, so this changes nothing for activity-only alls.
  const controller = new AbortController();
  const abortNestedAll = () => {
    controller.abort(signal?.reason);
  };
  signal?.addEventListener('abort', abortNestedAll, { once: true });

  const subOperationPromises = operation.operations.map((subOperation) =>
    executeSubOperation(
      internals,
      workflowId,
      subOperation,
      callbacks,
      controller.signal,
      speculativeState,
    ),
  );
  // Swallow sibling rejections that surface only after the controller fires in
  // the finally block (typically AbortError on the abandoned branches). Without
  // this, aborting losers would produce unhandled promise rejections, since
  // `Promise.all` already rejected with the FIRST error and nothing else awaits
  // those promises.
  void Promise.allSettled(subOperationPromises);
  try {
    return await Promise.all(subOperationPromises);
  } finally {
    signal?.removeEventListener('abort', abortNestedAll);
    controller.abort();
  }
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
