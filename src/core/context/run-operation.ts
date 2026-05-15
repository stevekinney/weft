import type { ActivityCallOptions } from '../types.ts';
import type { Context } from './index.ts';
import { getInternals, type ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import { isActivityCallOptions } from './session-state.ts';
import { captureCallerStack } from './validation.ts';

type ActivityInput = string | Function;

interface RunActivityRequest<TResult> {
  request: ContextOperationRequest;
  step: number;
  hasCachedResult: boolean;
  cachedResult?: TResult;
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

function getActivityName(activity: ActivityInput): string {
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
    if (internals.explainMode) {
      console.log(`[weft] ctx.run(${activityName}) → Returning cached result from step ${step}`);
    }
    return {
      request: { type: 'activity', operationId: '', activityName, input },
      step,
      hasCachedResult,
      cachedResult: internals.accumulatedResults?.get(step) as TResult,
    };
  }
  return {
    request: { type: 'activity', operationId: '', activityName, input },
    step,
    hasCachedResult,
  };
}

function createFreshRunActivityRequest(
  internals: ContextInternals,
  step: number,
  activityName: string,
  activityFunction: ((input: unknown, context?: unknown) => unknown) | undefined,
  input: unknown,
  options: ActivityCallOptions | undefined,
): ContextOperationRequest {
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
    ...(activityFunction !== undefined ? { fn: activityFunction } : {}),
    input,
    callerStack: captureCallerStack(),
    ...(options !== undefined ? { options: options as Record<string, unknown> } : {}),
  };
}

export function createRunActivityRequest<TResult>(
  context: Context,
  activity: ActivityInput,
  rest: readonly unknown[],
): RunActivityRequest<TResult> {
  const { input, options } = parseRunArguments(activity, rest);
  const activityName = getActivityName(activity);
  const activityFunction = getActivityFunction(activity);
  const internals = getInternals(context);
  const step = internals.stepIndex++;
  const cachedRequest = getCachedRunActivityRequest<TResult>(internals, step, activityName, input);
  if (cachedRequest.hasCachedResult) return cachedRequest;
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
  };
}
