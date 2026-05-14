import type { FailureCategory } from './types/identity.ts';

export const FAILURE_CATEGORIES = [
  'application',
  'timeout',
  'cancellation',
  'resource',
  'system',
] as const satisfies readonly FailureCategory[];

const currentFailureCategories = new Set<unknown>(FAILURE_CATEGORIES);

const legacyFailureCategoryMapping: Readonly<Record<string, FailureCategory>> = {
  action: 'application',
  memory: 'resource',
  planning: 'application',
  reflection: 'application',
  system: 'system',
};

export function isFailureCategory(value: unknown): value is FailureCategory {
  return currentFailureCategories.has(value);
}

export function normalizeFailureCategory(value: unknown): FailureCategory | undefined {
  if (isFailureCategory(value)) return value;
  if (typeof value !== 'string') return undefined;
  return legacyFailureCategoryMapping[value];
}
