import { calculateBackoff } from '../scheduler.ts';
import {
  DEFAULT_RETRY_POLICY,
  type ActivityCallOptions,
  type RetryPolicy,
  type WorkflowContext,
} from '../types.ts';
import type { Context } from './index.ts';
import { getInternals, hasContextInternals, type ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import { isActivityCallOptions } from './session-state.ts';
import { captureCallerStack } from './validation.ts';

/**
 * Recover the concrete {@link Context} from the public {@link WorkflowContext}
 * the engine passes to a workflow handler. Under the inline execution strategy
 * the engine invokes a handler with the concrete `Context` instance (carrying
 * the `stepIndex`/`accumulatedResults` replay machinery). Worker execution mode
 * instead drives the handler with a minimal `WorkerWorkflowContext`, which has
 * no replay internals — so infrastructure such as `compileStepWorkflow` cannot
 * drive the durable activity machinery there. This probes for the inline
 * internals (via the `hasContextInternals` type guard, which narrows without a
 * cast) and throws an actionable error rather than the cryptic
 * "Context internals not initialized" from a downstream `getInternals` call.
 */
export function asConcreteContext(context: WorkflowContext): Context {
  if (!hasContextInternals(context)) {
    throw new Error(
      'Step-based workflows (compileStepWorkflow / ctx.step) require ' +
        "workflowExecutionMode: 'inline'. The worker execution strategy runs " +
        'workflows with a different context that has no durable step machinery. ' +
        'Use the generator workflow API for worker execution mode.',
    );
  }
  return context;
}

type ActivityInput = string | (Function & { retry?: RetryPolicy });
type ActivityOperationRequest = Extract<ContextOperationRequest, { type: 'activity' }>;

const ACTIVITY_RETRY_STATE_LOCAL_KEY = '__weftActivityRetryState';
const ACTIVITY_RETRY_STATE_VERSION = 1;
const MAX_CHECKPOINTED_RETRY_ATTEMPT = 10_000;

interface ActivityRetryState {
  version: typeof ACTIVITY_RETRY_STATE_VERSION;
  attempts: Record<string, number>;
  completedRetrySleeps?: Record<string, number>;
}

interface RunActivityRequest<TResult> {
  request: ActivityOperationRequest;
  step: number;
  hasCachedResult: boolean;
  cachedResult?: TResult;
  retryAttempt: number;
  retryPolicy?: RetryPolicy;
}

interface ParsedRunArguments {
  input: unknown;
  options: ActivityCallOptions | undefined;
}

function acceptsNoActivityInput(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  if (fn.length === 0) return true;
  const execute = (fn as { execute?: unknown }).execute;
  return typeof execute === 'function' && execute.length === 0;
}

function shouldTreatLastArgumentAsOptions(
  activity: ActivityInput,
  rest: readonly unknown[],
): boolean {
  const lastArgument = rest.at(-1);
  return (
    rest.length > 0 &&
    isActivityCallOptions(lastArgument) &&
    (rest.length > 1 || (typeof activity !== 'string' && acceptsNoActivityInput(activity)))
  );
}

function parseRunArguments(activity: ActivityInput, rest: readonly unknown[]): ParsedRunArguments {
  const values = [...rest];
  const options = shouldTreatLastArgumentAsOptions(activity, values)
    ? (values.pop() as ActivityCallOptions)
    : undefined;
  if (values.length > 1) {
    throw new Error(
      'ctx.run() accepts one activity input value plus optional ActivityCallOptions.',
    );
  }
  return { input: values[0], options };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isActivityRetryState(value: unknown): value is ActivityRetryState {
  return (
    isRecord(value) &&
    value['version'] === ACTIVITY_RETRY_STATE_VERSION &&
    isRecord(value['attempts']) &&
    (value['completedRetrySleeps'] === undefined || isRecord(value['completedRetrySleeps']))
  );
}

function assertValidRetryAttempt(attempt: number, step: number): void {
  if (!Number.isInteger(attempt) || attempt <= 1 || attempt > MAX_CHECKPOINTED_RETRY_ATTEMPT) {
    throw new Error(
      `Invalid checkpointed activity retry attempt ${String(attempt)} for step ${String(step)}`,
    );
  }
}

function readActivityRetryAttempt(internals: ContextInternals, step: number): number | undefined {
  const state = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  if (!isActivityRetryState(state)) return undefined;

  const attempt = state.attempts[String(step)];
  if (attempt === undefined) return undefined;
  assertValidRetryAttempt(attempt, step);
  return attempt;
}

function readCompletedRetrySleepCount(internals: ContextInternals, step: number): number {
  const state = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  if (!isActivityRetryState(state)) return 0;

  const count = state.completedRetrySleeps?.[String(step)];
  if (count === undefined) return 0;
  if (!Number.isInteger(count) || count < 0 || count > MAX_CHECKPOINTED_RETRY_ATTEMPT) {
    throw new Error(
      `Invalid checkpointed activity retry sleep count ${String(count)} for step ${String(step)}`,
    );
  }
  return count;
}

function writeActivityRetryAttempt(
  internals: ContextInternals,
  step: number,
  attempt: number,
): void {
  assertValidRetryAttempt(attempt, step);
  const current = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  const attempts = isActivityRetryState(current) ? { ...current.attempts } : {};
  attempts[String(step)] = attempt;
  // Preserve any completedRetrySleeps already recorded for earlier steps;
  // rebuilding the slot with only `attempts` would erase them, causing a
  // recovered workflow to re-run backoff sleeps it already completed.
  const completedRetrySleeps = isActivityRetryState(current)
    ? current.completedRetrySleeps
    : undefined;
  internals.checkpointLocals = {
    ...internals.checkpointLocals,
    [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
      version: ACTIVITY_RETRY_STATE_VERSION,
      attempts,
      ...(completedRetrySleeps === undefined ? {} : { completedRetrySleeps }),
    } satisfies ActivityRetryState,
  };
}

function clearActivityRetryAttempt(internals: ContextInternals, step: number): void {
  const current = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  if (!isActivityRetryState(current)) return;

  const attempts = { ...current.attempts };
  delete attempts[String(step)];
  const completedRetrySleeps = current.completedRetrySleeps;
  const { [ACTIVITY_RETRY_STATE_LOCAL_KEY]: _removed, ...remainingLocals } =
    internals.checkpointLocals;
  if (Object.keys(attempts).length === 0 && completedRetrySleeps === undefined) {
    internals.checkpointLocals = remainingLocals;
    return;
  }
  internals.checkpointLocals = {
    ...remainingLocals,
    [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
      version: ACTIVITY_RETRY_STATE_VERSION,
      attempts,
      ...(completedRetrySleeps === undefined ? {} : { completedRetrySleeps }),
    } satisfies ActivityRetryState,
  };
}

function completeActivityRetryAttempt(
  internals: ContextInternals,
  step: number,
  completedRetrySleepCount: number,
): void {
  if (
    !Number.isInteger(completedRetrySleepCount) ||
    completedRetrySleepCount < 0 ||
    completedRetrySleepCount > MAX_CHECKPOINTED_RETRY_ATTEMPT
  ) {
    throw new Error(
      `Invalid completed activity retry sleep count ${String(completedRetrySleepCount)} for step ${String(step)}`,
    );
  }
  clearActivityRetryAttempt(internals, step);
  if (completedRetrySleepCount === 0) return;

  const current = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  const attempts = isActivityRetryState(current) ? { ...current.attempts } : {};
  const completedRetrySleeps = isActivityRetryState(current)
    ? { ...current.completedRetrySleeps }
    : {};
  completedRetrySleeps[String(step)] = completedRetrySleepCount;
  internals.checkpointLocals = {
    ...internals.checkpointLocals,
    [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
      version: ACTIVITY_RETRY_STATE_VERSION,
      attempts,
      completedRetrySleeps,
    } satisfies ActivityRetryState,
  };
}

function getActivityName(activity: ActivityInput, explicitName?: string): string {
  if (explicitName !== undefined) return explicitName;
  return typeof activity === 'string' ? activity : activity.name || 'anonymous';
}

function getActivityFunction(
  activity: ActivityInput,
): ((input: unknown, context?: unknown) => unknown) | undefined {
  return typeof activity === 'function'
    ? (activity as (input: unknown, context?: unknown) => unknown)
    : undefined;
}

function getCachedRunActivityRequest<TResult>(
  internals: ContextInternals,
  step: number,
  activityName: string,
  input: unknown,
): RunActivityRequest<TResult> {
  const hasCachedResult = internals.accumulatedResults?.has(step) ?? false;
  if (hasCachedResult) {
    const cachedResult = internals.accumulatedResults?.get(step);
    internals.stepIndex += readCompletedRetrySleepCount(internals, step);
    if (internals.explainMode) {
      console.log(`[weft] ctx.run(${activityName}) → Returning cached result from step ${step}`);
    }
    return {
      request: { type: 'activity', operationId: '', activityName, input },
      step,
      hasCachedResult,
      cachedResult: cachedResult as TResult,
      retryAttempt: 1,
    };
  }
  const retryAttempt = readActivityRetryAttempt(internals, step);
  if (retryAttempt !== undefined) {
    internals.stepIndex += retryAttempt - 2;
    return {
      request: { type: 'activity', operationId: '', activityName, input },
      step,
      hasCachedResult: false,
      retryAttempt,
    };
  }
  return {
    request: { type: 'activity', operationId: '', activityName, input },
    step,
    hasCachedResult,
    retryAttempt: 1,
  };
}

function createFreshRunActivityRequest(
  internals: ContextInternals,
  step: number,
  activityName: string,
  activityFunction: ((input: unknown, context?: unknown) => unknown) | undefined,
  input: unknown,
  options: ActivityCallOptions | undefined,
): ActivityOperationRequest {
  const queue = options?.queue ?? 'default';
  if (internals.explainMode) {
    console.log(`[weft] ctx.run(${activityName}, ${JSON.stringify(input)})`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Dispatching activity "${activityName}" to queue "${queue}"`);
  }
  return {
    type: 'activity',
    operationId: crypto.randomUUID(),
    activityName,
    step,
    ...(activityFunction !== undefined ? { fn: activityFunction } : {}),
    input,
    callerStack: captureCallerStack(),
    ...(options !== undefined ? { options: options as Record<string, unknown> } : {}),
  };
}

function resolveActivityRetryPolicy(
  activity: ActivityInput,
  options: ActivityCallOptions | undefined,
): RetryPolicy | undefined {
  const activityRetry = typeof activity === 'string' ? undefined : activity.retry;
  const operationRetry = options?.retry;
  if (activityRetry === undefined && operationRetry === undefined) {
    return undefined;
  }

  return {
    ...DEFAULT_RETRY_POLICY,
    ...activityRetry,
    ...operationRetry,
  };
}

function isNonRetryableActivityError(error: unknown, policy: RetryPolicy): boolean {
  const nonRetryableErrors = policy.nonRetryableErrors ?? [];
  if (nonRetryableErrors.length === 0) return false;
  if (error instanceof Error) {
    return nonRetryableErrors.includes(error.name) || nonRetryableErrors.includes(error.message);
  }
  return nonRetryableErrors.includes(String(error));
}

export function shouldRetryActivityError(
  error: unknown,
  policy: RetryPolicy | undefined,
  attempt: number,
): policy is RetryPolicy {
  return (
    policy !== undefined &&
    attempt < policy.maxAttempts &&
    !isNonRetryableActivityError(error, policy)
  );
}

function prepareActivityRetryRequest(
  request: ActivityOperationRequest,
  attempt: number,
): ActivityOperationRequest {
  if (attempt === 1) return request;
  return {
    ...request,
    operationId: crypto.randomUUID(),
    attempt,
  };
}

export function createRunActivityRequest<TResult>(
  context: Context,
  activity: ActivityInput,
  rest: readonly unknown[],
  explicitName?: string,
): RunActivityRequest<TResult> {
  const { input, options } = parseRunArguments(activity, rest);
  const activityName = getActivityName(activity, explicitName);
  const activityFunction = getActivityFunction(activity);
  const internals = getInternals(context);
  const step = internals.stepIndex++;
  const cachedRequest = getCachedRunActivityRequest<TResult>(internals, step, activityName, input);
  if (cachedRequest.hasCachedResult) return cachedRequest;
  const retryPolicy = resolveActivityRetryPolicy(activity, options);
  return {
    request: createFreshRunActivityRequest(
      internals,
      step,
      activityName,
      activityFunction,
      input,
      options,
    ),
    step,
    hasCachedResult: false,
    retryAttempt: cachedRequest.retryAttempt,
    ...(retryPolicy === undefined ? {} : { retryPolicy }),
  };
}

export function* runActivityWithRetry<TResult>(
  context: Context,
  activity: ActivityInput,
  rest: readonly unknown[],
  explicitName?: string,
): Generator<ContextOperationRequest, TResult, unknown> {
  const { request, step, hasCachedResult, cachedResult, retryAttempt, retryPolicy } =
    createRunActivityRequest<TResult>(context, activity, rest, explicitName);
  if (hasCachedResult) return cachedResult as TResult;
  const internals = getInternals(context);

  let attempt = retryAttempt;
  if (attempt > 1) {
    if (retryPolicy === undefined) {
      throw new Error(`Missing activity retry policy for checkpointed retry attempt ${attempt}`);
    }
    yield* context.sleep(calculateBackoff(attempt - 1, retryPolicy));
  }
  while (true) {
    try {
      const result = yield prepareActivityRetryRequest(request, attempt);
      context.accumulatedResults.set(step, result);
      completeActivityRetryAttempt(internals, step, attempt - 1);
      return result as TResult;
    } catch (error) {
      if (!shouldRetryActivityError(error, retryPolicy, attempt)) {
        throw error;
      }

      const nextAttempt = attempt + 1;
      writeActivityRetryAttempt(internals, step, nextAttempt);
      yield* context.sleep(calculateBackoff(attempt, retryPolicy));
      attempt = nextAttempt;
    }
  }
}
