import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import { captureCallerStack } from './validation.ts';

export function* speculate<TResult>(
  context: Context,
  internals: ContextInternals,
  execute: (
    context: Context,
  ) =>
    | Generator<ContextOperationRequest, TResult, unknown>
    | AsyncGenerator<unknown, TResult, unknown>,
): Generator<ContextOperationRequest, TResult, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as TResult;
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'speculate' as const,
    operationId,
    execute,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as TResult;
}
