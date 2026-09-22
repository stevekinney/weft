import { z } from 'zod';

import { listFilterObjectSchema, normalizeListFilter } from '../../core/list-filter-validation.ts';
import type {
  AttributeFilter,
  AttributeFilterScalarValue,
  ListFilter,
  SearchAttributeValue,
  TimeRange,
} from '../../core/types.ts';

export const bulkListFilterInputSchema = listFilterObjectSchema.extend({
  // Bulk operations intentionally accept zero as a no-op limit.
  limit: z.number().int().min(0).optional(),
});

export type BulkListFilterInput = z.infer<typeof bulkListFilterInputSchema>;

export type BulkListFilterDraft = Omit<ListFilter, 'status'> & {
  status?: string | string[] | undefined;
};

export function isJsonSearchAttributeValue(value: unknown): value is SearchAttributeValue {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

const TIME_RANGE_BOUNDS = ['gte', 'gt', 'lte', 'lt'] as const;

export function parseOptionalTimeRange(value: unknown): TimeRange | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new Error('Time-range filter must be an object with gte/gt/lte/lt numeric bounds');
  }
  const range: TimeRange = {};
  for (const bound of TIME_RANGE_BOUNDS) {
    const entry: unknown = Reflect.get(value, bound);
    if (entry === undefined) continue;
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new Error(`Time-range bound "${bound}" must be a finite number`);
    }
    range[bound] = entry;
  }
  return Object.keys(range).length > 0 ? range : undefined;
}

export function listFilterFromBulkInput(input: BulkListFilterInput): ListFilter {
  const filter: ListFilter = {};
  applyBasicBulkFilterFields(filter, input);
  applyExtendedBulkFilterFields(filter, input);
  applyBulkTimeRangeFields(filter, input);
  return normalizeBulkListFilter(filter);
}

export function normalizeBulkListFilter(filter: BulkListFilterDraft): ListFilter {
  const limit = filter.limit;
  delete filter.limit;
  const normalized = normalizeListFilter(filter);
  return limit === undefined ? normalized : { ...normalized, limit };
}

function applyBasicBulkFilterFields(filter: ListFilter, input: BulkListFilterInput): void {
  if (input.status !== undefined) {
    filter.status = input.status;
  }
  if (input.type !== undefined) {
    filter.type = input.type;
  }
  if (input.tags !== undefined) {
    filter.tags = input.tags;
  }
  if (input.attributes !== undefined) {
    filter.attributes = input.attributes.map(copyAttributeFilter);
  }
  if (input.limit !== undefined) {
    filter.limit = input.limit;
  }
  if (input.offset !== undefined) {
    filter.offset = input.offset;
  }
}

function copyAttributeFilter(
  attribute: NonNullable<BulkListFilterInput['attributes']>[number],
): AttributeFilter {
  const filter: AttributeFilter = { key: attribute.key };
  if (attribute.value !== undefined) {
    if (!isJsonSearchAttributeValue(attribute.value)) {
      throw new Error(
        'Field "filter.attributes[].value" must be a string, number, boolean, or scalar array',
      );
    }
    filter.value = attribute.value;
  }
  if (attribute.gt !== undefined) {
    filter.gt = copyAttributeRangeBound(attribute.gt, 'gt');
  }
  if (attribute.lt !== undefined) {
    filter.lt = copyAttributeRangeBound(attribute.lt, 'lt');
  }
  if (attribute.gte !== undefined) {
    filter.gte = copyAttributeRangeBound(attribute.gte, 'gte');
  }
  if (attribute.lte !== undefined) {
    filter.lte = copyAttributeRangeBound(attribute.lte, 'lte');
  }
  return filter;
}

function copyAttributeRangeBound(
  value: unknown,
  property: 'gt' | 'lt' | 'gte' | 'lte',
): AttributeFilterScalarValue {
  if (!isJsonSearchAttributeValue(value) || Array.isArray(value)) {
    throw new Error(`Field "filter.attributes[].${property}" must be a string, number, or boolean`);
  }
  return value;
}

function applyExtendedBulkFilterFields(filter: ListFilter, input: BulkListFilterInput): void {
  if (input.scheduleId !== undefined) {
    filter.scheduleId = input.scheduleId;
  }
  if (input.parentWorkflowId !== undefined) {
    filter.parentWorkflowId = input.parentWorkflowId;
  }
  if (input.parentWorkflowExecutionToken !== undefined) {
    filter.parentWorkflowExecutionToken = input.parentWorkflowExecutionToken;
  }
  if (input.idPrefix !== undefined) {
    filter.idPrefix = input.idPrefix;
  }
  if (input.failureCategory !== undefined) {
    filter.failureCategory = input.failureCategory;
  }
}

function applyBulkTimeRangeFields(filter: ListFilter, input: BulkListFilterInput): void {
  const createdAt = parseOptionalTimeRange(input.createdAt);
  if (createdAt !== undefined) {
    filter.createdAt = createdAt;
  }

  const updatedAt = parseOptionalTimeRange(input.updatedAt);
  if (updatedAt !== undefined) {
    filter.updatedAt = updatedAt;
  }

  const executionDeadline = parseOptionalTimeRange(input.executionDeadline);
  if (executionDeadline !== undefined) {
    filter.executionDeadline = executionDeadline;
  }
}
