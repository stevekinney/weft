import type { FailureCategory, OperationOutcome } from './types.ts';

export const FAILURE_CATEGORIES = [
  'application',
  'timeout',
  'cancellation',
  'resource',
  'system',
] as const satisfies readonly FailureCategory[];

const currentFailureCategories = new Set<unknown>(FAILURE_CATEGORIES);
const timeoutErrorNames = new Set([
  'ActivityScheduleToCloseTimeoutError',
  'MCPToolTimeoutError',
  'ReviewTimeoutError',
  'UpdateTimeoutError',
  'WorkflowTimeoutError',
  'TimeoutError',
]);

export const timeoutFailureCategoryMarker: unique symbol = Symbol.for(
  'weft.failure-category.timeout',
);
const cancellationErrorNames = new Set([
  'AbortError',
  'CancelledError',
  'CancellationError',
  'WorkflowCancelledError',
]);
const resourceErrorNames = new Set([
  'QuotaExceededError',
  'ResourceExhaustedError',
  'OutOfMemoryError',
  'StorageQuotaExceededError',
]);

export interface FailureCategoryClassificationOptions {
  /**
   * Category to use for ordinary Error instances that do not match a known
   * infrastructure name. Omit this at engine boundaries so unknown runtime
   * failures stay classified as system failures.
   */
  defaultErrorCategory?: FailureCategory;
}

export function isFailureCategory(value: unknown): value is FailureCategory {
  return currentFailureCategories.has(value);
}

export function normalizeFailureCategory(value: unknown): FailureCategory | undefined {
  if (isFailureCategory(value)) return value;
  return undefined;
}

export function failureCategorySearchValues(category: FailureCategory): readonly string[] {
  return [category];
}

export function classifyErrorAsFailureCategory(
  error: unknown,
  options: FailureCategoryClassificationOptions = {},
): FailureCategory {
  if (!(error instanceof Error)) {
    return 'system';
  }

  if (timeoutErrorNames.has(error.name)) return 'timeout';
  if (Object.prototype.hasOwnProperty.call(error, timeoutFailureCategoryMarker)) return 'timeout';
  if (cancellationErrorNames.has(error.name)) return 'cancellation';
  if (resourceErrorNames.has(error.name)) return 'resource';

  return options.defaultErrorCategory ?? 'system';
}

export function errorFromFailedOperationOutcome(
  outcome: Extract<OperationOutcome, { status: 'failed' }>,
): Error {
  const error = new Error(outcome.error);
  if (outcome.errorName !== undefined) {
    error.name = outcome.errorName;
  }
  return error;
}
