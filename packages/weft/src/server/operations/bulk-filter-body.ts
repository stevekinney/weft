import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type { AttributeFilter, ListFilter } from '../../core/types.ts';
import { parseOptionalFailureCategoryFilter } from './failure-category-filter.ts';

import {
  isJsonSearchAttributeValue,
  normalizeBulkListFilter,
  parseOptionalTimeRange,
  type BulkListFilterDraft,
} from './bulk-filter-input.ts';
import { faultMessage, invalidParamsFault } from './operation-helpers.ts';

function parseAttributeFiltersFromBody(value: unknown): AttributeFilter[] {
  if (!Array.isArray(value)) {
    throw new Error('Field "filter.attributes" must be an array');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Field "filter.attributes[${index}]" must be an object`);
    }

    const record: object = entry;
    const key: unknown = Reflect.get(record, 'key');
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`Field "filter.attributes[${index}].key" must be a non-empty string`);
    }

    const filter: AttributeFilter = { key };
    for (const property of ['value', 'gt', 'lt', 'gte', 'lte'] as const) {
      const attributeValue: unknown = Reflect.get(record, property);
      if (attributeValue === undefined) {
        continue;
      }

      if (!isJsonSearchAttributeValue(attributeValue)) {
        throw new Error(
          `Field "filter.attributes[${index}].${property}" must be a string, number, boolean, or scalar array`,
        );
      }

      if (property === 'value') {
        filter.value = attributeValue;
        continue;
      }

      if (Array.isArray(attributeValue)) {
        throw new Error(
          `Field "filter.attributes[${index}].${property}" must be a string, number, or boolean`,
        );
      }

      filter[property] = attributeValue;
    }

    return filter;
  });
}

function parseFilterStatus(value: unknown): BulkListFilterDraft['status'] {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value;
  }

  throw new Error('Field "filter.status" must be a string or an array of strings');
}

function parseOptionalFilterString(
  value: unknown,
  fieldName: 'type' | 'scheduleId' | 'parentWorkflowId' | 'parentWorkflowExecutionToken',
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  throw new Error(`Field "filter.${fieldName}" must be a string`);
}

function parseOptionalFilterTags(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return coerceStartWorkflowTags(value, 'Field "filter.tags"');
}

function parseOptionalFilterNumber(
  value: unknown,
  fieldName: 'limit' | 'offset',
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Field "filter.${fieldName}" must be a non-negative number`);
  }

  return Math.floor(value);
}

/**
 * Ordered parsers for each filter dimension in `parseBulkListFilterFromBody`.
 * Precedence is visible in source order: status → type → tags → attributes →
 * limit → offset → idPrefix → failureCategory → createdAt →
 * updatedAt → executionDeadline.
 */
const BULK_FILTER_DIMENSION_PARSERS: ReadonlyArray<
  (filter: BulkListFilterDraft, record: object) => void
> = [
  (filter, record) => {
    const status = parseFilterStatus(Reflect.get(record, 'status'));
    if (status !== undefined) filter.status = status;
  },
  (filter, record) => {
    const type = parseOptionalFilterString(Reflect.get(record, 'type'), 'type');
    if (type !== undefined) filter.type = type;
  },
  (filter, record) => {
    const scheduleId = parseOptionalFilterString(Reflect.get(record, 'scheduleId'), 'scheduleId');
    if (scheduleId !== undefined) filter.scheduleId = scheduleId;
  },
  (filter, record) => {
    const parentWorkflowId = parseOptionalFilterString(
      Reflect.get(record, 'parentWorkflowId'),
      'parentWorkflowId',
    );
    if (parentWorkflowId !== undefined) filter.parentWorkflowId = parentWorkflowId;
  },
  (filter, record) => {
    const parentWorkflowExecutionToken = parseOptionalFilterString(
      Reflect.get(record, 'parentWorkflowExecutionToken'),
      'parentWorkflowExecutionToken',
    );
    if (parentWorkflowExecutionToken !== undefined) {
      filter.parentWorkflowExecutionToken = parentWorkflowExecutionToken;
    }
  },
  (filter, record) => {
    const tags = parseOptionalFilterTags(Reflect.get(record, 'tags'));
    if (tags !== undefined) filter.tags = tags;
  },
  (filter, record) => {
    if (Reflect.get(record, 'attributes') !== undefined) {
      filter.attributes = parseAttributeFiltersFromBody(Reflect.get(record, 'attributes'));
    }
  },
  (filter, record) => {
    const limit = parseOptionalFilterNumber(Reflect.get(record, 'limit'), 'limit');
    if (limit !== undefined) filter.limit = limit;
  },
  (filter, record) => {
    const offset = parseOptionalFilterNumber(Reflect.get(record, 'offset'), 'offset');
    if (offset !== undefined) filter.offset = offset;
  },
  (filter, record) => {
    const idPrefix: unknown = Reflect.get(record, 'idPrefix');
    if (typeof idPrefix === 'string') filter.idPrefix = idPrefix;
  },
  (filter, record) => {
    const failureCategory = parseOptionalFailureCategoryFilter(
      Reflect.get(record, 'failureCategory'),
    );
    if (failureCategory !== undefined) filter.failureCategory = failureCategory;
  },
  (filter, record) => {
    const createdAt = parseOptionalTimeRange(Reflect.get(record, 'createdAt'));
    if (createdAt !== undefined) filter.createdAt = createdAt;
  },
  (filter, record) => {
    const updatedAt = parseOptionalTimeRange(Reflect.get(record, 'updatedAt'));
    if (updatedAt !== undefined) filter.updatedAt = updatedAt;
  },
  (filter, record) => {
    const executionDeadline = parseOptionalTimeRange(Reflect.get(record, 'executionDeadline'));
    if (executionDeadline !== undefined) filter.executionDeadline = executionDeadline;
  },
];

export function parseBulkListFilterFromBody(body: unknown): ListFilter {
  if (body === undefined) {
    return {};
  }

  if (typeof body !== 'object' || body === null) {
    throw new Error('Request body must be a JSON object');
  }

  const rawFilter: unknown = Reflect.get(body, 'filter');
  if (rawFilter === undefined) {
    return {};
  }

  if (typeof rawFilter !== 'object' || rawFilter === null) {
    throw new Error('Field "filter" must be an object');
  }

  const filterRecord = rawFilter;
  const filter: BulkListFilterDraft = {};
  for (const applyDimension of BULK_FILTER_DIMENSION_PARSERS) {
    applyDimension(filter, filterRecord);
  }
  return normalizeBulkListFilter(filter);
}

export function parseRequiredBulkListFilter(body: unknown): ListFilter {
  try {
    return assertScopedBulkWorkflowFilter(parseBulkListFilterFromBody(body));
  } catch (error) {
    throw invalidParamsFault(faultMessage(error));
  }
}
