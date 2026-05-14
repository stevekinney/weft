import { FAILURE_CATEGORIES, isFailureCategory } from '../../core/failure-categories.ts';
import type { FailureCategory } from '../../core/types.ts';

const failureCategoryErrorMessage = `Field "filter.failureCategory" must be one of ${FAILURE_CATEGORIES.join(', ')}`;
const failureCategoryShapeErrorMessage =
  'Field "filter.failureCategory" must be a string or an array of strings';

export function parseOptionalFailureCategoryFilter(
  value: unknown,
): FailureCategory | FailureCategory[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return parseFailureCategory(value);
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === 'string')) {
      throw new Error(failureCategoryShapeErrorMessage);
    }
    return value.map(parseFailureCategory);
  }
  throw new Error(failureCategoryShapeErrorMessage);
}

function parseFailureCategory(value: string): FailureCategory {
  if (isFailureCategory(value)) return value;
  throw new Error(failureCategoryErrorMessage);
}
