import type { ContextOperationRequest } from '../context.ts';
import type { ComposedActivityInterceptor, ComposedWorkflowInterceptor } from '../interceptor.ts';
import { assertPayloadWithinLimit } from '../payload-size.ts';
import type { ActivityContext, ActivityVerificationResult, OperationOutcome } from '../types.ts';
import {
  buildActivityContext,
  clearLastHeartbeatForStep,
  warnIfRetryMissingHeartbeat,
  type ActivityHeartbeatKey,
} from './activity-heartbeat-tracking.ts';
import { resolvePerAttemptTimeout, withPerAttemptTimeout } from './activity-per-attempt-timeout.ts';
import {
  buildActivityReconciliationReference,
  buildActivityVerificationContext,
  commitActivityReconciliationTransitionWithFencedWrite,
  createCompletedActivityReconciliationRecord,
  resolveActivityIdempotencyKey,
  resolveStartedActivityReconciliationRecord,
  stageActivityReconciliationTransitionWithAtomicWorkflowCommit,
  validateActivityResultForReconciliation,
  type ActivityReconciliationMetadata,
} from './activity-reconciliation.ts';
import { getActivityFunctionWithMetadata, resolveActivityFunction } from './activity-resolution.ts';
import {
  AsyncActivityDeferral,
  deriveAsyncActivityToken,
  driveWorkflowInterceptorGenerator,
  parkDeferredAsyncActivity,
} from './async-activity-completion.ts';
import type { EngineInternals } from './internals.ts';
import type { SpeculativeExecutionState } from './speculative-execution-state.ts';
import { callActivityFunction } from './state-utilities.ts';
import type { CapturedRejectionReason } from './strategy-helpers.ts';

export type ActivityFunctionWithMetadata = ((...arguments_: unknown[]) => unknown) &
  ActivityReconciliationMetadata & {
    verify?: (
      result: unknown,
      context?: ReturnType<typeof buildActivityVerificationContext>,
    ) => Promise<ActivityVerificationResult> | ActivityVerificationResult;
    compensate?: (input: unknown, output: unknown) => Promise<void> | void;
  };

type ActivityOperation = Extract<ContextOperationRequest, { type: 'activity' }>;

export interface ActivityExecutionOptions {
  reconciliationCompletion?: 'stage-with-workflow-commit' | 'immediate-fenced';
  beforeImmediateReconciliationCommit?: () => void | (() => void);
}

