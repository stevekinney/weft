import { z } from 'zod';

import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import { isFailureCategory } from '../../core/failure-categories.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type {
  AttributeFilter,
  BulkOperationCommitOptions,
  BulkOperationDryRunOptions,
  BulkOperationPrincipal,
  FailureCategory,
  ListFilter,
  SearchAttributeValue,
  TimeRange,
  WorkflowStatus,
} from '../../core/types.ts';
import {
  MAX_BULK_CONFIRMATION_TOKEN_LENGTH,
  MAX_BULK_OPERATION_REQUEST_ID_LENGTH,
} from '../../core/types/bulk.ts';
import type { AccessPolicy } from '../authorization.ts';
import type { OperationFault } from '../operation-fault.ts';
import type { Principal } from '../principal.ts';
import { parseOptionalFailureCategoryFilter } from './failure-category-filter.ts';
import { invalidParamsFault } from './operation-helpers.ts';

const workflowStatusSchema = z.custom<WorkflowStatus>((value) => typeof value === 'string');
const searchAttributeValueSchema = z.custom<SearchAttributeValue>((value) => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
});
const attributeFilterSchema = z.object({
  key: z.string().min(1),
  value: searchAttributeValueSchema.optional(),
  gt: searchAttributeValueSchema.optional(),
  lt: searchAttributeValueSchema.optional(),
  gte: searchAttributeValueSchema.optional(),
  lte: searchAttributeValueSchema.optional(),
});
const failureCategorySchema = z.custom<FailureCategory>(isFailureCategory);
const timeRangeSchema = z.object({
  gte: z.number().optional(),
  gt: z.number().optional(),
  lte: z.number().optional(),
  lt: z.number().optional(),
});

export const bulkListFilterInputSchema = z.object({
  status: z.union([workflowStatusSchema, z.array(workflowStatusSchema)]).optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  attributes: z.array(attributeFilterSchema).optional(),
  limit: z.number().int().min(0).optional(),
  offset: z.number().int().min(0).optional(),
  idPrefix: z.string().optional(),
  failureCategory: z.union([failureCategorySchema, z.array(failureCategorySchema)]).optional(),
  createdAt: timeRangeSchema.optional(),
  updatedAt: timeRangeSchema.optional(),
  executionDeadline: timeRangeSchema.optional(),
});

export type BulkListFilterInput = z.infer<typeof bulkListFilterInputSchema>;

export const bulkOperationControlInputSchema = z.object({
  dryRun: z.boolean().optional(),
  confirmationToken: z.string().min(1).max(MAX_BULK_CONFIRMATION_TOKEN_LENGTH).optional(),
  requestId: z.string().min(1).max(MAX_BULK_OPERATION_REQUEST_ID_LENGTH).optional(),
});

export type BulkOperationControlInput = z.infer<typeof bulkOperationControlInputSchema>;

export const bulkOperatorAccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['workflows:admin'] },
} satisfies AccessPolicy;

export function faultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unprocessableFault(message: string): OperationFault {
  return {
    code: 'Unprocessable',
    message,
    data: { reason: message },
  };
}

export function engineFailureFault(message: string): OperationFault {
  return {
    code: 'EngineFailure',
    message,
    data: {},
  };
}

export async function readOptionalJsonBody(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    throw invalidParamsFault('Invalid JSON body');
  }
}

