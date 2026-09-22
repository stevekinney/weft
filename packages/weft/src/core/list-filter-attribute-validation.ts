/** Attribute-key and value validation for list filters. */

import { z } from 'zod';

import { ListFilterValidationError } from './list-filter-validation-error.ts';
import type { AttributeFilter } from './types/list-options.ts';
import type { SearchAttributeHandle, SearchAttributeValue } from './types/search-attributes.ts';

const SEARCH_ATTRIBUTE_TYPES = new Set(['array', 'boolean', 'integer', 'number', 'string']);

// Search-attribute filters retain the existing permissive shape — they are not
// the focus of this validation module. Visibility-filter callers validate
// attribute names elsewhere (in the engine and aggregate path).
const searchAttributeScalarValueSchema: z.ZodType = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.date(),
]);
const searchAttributeValueSchema: z.ZodType = z.union([
  searchAttributeScalarValueSchema,
  z.array(z.union([z.string(), z.number(), z.boolean(), z.date()])),
]);

export const attributeFilterSchema = z.object({
  key: z.union([z.string().min(1), z.any()]),
  value: searchAttributeValueSchema.optional(),
  gt: searchAttributeScalarValueSchema.optional(),
  lt: searchAttributeScalarValueSchema.optional(),
  gte: searchAttributeScalarValueSchema.optional(),
  lte: searchAttributeScalarValueSchema.optional(),
});

function isSearchAttributeHandle(value: unknown): value is SearchAttributeHandle {
  if (!isRecord(value)) return false;
  const handle = value;
  if (typeof handle['name'] !== 'string' || typeof handle['type'] !== 'string') return false;
  if (!SEARCH_ATTRIBUTE_TYPES.has(handle['type'])) return false;
  if (handle['format'] !== undefined && typeof handle['format'] !== 'string') return false;
  if (handle['items'] !== undefined && !isSearchAttributeItems(handle['items'])) return false;
  return true;
}

function isSearchAttributeItems(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const items = value;
  return (
    items['type'] === 'string' &&
    (items['format'] === undefined || typeof items['format'] === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type AttributeFilterExactValue = SearchAttributeValue | number[] | boolean[] | Date[];

function isSearchAttributeValue(value: unknown): value is AttributeFilterExactValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date ||
    (Array.isArray(value) &&
      value.every(
        (item) =>
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean' ||
          item instanceof Date,
      ))
  );
}

export function normalizeAttributeFilter(
  attribute: z.infer<typeof attributeFilterSchema>,
  index: number,
): AttributeFilter {
  const key = attribute.key;
  if (typeof key !== 'string' && !isSearchAttributeHandle(key)) {
    throw new ListFilterValidationError([
      {
        path: ['attributes', index, 'key'],
        message: 'Invalid search attribute key',
        code: 'custom',
      },
    ]);
  }

  return typeof key === 'string'
    ? normalizeStringAttributeFilter(attribute, key, index)
    : normalizeHandleAttributeFilter(attribute, key, index);
}

function normalizeStringAttributeFilter(
  attribute: z.infer<typeof attributeFilterSchema>,
  key: string,
  index: number,
): AttributeFilter<string> {
  const normalized: AttributeFilter<string> = { key };
  if ('value' in attribute) {
    const value = attribute.value;
    if (value !== undefined) assertSearchAttributeValue(value, ['attributes', index, 'value']);
    normalized.value = value;
  }
  for (const field of ['gt', 'lt', 'gte', 'lte'] as const) {
    if (field in attribute) {
      const rangeValue = attribute[field];
      if (rangeValue !== undefined) {
        assertSearchAttributeRangeValue(rangeValue, ['attributes', index, field]);
      }
      normalized[field] = rangeValue;
    }
  }
  return normalized;
}

function normalizeHandleAttributeFilter(
  attribute: z.infer<typeof attributeFilterSchema>,
  key: SearchAttributeHandle,
  index: number,
): AttributeFilter<SearchAttributeHandle> {
  const normalized: AttributeFilter<SearchAttributeHandle> = { key };
  if ('value' in attribute) {
    const value = attribute.value;
    if (value !== undefined) assertHandleValue(key, value, ['attributes', index, 'value']);
    normalized.value = value;
  }
  for (const field of ['gt', 'lt', 'gte', 'lte'] as const) {
    if (field in attribute) {
      const rangeValue = attribute[field];
      if (rangeValue !== undefined) {
        assertHandleRangeValue(rangeValue, ['attributes', index, field]);
      }
      normalized[field] = rangeValue;
    }
  }
  return normalized;
}

function assertSearchAttributeValue(
  value: unknown,
  path: (string | number)[],
): asserts value is AttributeFilterExactValue {
  if (!isSearchAttributeValue(value)) {
    throw new ListFilterValidationError([
      { path, message: 'Invalid search attribute value', code: 'custom' },
    ]);
  }
}

function assertSearchAttributeRangeValue(
  value: unknown,
  path: (string | number)[],
): asserts value is Exclude<SearchAttributeValue, string[]> {
  if (!isSearchAttributeValue(value) || Array.isArray(value)) {
    throw new ListFilterValidationError([
      { path, message: 'Invalid search attribute range value', code: 'custom' },
    ]);
  }
}

function assertHandleRangeValue(
  value: unknown,
  path: (string | number)[],
): asserts value is number | Date {
  if (!(typeof value === 'number' || value instanceof Date)) {
    throw new ListFilterValidationError([
      { path, message: 'Invalid search attribute handle range value', code: 'custom' },
    ]);
  }
}

function assertHandleValue(
  handle: SearchAttributeHandle,
  value: unknown,
  path: (string | number)[],
): asserts value is AttributeFilterExactValue {
  const valid =
    handle.type === 'string' && handle.format === 'date-time'
      ? isDateOrDateArray(value)
      : (HANDLE_VALUE_CHECKS[handle.type]?.(value) ?? false);
  if (!valid) {
    throw new ListFilterValidationError([
      { path, message: 'Invalid value for search attribute handle', code: 'custom' },
    ]);
  }
}

function isDateOrDateArray(value: unknown): value is Date | Date[] {
  return (
    value instanceof Date || (Array.isArray(value) && value.every((item) => item instanceof Date))
  );
}

const HANDLE_VALUE_CHECKS: Record<string, (value: unknown) => boolean> = {
  array: (value) =>
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string')),
  string: (value) => isScalarOrArray(value, (item) => typeof item === 'string'),
  number: (value) => isScalarOrArray(value, (item) => typeof item === 'number'),
  integer: (value) =>
    isScalarOrArray(value, (item) => typeof item === 'number' && Number.isInteger(item)),
  boolean: (value) => isScalarOrArray(value, (item) => typeof item === 'boolean'),
};

function isScalarOrArray(value: unknown, isScalar: (value: unknown) => boolean): boolean {
  return isScalar(value) || (Array.isArray(value) && value.every(isScalar));
}