export type ActivityOperationCallbacks = {
  runOperationWithResult: (
    workflowId: string,
    operation: ActivityOperation,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  finalizePendingTimelineEntry: (
    workflowId: string,
    status: 'completed' | 'failed',
    value: unknown,
  ) => void;
  feedOperationResult: (
    workflowId: string,
    outcome: OperationOutcome,
    originalReason?: CapturedRejectionReason,
  ) => void;
  getComposedActivityInterceptor: () => ComposedActivityInterceptor | null;
  getComposedWorkflowInterceptor: () => ComposedWorkflowInterceptor | null;
};

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
    const error = new Error(result.error);
    if (result.errorName !== undefined) {
      error.name = result.errorName;
    }
    throw error;
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

function getActivityStateKey(operation: ActivityOperation): ActivityHeartbeatKey {
  return operation.activityStateKey ?? operation.step ?? 0;
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
  coordinatorSignal?: AbortSignal,
): Promise<unknown> {
  const activityInput = operation.input;

  // Build an ActivityContext so the activity function can send heartbeats and
  // defer to out-of-band completion. The async-completion token is derived from
  // the deterministic activity state key (not the per-yield operationId), so it
  // is stable across crash/replay. Plain ctx.run uses the workflow step; helper
  // activities owned by ctx.memo carry their own sub-operation key.
  const activityStateKey = getActivityStateKey(operation);
  // #493: surface the resumable-batch footgun in development — a retry that
  // starts with no in-memory heartbeat (e.g. after a process restart).
  warnIfRetryMissingHeartbeat(internals, workflowId, activityStateKey, attempt);
  const asyncToken = deriveAsyncActivityToken(workflowId, activityStateKey, attempt);

  const { perAttemptTimeoutMs, attemptAbortController, activitySignal } = resolvePerAttemptTimeout(
    internals,
    workflowId,
    operation,
    coordinatorSignal,
  );
  const activityContext = buildActivityContext(
    internals,
    workflowId,
    activityStateKey,
    activitySignal,
    () => {
      throw new AsyncActivityDeferral(asyncToken);
    },
  );

  // Build the leaf executor: either dispatch to a worker or call inline.
  const invokeActivity: (activityName: string, input: unknown) => unknown =
    internals.activityWorkerDispatcher
      ? (activityName, input) =>
          invokeWorkerActivity(internals, operation.operationId, activityName, input, attempt)
      : (activityName, input) =>
          withPerAttemptTimeout(
            invokeInlineActivity(
              internals,
              workflowId,
              operation,
              activityContext,
              activityName,
              input,
            ),
            perAttemptTimeoutMs,
            activityName,
            attempt,
            attemptAbortController,
          );

  const composedActivity = callbacks.getComposedActivityInterceptor();
  const executeWithActivityInterceptors = async (
    activityName: string,
    input: unknown,
    headers: Map<string, string>,
  ): Promise<unknown> => {
    if (!composedActivity) {
      return invokeActivity(activityName, input);
    }

    const activityInterception = {
      workflowId,
      activityName,
      input,
      attempt,
      headers,
    };

    const result = await composedActivity.execute(activityInterception, async (interception) => {
      return invokeActivity(activityName, interception.input);
    });

    return result;
  };

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
      const result = executeWithActivityInterceptors(
        operation.activityName,
        interception.input,
        interception.headers,
      );
      return yield result;
    }

    const generator = composedWorkflow.activity(interception, execute);
    const value = await driveWorkflowInterceptorGenerator(generator);
    copyActivityHeadersToOperation(operation, interception.headers);
    return value;
  }

  const headers = new Map<string, string>();
  const result = await executeWithActivityInterceptors(
    operation.activityName,
    activityInput,
    headers,
  );
  copyActivityHeadersToOperation(operation, headers);
  return result;
}

export async function executeActivityOperationResult(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
  callbacks: ActivityOperationCallbacks,
  coordinatorSignal?: AbortSignal,
  speculativeState?: SpeculativeExecutionState,
  executionOptions: ActivityExecutionOptions = {},
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
      coordinatorSignal,
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
    if (executionOptions.reconciliationCompletion === 'immediate-fenced') {
      const finishImmediateReconciliationCommit =
        executionOptions.beforeImmediateReconciliationCommit?.();
      try {
        await commitActivityReconciliationTransitionWithFencedWrite(
          internals,
          reference,
          started,
          completedRecord,
        );
      } finally {
        finishImmediateReconciliationCommit?.();
      }
    } else {
      stageActivityReconciliationTransitionWithAtomicWorkflowCommit(
        internals,
        workflowId,
        reference,
        started,
        completedRecord,
      );
    }
    // Step succeeded durably: drop its tracked heartbeat. Guarded on the
    // non-speculative path only — a speculative step can still roll back and
    // re-run, so it relies on terminal cleanup to clear instead.
    if (!speculativeState) {
      clearLastHeartbeatForStep(internals, workflowId, getActivityStateKey(operation));
    }
    return result;
  }

  const result = await executeActivity(
    internals,
    workflowId,
    operation,
    callbacks,
    operationAttempt,
    coordinatorSignal,
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

  // Step succeeded durably: drop its tracked heartbeat. Guarded on the
  // non-speculative path only — a speculative step can still roll back and
  // re-run, so it relies on terminal cleanup to clear instead.
  if (!speculativeState) {
    clearLastHeartbeatForStep(internals, workflowId, getActivityStateKey(operation));
  }

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
        return parkDeferredAsyncActivity(
          internals,
          error,
          {
            workflowId,
            activityName: operation.activityName,
            operationId: operation.operationId,
            step: operation.step ?? 0,
            attempt: getActivityAttempt(operation),
          },
          {
            feedOperationResult: callbacks.feedOperationResult,
            finalizeTimeline: callbacks.finalizePendingTimelineEntry,
          },
        );
      }
      throw error;
    }
  });
}
