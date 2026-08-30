import { calculateBackoff } from '../scheduler.ts';
import {
  DEFAULT_RETRY_POLICY,
  type ActivityCallOptions,
  type Duration,
  type RetryPolicy,
  type WorkflowContext,
} from '../types.ts';
import {
  completeActivityRetryAttempt,
  readActivityRetryAttempt,
  readCompletedRetrySleepCount,
  readOrInitActivityDispatchedAt,
  writeActivityRetryAttempt,
  type ActivityRetryStateKey,
} from './activity-retry-state.ts';
import {
  assertScheduleToCloseBudgetNotExhausted,
  parseScheduleToCloseBudgetMs,
  resolveActivityScheduleToCloseTimeout,
  resolveActivityTimeout,
  type ScheduleToCloseBudget,
} from './activity-schedule-to-close.ts';
import type { Context } from './index.ts';
import { getInternals, hasContextInternals, type ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import { getCachedRunActivityRequest } from './run-operation-cached-request.ts';
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

export type ActivityInput = string | (Function & { retry?: RetryPolicy });
export type ActivityOperationRequest = Extract<ContextOperationRequest, { type: 'activity' }>;

export interface RunActivityRequest<TResult> {
  request: ActivityOperationRequest;
  step: number;
  retryStateKey: ActivityRetryStateKey;
  cacheResultStep?: number;
  hasCachedResult: boolean;
  cachedResult?: TResult;
  retryAttempt: number;
  retryPolicy?: RetryPolicy;
  scheduleToCloseTimeout?: Duration;
}

export type ActivityRetrySleepGenerator = (
  duration: number,
  nextAttempt: number,
) => Generator<ContextOperationRequest, void, unknown>;

export interface RunActivityAtStepConfiguration {
  explicitName?: string;
  advanceStepIndexForCachedRetryState?: boolean;
  retryStateKey?: ActivityRetryStateKey;
  cacheResultStep?: number | false;
  activityStateKey?: string;
  retrySleep?: ActivityRetrySleepGenerator;
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

export const readActivityRetryAttemptForTesting = readActivityRetryAttempt;
export const readCompletedRetrySleepCountForTesting = readCompletedRetrySleepCount;
export const completeActivityRetryAttemptForTesting = completeActivityRetryAttempt;

const ACTIVITY_RETRY_SLEEP_DEADLINE_LOCAL_PREFIX = '__weftActivityRetrySleepDeadline:';

export function readOrInitActivityRetrySleepFireAt(
  context: Context,
  operationId: string,
  duration: number,
): number {
  const internals = getInternals(context);
  const localKey = `${ACTIVITY_RETRY_SLEEP_DEADLINE_LOCAL_PREFIX}${operationId}`;
  const existing = internals.checkpointLocals[localKey];
  if (typeof existing === 'number' && Number.isFinite(existing)) {
    return existing;
  }
  if (existing !== undefined) {
    throw new Error(
      `Invalid checkpointed activity retry sleep deadline ${JSON.stringify(existing)} for "${operationId}".`,
    );
  }
  const scheduledFireAt = internals.getNow() + duration;
  internals.checkpointLocals = {
    ...internals.checkpointLocals,
    [localKey]: scheduledFireAt,
  };
  return scheduledFireAt;
}

/** Parse the schedule-to-close budget and anchor it to the step's first dispatch. */
export function resolveScheduleToCloseBudget(
  internals: ContextInternals,
  retryStateKey: ActivityRetryStateKey,
  scheduleToCloseTimeout: Duration | undefined,
): ScheduleToCloseBudget | undefined {
  const budgetMs = parseScheduleToCloseBudgetMs(scheduleToCloseTimeout);
  if (budgetMs === undefined) return undefined;
  return {
    budgetMs,
    dispatchedAt: readOrInitActivityDispatchedAt(internals, retryStateKey, internals.getNow()),
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

function createFreshRunActivityRequest(
  internals: ContextInternals,
  step: number,
  activityName: string,
  activityFunction: ((input: unknown, context?: unknown) => unknown) | undefined,
  input: unknown,
  options: ActivityCallOptions | undefined,
  activityStateKey: string | undefined,
  workflowExecutionToken: string | undefined,
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
    ...(activityStateKey === undefined ? {} : { activityStateKey }),
    ...(workflowExecutionToken === undefined ? {} : { workflowExecutionToken }),
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

export function prepareActivityRetryRequest(
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
  // Intentionally parse before reserving a workflow step index; the at-step helper
  // parses again when it builds the request from the validated arguments.
  parseRunArguments(activity, rest);
  const internals = getInternals(context);
  const step = internals.stepIndex++;
  return createRunActivityRequestAtStep(context, activity, rest, step, {
    ...(explicitName === undefined ? {} : { explicitName }),
    advanceStepIndexForCachedRetryState: true,
    retryStateKey: step,
    cacheResultStep: step,
  });
}

export function createRunActivityRequestAtStep<TResult>(
  context: Context,
  activity: ActivityInput,
  rest: readonly unknown[],
  step: number,
  configuration: RunActivityAtStepConfiguration = {},
): RunActivityRequest<TResult> {
  const { input, options } = parseRunArguments(activity, rest);
  const activityName = getActivityName(activity, configuration.explicitName);
  const activityFunction = getActivityFunction(activity);
  const internals = getInternals(context);
  const retryStateKey = configuration.retryStateKey ?? step;
  const cacheResultStep =
    configuration.cacheResultStep === false ? undefined : (configuration.cacheResultStep ?? step);
  const cachedRequest = getCachedRunActivityRequest<TResult>(
    internals,
    step,
    retryStateKey,
    cacheResultStep,
    activityName,
    input,
    {
      advanceStepIndexForCachedRetryState:
        configuration.advanceStepIndexForCachedRetryState ?? false,
    },
  );
  if (cachedRequest.hasCachedResult) return cachedRequest;
  const retryPolicy = resolveActivityRetryPolicy(activity, options);
  const scheduleToCloseTimeout = resolveActivityScheduleToCloseTimeout(activity, options);
  return {
    request: createFreshRunActivityRequest(
      internals,
      step,
      activityName,
      activityFunction,
      input,
      resolveDispatchedActivityOptions(activity, options),
      configuration.activityStateKey,
      context.workflowExecutionToken,
    ),
    step,
    retryStateKey,
    ...(cacheResultStep === undefined ? {} : { cacheResultStep }),
    hasCachedResult: false,
    retryAttempt: cachedRequest.retryAttempt,
    ...(retryPolicy === undefined ? {} : { retryPolicy }),
    ...(scheduleToCloseTimeout === undefined ? {} : { scheduleToCloseTimeout }),
  };
}

function resolveDispatchedActivityOptions(
  activity: ActivityInput,
  options: ActivityCallOptions | undefined,
): ActivityCallOptions | undefined {
  const effectiveTimeout = resolveActivityTimeout(activity, options);
  return effectiveTimeout === undefined ? options : { ...options, timeout: effectiveTimeout };
}

export function* runActivityWithRetry<TResult>(
  context: Context,
  activity: ActivityInput,
  rest: readonly unknown[],
  explicitName?: string,
): Generator<ContextOperationRequest, TResult, unknown> {
  return yield* runPreparedActivityWithRetry(
    context,
    createRunActivityRequest<TResult>(context, activity, rest, explicitName),
    defaultActivityRetrySleep(context),
  );
}

export function* runActivityWithRetryAtStep<TResult>(
  context: Context,
  activity: ActivityInput,
  rest: readonly unknown[],
  step: number,
  configuration: RunActivityAtStepConfiguration = {},
): Generator<ContextOperationRequest, TResult, unknown> {
  return yield* runPreparedActivityWithRetry(
    context,
    createRunActivityRequestAtStep<TResult>(context, activity, rest, step, configuration),
    configuration.retrySleep ?? defaultActivityRetrySleep(context),
  );
}

function defaultActivityRetrySleep(context: Context): ActivityRetrySleepGenerator {
  return function* sleepForRetry(
    duration: number,
  ): Generator<ContextOperationRequest, void, unknown> {
    yield* context.sleep(duration);
  };
}

function* runPreparedActivityWithRetry<TResult>(
  context: Context,
  prepared: RunActivityRequest<TResult>,
  retrySleep: ActivityRetrySleepGenerator,
): Generator<ContextOperationRequest, TResult, unknown> {
  const {
    request,
    retryStateKey,
    cacheResultStep,
    hasCachedResult,
    cachedResult,
    retryAttempt,
    retryPolicy,
    scheduleToCloseTimeout,
  } = prepared;
  if (hasCachedResult) return cachedResult as TResult;
  const internals = getInternals(context);

  // Anchor the schedule-to-close budget at the FIRST dispatch (read-first so a
  // replay never resets it). Writing it before the dispatch `yield` below lands
  // it in that checkpoint. The budget is enforced ONLY at the retry boundary, so
  // without a retry policy it is never consulted — skip the anchor entirely rather
  // than churning a durable `dispatchedAt` write that nothing will read.
  const budget =
    retryPolicy === undefined
      ? undefined
      : resolveScheduleToCloseBudget(internals, retryStateKey, scheduleToCloseTimeout);

  let attempt = retryAttempt;
  if (attempt > 1) {
    if (retryPolicy === undefined) {
      throw new Error(`Missing activity retry policy for checkpointed retry attempt ${attempt}`);
    }
    yield* retrySleep(calculateBackoff(attempt - 1, retryPolicy), attempt);
  }
  while (true) {
    // Enforce the schedule-to-close budget at the retry boundary, at the TOP of
    // the loop (not the catch branch) so it also fires on a recovered frontier
    // attempt — where the backoff sleep replays from cache and the catch branch is
    // never reached — and when a long backoff pushes wall time past the deadline.
    // Attempt 1 is exempt: an activity always gets one try. (Per-attempt wall-clock
    // bounds are the job of `timeout`, the #494 inline cap; scheduleToCloseTimeout
    // stays the documented cross-attempt retry budget, so a `0`ms budget still
    // permits exactly one attempt.)
    if (attempt > 1) {
      assertScheduleToCloseBudgetNotExhausted(budget, request.activityName, internals.getNow());
    }
    try {
      const result = yield prepareActivityRetryRequest(request, attempt);
      if (cacheResultStep !== undefined) {
        context.accumulatedResults.set(cacheResultStep, result);
      }
      completeActivityRetryAttempt(internals, retryStateKey, attempt - 1);
      return result as TResult;
    } catch (error) {
      if (!shouldRetryActivityError(error, retryPolicy, attempt)) {
        throw error;
      }

      // Refuse to schedule a backoff sleep that would itself carry wall time past
      // the deadline: the budget covers the backoff between attempts, so a sleep
      // that lands past it is doomed. Fail at this retry DECISION point — before the
      // durable `writeActivityRetryAttempt`/`sleep` — rather than parking for a sleep
      // we already know exhausts the budget. (The deferred top-of-loop check would
      // reject this same attempt anyway, after the sleep advanced the clock; this
      // front-runs that rejection and skips the useless park. No winnable retry is
      // denied.) The error reports actual elapsed plus the projected next dispatch
      // as the deciding reason. The top-of-loop check handles crash-during-backoff
      // (where this catch branch never runs on recovery).
      const backoff = calculateBackoff(attempt, retryPolicy);
      // Read the clock ONCE so the reported elapsed and the projected next-dispatch
      // decision come from the same instant (a custom getNow could drift between
      // two reads).
      const now = internals.getNow();
      assertScheduleToCloseBudgetNotExhausted(budget, request.activityName, now, now + backoff);

      const nextAttempt = attempt + 1;
      writeActivityRetryAttempt(internals, retryStateKey, nextAttempt);
      yield* retrySleep(backoff, nextAttempt);
      attempt = nextAttempt;
    }
  }
}
