import type { FailureCategory } from './types/identity.ts';

export const FAILURE_CATEGORIES = [
  'application',
  'timeout',
  'cancellation',
  'resource',
  'system',
] as const satisfies readonly FailureCategory[];

const currentFailureCategories = new Set<unknown>(FAILURE_CATEGORIES);
const timeoutErrorNames = new Set([
  'MCPToolTimeoutError',
  'ReviewTimeoutError',
  'UpdateTimeoutError',
  'WorkflowTimeoutError',
  'ChaosTimeoutError',
  'TimeoutError',
]);
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

const legacyFailureCategoryMapping: Readonly<Record<string, FailureCategory>> = {
  action: 'application',
  memory: 'resource',
  planning: 'application',
  reflection: 'application',
  system: 'system',
};
const failureCategorySearchAliases: Readonly<Record<FailureCategory, readonly string[]>> = {
  application: ['application', 'action', 'planning', 'reflection'],
  timeout: ['timeout'],
  cancellation: ['cancellation'],
  resource: ['resource', 'memory'],
  system: ['system'],
};

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
  if (typeof value !== 'string') return undefined;
  return legacyFailureCategoryMapping[value];
}

export function failureCategorySearchValues(category: FailureCategory): readonly string[] {
  return failureCategorySearchAliases[category];
}

export function classifyErrorAsFailureCategory(
  error: unknown,
  options: FailureCategoryClassificationOptions = {},
): FailureCategory {
  if (!(error instanceof Error)) {
    return 'system';
  }

  if (timeoutErrorNames.has(error.name)) return 'timeout';
  if (cancellationErrorNames.has(error.name)) return 'cancellation';
  if (resourceErrorNames.has(error.name)) return 'resource';

  return options.defaultErrorCategory ?? 'system';
}
