import type { ContextOperationRequest } from '../context.ts';
import type { ComposedActivityInterceptor, ComposedWorkflowInterceptor } from '../interceptor.ts';
import type { ActivityContext } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import type { SpeculativeExecutionState } from './speculative-execution-state.ts';
import { callActivityFunction } from './state-utilities.ts';

export type ActivityFunctionWithMetadata = ((...arguments_: unknown[]) => unknown) & {
  verify?: (result: unknown) => Promise<boolean> | boolean;
  compensate?: (input: unknown, output: unknown) => Promise<void> | void;
};

type ActivityOperation = Extract<ContextOperationRequest, { type: 'activity' }>;

export type ActivityOperationCallbacks = {
  runOperationWithResult: (
    workflowId: string,
    operation: ActivityOperation,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  getComposedActivityInterceptor: () => ComposedActivityInterceptor | null;
  getComposedWorkflowInterceptor: () => ComposedWorkflowInterceptor | null;
};

export function getActivityFunctionWithMetadata(
  internals: EngineInternals,
  operation: ActivityOperation,
): ActivityFunctionWithMetadata | undefined {
  if (typeof operation.fn === 'function') {
    return operation.fn as ActivityFunctionWithMetadata;
  }

  const registered = internals.activityRegistry.resolve(operation.activityName);
  if (registered) {
    return registered as ActivityFunctionWithMetadata;
  }

  return undefined;
}

/**
 * Resolve the activity function for a given operation. Checks the activity
 * registry first (required for worker mode where `operation.fn` is undefined),
 * then falls back to `operation.fn` for inline mode.
 */
export function resolveActivityFunction(
  internals: EngineInternals,
  operation: ActivityOperation,
): (...arguments_: unknown[]) => unknown {
  const registered = internals.activityRegistry.resolve(operation.activityName);
  if (registered) return registered;
  if (operation.fn) return operation.fn as (...arguments_: unknown[]) => unknown;
  throw new Error(
    `No activity registered with name "${operation.activityName}". ` +
      'In worker mode, activities must be registered via engine.register(activityDefinition).',
  );
}

export function buildActivityVerification(
  _internals: EngineInternals,
  activityName: string,
  verify: (result: unknown) => Promise<boolean> | boolean,
  result: unknown,
): Promise<void> {
  return (async () => {
    const verified = await verify(result);
    if (!verified) {
      throw new Error(`Verification failed for activity "${activityName}"`);
    }
  })();
}

export function buildActivityCompensation(
  internals: EngineInternals,
  operation: ActivityOperation,
  result: unknown,
): (() => Promise<void>) | undefined {
  const activity = getActivityFunctionWithMetadata(internals, operation);
  if (!activity?.compensate) {
    return undefined;
  }

  return async () => {
    await activity.compensate?.(operation.input, result);
  };
}

export async function invokeWorkerActivity(
  internals: EngineInternals,
  operationId: string,
  activityName: string,
  input: unknown,
): Promise<unknown> {
  const dispatcher = internals.activityWorkerDispatcher;
  if (!dispatcher) {
    throw new Error(`No activity worker dispatcher available for "${activityName}"`);
  }

  const result = await dispatcher.execute({
    operationId,
    activityName,
    input,
    attempt: 1,
  });
  if (result.status === 'failed') {
    throw new Error(result.error);
  }

  return result.value;
}

export function invokeInlineActivity(
  internals: EngineInternals,
  operation: ActivityOperation,
  activityContext: ActivityContext,
  _activityName: string,
  input: unknown,
): unknown {
  const activityFunction = resolveActivityFunction(internals, operation);
  return callActivityFunction(activityFunction, input, activityContext);
}

/**
 * Execute an activity function, dispatching to a Web Worker pool when
 * `activityExecution` is configured, or running inline on the main thread.
 */
export async function executeActivity(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
  callbacks: ActivityOperationCallbacks,
): Promise<unknown> {
  const activityInput = operation.input;

  // Build an ActivityContext so the activity function can send heartbeats.
  const abortController = internals.inlineStrategy?.getAbortController(workflowId);
  const activityContext: ActivityContext = {
    signal: abortController?.signal ?? new AbortController().signal,
    heartbeat: (details?: unknown) => {
      internals.heartbeatDetails.set(workflowId, details);
    },
  };

  // Build the leaf executor: either dispatch to a worker or call inline.
  const invokeActivity: (activityName: string, input: unknown) => unknown =
    internals.activityWorkerDispatcher
      ? (activityName, input) =>
          invokeWorkerActivity(internals, operation.operationId, activityName, input)
      : (activityName, input) =>
          invokeInlineActivity(internals, operation, activityContext, activityName, input);

  // If there are activity interceptors, use cached composition
  const composedActivity = callbacks.getComposedActivityInterceptor();
  if (composedActivity) {
    const activityInterception = {
      workflowId,
      activityName: operation.activityName,
      input: activityInput,
      attempt: 1,
      headers: new Map<string, string>(),
    };

    const result = await composedActivity.execute(activityInterception, async (interception) => {
      return invokeActivity(operation.activityName, interception.input);
    });

    // Capture interceptor headers onto the operation for dispatch
    if (activityInterception.headers.size > 0) {
      (operation as Record<string, unknown>)['headers'] = [
        ...activityInterception.headers.entries(),
      ];
    }

    return result;
  }

  // If there are workflow interceptors with activity hooks, use cached composition
  const composedWorkflow = callbacks.getComposedWorkflowInterceptor();
  if (composedWorkflow) {
    const interception = {
      workflowId,
      activityName: operation.activityName,
      input: activityInput,
      attempt: 1,
      headers: new Map<string, string>(),
    };

    function* execute(): Generator<unknown, unknown, unknown> {
      const result = invokeActivity(operation.activityName, interception.input);
      yield result;
      return result;
    }

    const generator = composedWorkflow.activity(interception, execute);
    let current: IteratorResult<unknown, unknown> = generator.next();
    while (!current.done) {
      current = generator.next(current.value);
    }

    // Capture interceptor headers onto the operation for dispatch
    if (interception.headers.size > 0) {
      (operation as Record<string, unknown>)['headers'] = [...interception.headers.entries()];
    }

    return current.value;
  }

  return invokeActivity(operation.activityName, activityInput);
}

export async function executeActivityOperationResult(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
  callbacks: ActivityOperationCallbacks,
  speculativeState?: SpeculativeExecutionState,
): Promise<unknown> {
  const result = await executeActivity(internals, workflowId, operation, callbacks);

  const compensation = speculativeState
    ? buildActivityCompensation(internals, operation, result)
    : undefined;
  if (compensation) {
    speculativeState?.recordCompensation(compensation);
  }

  const activity = getActivityFunctionWithMetadata(internals, operation);
  if (activity?.verify) {
    const verification = buildActivityVerification(
      internals,
      operation.activityName,
      activity.verify,
      result,
    );
    if (speculativeState) {
      speculativeState.recordVerification(verification);
    } else {
      await verification;
    }
  }

  return result;
}

export async function processActivityOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
  callbacks: ActivityOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, () =>
    executeActivityOperationResult(internals, workflowId, operation, callbacks),
  );
}