function isJsonSearchAttributeValue(value: unknown): value is SearchAttributeValue {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseAttributeFiltersFromBody(value: unknown): AttributeFilter[] {
  if (!Array.isArray(value)) {
    throw new Error('Field "filter.attributes" must be an array');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Field "filter.attributes[${index}]" must be an object`);
    }

    const record = entry as Record<string, unknown>;
    const key = record['key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`Field "filter.attributes[${index}].key" must be a non-empty string`);
    }

    const filter: AttributeFilter = { key };
    for (const property of ['value', 'gt', 'lt', 'gte', 'lte'] as const) {
      const attributeValue = record[property];
      if (attributeValue === undefined) {
        continue;
      }

      if (!isJsonSearchAttributeValue(attributeValue)) {
        throw new Error(
          `Field "filter.attributes[${index}].${property}" must be a string, number, boolean, or string array`,
        );
      }

      filter[property] = attributeValue;
    }

    return filter;
  });
}

function parseFilterStatus(value: unknown): ListFilter['status'] {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value as WorkflowStatus;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value as WorkflowStatus[];
  }

  throw new Error('Field "filter.status" must be a string or an array of strings');
}

function parseOptionalFilterType(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  throw new Error('Field "filter.type" must be a string');
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
  (filter: ListFilter, record: Record<string, unknown>) => void
> = [
  (filter, record) => {
    const status = parseFilterStatus(record['status']);
    if (status !== undefined) filter.status = status;
  },
  (filter, record) => {
    const type = parseOptionalFilterType(record['type']);
    if (type !== undefined) filter.type = type;
  },
  (filter, record) => {
    const tags = parseOptionalFilterTags(record['tags']);
    if (tags !== undefined) filter.tags = tags;
  },
  (filter, record) => {
    if (record['attributes'] !== undefined) {
      filter.attributes = parseAttributeFiltersFromBody(record['attributes']);
    }
  },
  (filter, record) => {
    const limit = parseOptionalFilterNumber(record['limit'], 'limit');
    if (limit !== undefined) filter.limit = limit;
  },
  (filter, record) => {
    const offset = parseOptionalFilterNumber(record['offset'], 'offset');
    if (offset !== undefined) filter.offset = offset;
  },
  (filter, record) => {
    const idPrefix = record['idPrefix'];
    if (typeof idPrefix === 'string') filter.idPrefix = idPrefix;
  },
  (filter, record) => {
    const failureCategory = parseOptionalFailureCategoryFilter(record['failureCategory']);
    if (failureCategory !== undefined) filter.failureCategory = failureCategory;
  },
  (filter, record) => {
    const createdAt = parseOptionalTimeRange(record['createdAt']);
    if (createdAt !== undefined) filter.createdAt = createdAt;
  },
  (filter, record) => {
    const updatedAt = parseOptionalTimeRange(record['updatedAt']);
    if (updatedAt !== undefined) filter.updatedAt = updatedAt;
  },
  (filter, record) => {
    const executionDeadline = parseOptionalTimeRange(record['executionDeadline']);
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

  const record = body as Record<string, unknown>;
  const rawFilter = record['filter'];
  if (rawFilter === undefined) {
    return {};
  }

  if (typeof rawFilter !== 'object' || rawFilter === null) {
    throw new Error('Field "filter" must be an object');
  }

  const filterRecord = rawFilter as Record<string, unknown>;
  const filter: ListFilter = {};
  for (const applyDimension of BULK_FILTER_DIMENSION_PARSERS) {
    applyDimension(filter, filterRecord);
  }
  return filter;
}

const TIME_RANGE_BOUNDS = ['gte', 'gt', 'lte', 'lt'] as const;

function parseOptionalTimeRange(value: unknown): TimeRange | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new Error('Time-range filter must be an object with gte/gt/lte/lt numeric bounds');
  }
  const record = value as Record<string, unknown>;
  const range: TimeRange = {};
  for (const bound of TIME_RANGE_BOUNDS) {
    const entry = record[bound];
    if (entry === undefined) continue;
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new Error(`Time-range bound "${bound}" must be a finite number`);
    }
    range[bound] = entry;
  }
  return Object.keys(range).length > 0 ? range : undefined;
}

export function parseRequiredBulkListFilter(body: unknown): ListFilter {
  try {
    return assertScopedBulkWorkflowFilter(parseBulkListFilterFromBody(body));
  } catch (error) {
    throw invalidParamsFault(faultMessage(error));
  }
}

export function listFilterFromBulkInput(input: BulkListFilterInput): ListFilter {
  const filter: ListFilter = {};
  applyBasicBulkFilterFields(filter, input);
  applyExtendedBulkFilterFields(filter, input);
  applyBulkTimeRangeFields(filter, input);
  return filter;
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
  return {
    key: attribute.key,
    ...(attribute.value === undefined ? {} : { value: attribute.value }),
    ...(attribute.gt === undefined ? {} : { gt: attribute.gt }),
    ...(attribute.lt === undefined ? {} : { lt: attribute.lt }),
    ...(attribute.gte === undefined ? {} : { gte: attribute.gte }),
    ...(attribute.lte === undefined ? {} : { lte: attribute.lte }),
  };
}

function applyExtendedBulkFilterFields(filter: ListFilter, input: BulkListFilterInput): void {
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

export function parseBulkOperationControlFromBody(body: unknown): BulkOperationControlInput {
  if (body === undefined) {
    return {};
  }

  const record = parseJsonObjectBody(body);
  const dryRun = parseOptionalBooleanControl(record, 'dryRun');
  const confirmationToken = parseOptionalNonEmptyStringControl(record, 'confirmationToken');
  const requestId = parseOptionalBulkRequestId(record);

  return {
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(confirmationToken === undefined ? {} : { confirmationToken }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

export function bulkOperationOptionsFromInput(
  input: BulkOperationControlInput,
  principal: Principal,
): BulkOperationDryRunOptions | BulkOperationCommitOptions {
  const auditPrincipal = principalToBulkOperationPrincipal(principal);
  if (input.dryRun === true) {
    return {
      dryRun: true,
      principal: auditPrincipal,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    };
  }

  if (input.confirmationToken === undefined) {
    throw invalidParamsFault('Field "confirmationToken" is required after a dry run');
  }

  return {
    confirmationToken: input.confirmationToken,
    principal: auditPrincipal,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  };
}

function principalToBulkOperationPrincipal(principal: Principal): BulkOperationPrincipal {
  if (principal.method === 'unauthenticated') {
    return { method: 'unauthenticated' };
  }

  return {
    method: principal.method,
    ...(principal.subject === undefined ? {} : { subject: principal.subject }),
  };
}

function parseJsonObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object');
  }

  return body as Record<string, unknown>;
}

function parseOptionalBooleanControl(
  record: Record<string, unknown>,
  fieldName: 'dryRun',
): boolean | undefined {
  const value = record[fieldName];
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`Field "${fieldName}" must be a boolean`);
}

function parseOptionalNonEmptyStringControl(
  record: Record<string, unknown>,
  fieldName: 'confirmationToken' | 'requestId',
): string | undefined {
  const value = record[fieldName];
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Field "${fieldName}" must be a non-empty string`);
}

function parseOptionalBulkRequestId(record: Record<string, unknown>): string | undefined {
  const requestId = parseOptionalNonEmptyStringControl(record, 'requestId');
  if (requestId === undefined) return undefined;
  if (requestId.length <= MAX_BULK_OPERATION_REQUEST_ID_LENGTH) return requestId;

  throw new Error(
    `Field "requestId" must be at most ${MAX_BULK_OPERATION_REQUEST_ID_LENGTH} characters`,
  );
}
