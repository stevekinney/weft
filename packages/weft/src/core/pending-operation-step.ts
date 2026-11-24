import type { ContextOperationRequest } from './context.ts';

/**
 * The durable step index the operation being persisted occupies: the `step` the operation request
 * carries (an activity, a group, a memo, a race), else `fallbackStepIndex`, which the caller reads
 * from where the run keeps its position (the live context inline, the worker's own report for a
 * worker). A group takes steps for its primed branches after its own, so the live step index
 * alone is not the group's step: the request's `step` has to win.
 */
export function resolvePendingOperationStep(
  operation: ContextOperationRequest,
  fallbackStepIndex: number,
): number {
  const operationStep = 'step' in operation ? operation.step : undefined;
  if (
    typeof operationStep === 'number' &&
    Number.isSafeInteger(operationStep) &&
    operationStep >= 0
  ) {
    return operationStep;
  }
  return fallbackStepIndex;
}
