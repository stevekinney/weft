import {
  readActivityRetryAttempt,
  readCompletedRetrySleepCount,
  type ActivityRetryStateKey,
} from './activity-retry-state.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import type { RunActivityRequest } from './run-operation.ts';

type ActivityOperationRequest = Extract<ContextOperationRequest, { type: 'activity' }>;

type CachedResultState<TResult> =
  | { hasCachedResult: false }
  | { cachedResult: TResult; hasCachedResult: true };

type CachedRunActivityRequestConfiguration = {
  advanceStepIndexForCachedRetryState: boolean;
};

type BaseRunActivityRequest = {
  request: ActivityOperationRequest;
  step: number;
  retryStateKey: ActivityRetryStateKey;
  cacheResultStep?: number;
};

export function getCachedRunActivityRequest<TResult>(
  internals: ContextInternals,
  step: number,
  retryStateKey: ActivityRetryStateKey,
  cacheResultStep: number | undefined,
  activityName: string,
  input: unknown,
  configuration: CachedRunActivityRequestConfiguration,
): RunActivityRequest<TResult> {
  const cachedResultState = readCachedResultState<TResult>(internals, cacheResultStep);
  if (cachedResultState.hasCachedResult) {
    return createCachedResultRequest(
      internals,
      step,
      retryStateKey,
      cacheResultStep,
      activityName,
      input,
      cachedResultState.cachedResult,
      configuration,
    );
  }

  const retryAttempt = readActivityRetryAttempt(internals, retryStateKey);
  if (retryAttempt !== undefined) {
    return createRetryStateRequest(
      internals,
      step,
      retryStateKey,
      cacheResultStep,
      activityName,
      input,
      retryAttempt,
      configuration,
    );
  }

  return {
    ...createBaseRequest(step, retryStateKey, cacheResultStep, activityName, input),
    hasCachedResult: false,
    retryAttempt: 1,
  };
}

function readCachedResultState<TResult>(
  internals: ContextInternals,
  cacheResultStep: number | undefined,
): CachedResultState<TResult> {
  if (cacheResultStep === undefined) return { hasCachedResult: false };
  if (internals.accumulatedResults?.has(cacheResultStep) !== true) {
    return { hasCachedResult: false };
  }
  return {
    cachedResult: internals.accumulatedResults.get(cacheResultStep) as TResult,
    hasCachedResult: true,
  };
}

function createCachedResultRequest<TResult>(
  internals: ContextInternals,
  step: number,
  retryStateKey: ActivityRetryStateKey,
  cacheResultStep: number | undefined,
  activityName: string,
  input: unknown,
  cachedResult: TResult,
  configuration: CachedRunActivityRequestConfiguration,
): RunActivityRequest<TResult> {
  if (configuration.advanceStepIndexForCachedRetryState) {
    internals.stepIndex += readCompletedRetrySleepCount(internals, retryStateKey);
  }
  if (internals.explainMode) {
    console.log(`[weft] ctx.run(${activityName}) → Returning cached result from step ${step}`);
  }
  return {
    ...createBaseRequest(step, retryStateKey, cacheResultStep, activityName, input),
    cachedResult,
    hasCachedResult: true,
    retryAttempt: 1,
  };
}

function createRetryStateRequest<TResult>(
  internals: ContextInternals,
  step: number,
  retryStateKey: ActivityRetryStateKey,
  cacheResultStep: number | undefined,
  activityName: string,
  input: unknown,
  retryAttempt: number,
  configuration: CachedRunActivityRequestConfiguration,
): RunActivityRequest<TResult> {
  if (configuration.advanceStepIndexForCachedRetryState) {
    internals.stepIndex += retryAttempt - 2;
  }
  return {
    ...createBaseRequest(step, retryStateKey, cacheResultStep, activityName, input),
    hasCachedResult: false,
    retryAttempt,
  };
}

function createBaseRequest(
  step: number,
  retryStateKey: ActivityRetryStateKey,
  cacheResultStep: number | undefined,
  activityName: string,
  input: unknown,
): BaseRunActivityRequest {
  return {
    request: createReplayActivityOperation(activityName, input),
    step,
    retryStateKey,
    ...(cacheResultStep === undefined ? {} : { cacheResultStep }),
  };
}

function createReplayActivityOperation(
  activityName: string,
  input: unknown,
): ActivityOperationRequest {
  return { type: 'activity', operationId: '', activityName, input };
}
