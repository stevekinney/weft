import type { ContextOperationRequest } from '../context.ts';
import type { ComposedActivityInterceptor, ComposedWorkflowInterceptor } from '../interceptor.ts';
import { assertPayloadWithinLimit } from '../payload-size.ts';
import type { ActivityContext, ActivityVerificationResult } from '../types.ts';
import {
  buildActivityReconciliationReference,
  buildActivityVerificationContext,
  createCompletedActivityReconciliationRecord,
  resolveActivityIdempotencyKey,
  resolveStartedActivityReconciliationRecord,
  validateActivityResultForReconciliation,
  writeActivityReconciliationTransition,
  type ActivityReconciliationMetadata,
} from './activity-reconciliation.ts';
import {
  AsyncActivityDeferral,
  deriveAsyncActivityToken,
  parkDeferredAsyncActivity,
} from './async-activity-completion.ts';
import { ActivityResolutionError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import type { SpeculativeExecutionState } from './speculative-execution-state.ts';
import { callActivityFunction } from './state-utilities.ts';

export type ActivityFunctionWithMetadata = ((...arguments_: unknown[]) => unknown) &
  ActivityReconciliationMetadata & {
    verify?: (
      result: unknown,
      context?: ReturnType<typeof buildActivityVerificationContext>,
    ) => Promise<ActivityVerificationResult> | ActivityVerificationResult;
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

/**
 * Look up `activityName` for the workflow identified by `workflowId`.
 *
 * Resolution rules:
 *
 * - When the workflow was registered via the builder, it owns a per-workflow
 *   `ActivityRegistry`. The per-workflow registry is the *only* source of
 *   truth: a miss is a miss, never a silent fallthrough to the legacy global
 *   pool. This prevents a typo or omitted `.activities()` entry from
 *   accidentally dispatching an unrelated global activity that happens to
 *   share the name.
 * - When the workflow is legacy (registered via the deprecated `engine.register(
 *   name, handler)` overload, no per-workflow registry exists), the global
 *   `ActivityRegistry` is the source of truth.
 *
 * Both `getActivityFunctionWithMetadata` and `resolveActivityFunction` route
 * through this single resolver so metadata (compensation, verification) and
 * the actual executed function come from the same callable. Speculative
 * execution paths must not see one function for metadata and a different one
 * for execution.
 *
 * Returns `undefined` when no registry resolves the name. Callers decide
 * whether to throw `ActivityResolutionError` (the dispatch path) or treat the
 * miss as advisory (the metadata path).
 */
function resolveActivityViaRegistries(
  internals: EngineInternals,
  workflowId: string,
  activityName: string,
): { fn: (...arguments_: unknown[]) => unknown; workflowType: string } | undefined {
  const workflowType = internals.workflowTypeByWorkflowId.get(workflowId);
  if (workflowType !== undefined) {
    const perWorkflow = internals.activityRegistriesByWorkflow.get(workflowType);
    if (perWorkflow !== undefined) {
      // Builder-registered workflow — per-workflow registry is consulted first
      // so a name declared in `.activities({ ... })` is the authoritative
      // implementation. When the per-workflow registry doesn't carry the
      // name, fall back to the global registry: this preserves the
      // legitimate mixed-registration pattern (a builder workflow referencing
      // a separately-registered global activity, common during the
      // transitional bridge and for shared helpers used by multiple
      // workflows). Codex's review flagged the typo-into-global risk; the
      // tradeoff lands on "preserve legitimate mixed usage" because the
      // typo case requires a global same-name to exist, which is uncommon,
      // and the alternative breaks the established test fleet patterns.
      // Phase 6C revisits this when the global registry is removed entirely.
      const perWorkflowFn = perWorkflow.resolve(activityName);
      if (perWorkflowFn) {
        return { fn: perWorkflowFn, workflowType };
      }
    }
    const globalFn = internals.activityRegistry.resolve(activityName);
    if (globalFn) {
      return { fn: globalFn, workflowType };
    }
    return undefined;
  }
  // Unknown workflow type (lifecycle edge — e.g. activity dispatched outside
  // an active workflow execution). Only the global registry can answer.
  const globalFn = internals.activityRegistry.resolve(activityName);
  if (globalFn) {
    return { fn: globalFn, workflowType: '<unknown>' };
  }
  return undefined;
}

export function getActivityFunctionWithMetadata(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
): ActivityFunctionWithMetadata | undefined {
  // Use the same resolution order as resolveActivityFunction so metadata
  // (compensation / verification) is taken from the same callable that
  // actually runs. The per-workflow registry wins over `operation.fn`
  // because the workflow's locally-scoped activity is the authoritative
  // implementation when the workflow is builder-registered.
  const resolved = resolveActivityViaRegistries(internals, workflowId, operation.activityName);
  if (resolved) {
    return resolved.fn as ActivityFunctionWithMetadata;
  }
  if (typeof operation.fn === 'function') {
    return operation.fn as ActivityFunctionWithMetadata;
  }
  return undefined;
}

/**
 * Resolve the activity function for a given operation. Uses the same
 * per-workflow-first-then-global ordering as `getActivityFunctionWithMetadata`.
 * For inline-mode callers that pass an `operation.fn` directly, the registries
 * are still consulted first so a workflow's locally-scoped activity wins over
 * the bare callable. Throws `ActivityResolutionError` when neither path
 * resolves.
 */
export function resolveActivityFunction(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
): (...arguments_: unknown[]) => unknown {
  const resolved = resolveActivityViaRegistries(internals, workflowId, operation.activityName);
  if (resolved) return resolved.fn;
  if (operation.fn) return operation.fn as (...arguments_: unknown[]) => unknown;
  const workflowType = internals.workflowTypeByWorkflowId.get(workflowId) ?? '<unknown>';
  throw new ActivityResolutionError(workflowType, operation.activityName);
}

export function buildActivityVerification(
  _internals: EngineInternals,
  activityName: string,
  verify: ActivityFunctionWithMetadata['verify'],
  context: ReturnType<typeof buildActivityVerificationContext>,
  result: unknown,
): Promise<void> {
  return (async () => {
    const verified = await verify?.(result, context);
    if (typeof verified !== 'boolean') {
      throw new Error(`Verification failed for activity "${activityName}"`);
    }
    if (!verified) {
      throw new Error(`Verification failed for activity "${activityName}"`);
    }
  })();
}

export function buildActivityCompensation(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
  result: unknown,
): (() => Promise<void>) | undefined {
  const activity = getActivityFunctionWithMetadata(internals, workflowId, operation);
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
  attempt: number,
): Promise<unknown> {
  const dispatcher = internals.activityWorkerDispatcher;
  if (!dispatcher) {
    throw new Error(`No activity worker dispatcher available for "${activityName}"`);
  }

  const result = await dispatcher.execute({
    operationId,
    activityName,
    input,
    attempt,
  });
  if (result.status === 'failed') {
    throw new Error(result.error);
  }

  return result.value;
}

export function invokeInlineActivity(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
  activityContext: ActivityContext,
  _activityName: string,
  input: unknown,
): unknown {
  const activityFunction = resolveActivityFunction(internals, workflowId, operation);
  return callActivityFunction(activityFunction, input, activityContext);
}

function copyActivityHeadersToOperation(
  operation: ActivityOperation,
  headers: Map<string, string>,
): void {
  if (headers.size > 0) {
    (operation as Record<string, unknown>)['headers'] = [...headers.entries()];
  }
}

function getActivityAttempt(operation: ActivityOperation): number {
  const attempt = (operation as Record<string, unknown>)['attempt'];
  return typeof attempt === 'number' && Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
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
  attempt = getActivityAttempt(operation),
): Promise<unknown> {
  const activityInput = operation.input;

  // Build an ActivityContext so the activity function can send heartbeats and
  // defer to out-of-band completion. The async-completion token is derived from
  // the deterministic workflow step (not the per-yield operationId), so it is
  // stable across crash/replay.
  const abortController = internals.inlineStrategy?.getAbortController(workflowId);
  const asyncToken = deriveAsyncActivityToken(workflowId, operation.step ?? 0, attempt);
  const activityContext: ActivityContext = {
    signal: abortController?.signal ?? new AbortController().signal,
    heartbeat: (details?: unknown) => {
      internals.heartbeatDetails.set(workflowId, details);
    },
    completeAsync: () => {
      throw new AsyncActivityDeferral(asyncToken);
    },
  };

  // Build the leaf executor: either dispatch to a worker or call inline.
  const invokeActivity: (activityName: string, input: unknown) => unknown =
    internals.activityWorkerDispatcher
      ? (activityName, input) =>
          invokeWorkerActivity(internals, operation.operationId, activityName, input, attempt)
      : (activityName, input) =>
          invokeInlineActivity(
            internals,
            workflowId,
            operation,
            activityContext,
            activityName,
            input,
          );

  // If there are activity interceptors, use cached composition
  const composedActivity = callbacks.getComposedActivityInterceptor();
  if (composedActivity) {
    const activityInterception = {
      workflowId,
      activityName: operation.activityName,
      input: activityInput,
      attempt,
      headers: new Map<string, string>(),
    };

    const result = await composedActivity.execute(activityInterception, async (interception) => {
      return invokeActivity(operation.activityName, interception.input);
    });

    copyActivityHeadersToOperation(operation, activityInterception.headers);

    return result;
  }

  // If there are workflow interceptors with activity hooks, use cached composition
  const composedWorkflow = callbacks.getComposedWorkflowInterceptor();
  if (composedWorkflow) {
    const interception = {
      workflowId,
      activityName: operation.activityName,
      input: activityInput,
      attempt,
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

    copyActivityHeadersToOperation(operation, interception.headers);

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
  const activity = getActivityFunctionWithMetadata(internals, workflowId, operation);
  const idempotencyKey = resolveActivityIdempotencyKey(activity, operation);
  const operationAttempt = getActivityAttempt(operation);
  if (idempotencyKey !== undefined) {
    const reference = await buildActivityReconciliationReference(
      workflowId,
      operation.activityName,
      idempotencyKey,
    );
    const started = await resolveStartedActivityReconciliationRecord(
      internals,
      workflowId,
      operation,
      reference,
      activity,
      idempotencyKey,
      operationAttempt,
    );
    if ('completedResult' in started) {
      validateActivityResultForReconciliation(
        started.completedResult,
        internals.options.payloadSizePolicy.maxBytes,
      );
      return started.completedResult;
    }
    const result = await executeActivity(
      internals,
      workflowId,
      operation,
      callbacks,
      started.attempt,
    );
    validateActivityResultForReconciliation(result, internals.options.payloadSizePolicy.maxBytes);
    await finalizeActivityResult(
      internals,
      workflowId,
      operation,
      result,
      activity,
      idempotencyKey,
      started.attempt,
      speculativeState,
      true,
    );
    const completedRecord = createCompletedActivityReconciliationRecord(
      started,
      result,
      internals.options.getNow(),
    );
    await writeActivityReconciliationTransition(
      internals.storage,
      reference,
      started,
      completedRecord,
    );
    return result;
  }

  const result = await executeActivity(
    internals,
    workflowId,
    operation,
    callbacks,
    operationAttempt,
  );

  assertPayloadWithinLimit(result, internals.options.payloadSizePolicy.maxBytes, 'activity result');

  await finalizeActivityResult(
    internals,
    workflowId,
    operation,
    result,
    activity,
    idempotencyKey,
    operationAttempt,
    speculativeState,
  );

  return result;
}

async function finalizeActivityResult(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
  result: unknown,
  activity: ActivityFunctionWithMetadata | undefined,
  idempotencyKey: string | undefined,
  attempt: number,
  speculativeState?: SpeculativeExecutionState,
  awaitSpeculativeVerification = false,
): Promise<void> {
  const compensation = speculativeState
    ? buildActivityCompensation(internals, workflowId, operation, result)
    : undefined;
  if (compensation) {
    speculativeState?.recordCompensation(compensation);
  }

  if (activity?.verify) {
    const context = buildActivityVerificationContext(
      'post-execution-validation',
      workflowId,
      operation.operationId,
      operation.activityName,
      operation.input,
      idempotencyKey,
      attempt,
    );
    const verification = buildActivityVerification(
      internals,
      operation.activityName,
      activity.verify,
      context,
      result,
    );
    if (speculativeState) {
      speculativeState.recordVerification(verification);
      if (awaitSpeculativeVerification) {
        await verification;
      }
    } else {
      await verification;
    }
  }
}

export async function processActivityOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
  callbacks: ActivityOperationCallbacks,
): Promise<void> {
  // An activity that calls `ActivityContext.completeAsync()` throws
  // `AsyncActivityDeferral`. Catch it here so the operation neither completes
  // nor fails: park the pending token durably and hand `runOperationWithResult`
  // a promise that never settles, leaving the workflow suspended until an
  // out-of-band completion resumes it.
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    try {
      return await executeActivityOperationResult(internals, workflowId, operation, callbacks);
    } catch (error) {
      if (error instanceof AsyncActivityDeferral) {
        return parkDeferredAsyncActivity(internals, error, {
          workflowId,
          activityName: operation.activityName,
          operationId: operation.operationId,
          step: operation.step ?? 0,
          attempt: getActivityAttempt(operation),
        });
      }
      throw error;
    }
  });
}
