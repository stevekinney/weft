/**
 * Canonical schema and normalizer for {@link ListFilter}. Lives in `core/` so
 * `engine.list()`, `engine.aggregate()`, and every transport (REST, JSON-RPC
 * HTTP/WS/stdio) share one validation path.
 *
 * `listFilterObjectSchema` is the concrete `z.ZodObject` shape — required
 * because `aggregate-workflows.ts` composes it with `.omit({ limit, offset })`.
 *
 * @module core/list-filter-validation
 */

import { z } from 'zod';

import { FAILURE_CATEGORIES, isFailureCategory } from './failure-categories.ts';
import {
  attributeFilterSchema,
  normalizeAttributeFilter,
} from './list-filter-attribute-validation.ts';
import { ListFilterValidationError } from './list-filter-validation-error.ts';
import type { FailureCategory, WorkflowStatus } from './types/identity.ts';
import type { ListFilter, TimeRange } from './types/list-options.ts';
import { flattenZodIssue, type ValidationIssue } from './validation-issues.ts';

const WORKFLOW_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
  'suspended',
] as const satisfies readonly WorkflowStatus[];

const ID_PREFIX_PATTERN = /^[A-Za-z0-9_-]+$/;
export const workflowStatusSchema: z.ZodType<WorkflowStatus> = z.enum(WORKFLOW_STATUSES);
const failureCategorySchema: z.ZodType<FailureCategory> = z.enum(FAILURE_CATEGORIES);

const timeRangeSchema = z
  .object({
    gte: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    lt: z.number().optional(),
  })
  .strict()
  .refine(
    (range) =>
      range.gte !== undefined ||
      range.gt !== undefined ||
      range.lte !== undefined ||
      range.lt !== undefined,
    { message: 'TimeRange must specify at least one of gte, gt, lte, lt' },
  )
  .refine((range) => !(range.gte !== undefined && range.gt !== undefined), {
    message: 'TimeRange may not set both gte and gt',
  })
  .refine((range) => !(range.lte !== undefined && range.lt !== undefined), {
    message: 'TimeRange may not set both lte and lt',
  });

function normalizeTimeRange(range: z.infer<typeof timeRangeSchema>): TimeRange {
  return { ...range };
}

function normalizeAttributes(
  attributes: z.infer<typeof attributeFilterSchema>[] | undefined,
  hasAttributesField: boolean,
): Pick<ListFilter, 'attributes'> {
  if (attributes === undefined) {
    return hasAttributesField ? { attributes: undefined } : {};
  }
  return { attributes: attributes.map(normalizeAttributeFilter) };
}

/**
 * Concrete object schema for {@link ListFilter}. Supports `.omit()` and
 * `.extend()` for composition (used by the aggregate operation).
 */
export const listFilterObjectSchema = z
  .object({
    status: z.union([workflowStatusSchema, z.array(workflowStatusSchema)]).optional(),
    type: z.string().min(1).optional(),
    scheduleId: z.string().min(1).optional(),
    parentWorkflowId: z.string().min(1).optional(),
    parentWorkflowExecutionToken: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    attributes: z.array(attributeFilterSchema).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
    idPrefix: z
      .string()
      .min(1)
      .regex(ID_PREFIX_PATTERN, 'idPrefix must match [A-Za-z0-9_-]+')
      .optional(),
    createdAt: timeRangeSchema.optional(),
    updatedAt: timeRangeSchema.optional(),
    executionDeadline: timeRangeSchema.optional(),
    failureCategory: z
      .union([failureCategorySchema, z.array(failureCategorySchema).min(1)])
      .optional(),
  })
  .strict();

/** A flattened Zod issue suitable for cross-transport serialization. */
export type FilterValidationIssue = ValidationIssue;

/**
 * Parse and validate a {@link ListFilter}. Returns a typed copy on success;
 * throws {@link ListFilterValidationError} on failure with structured issues.
 *
 * @param input — untrusted filter input (REST query payload, JSON-RPC params,
 *   or an in-process caller's filter object).
 */
export function normalizeListFilter(input: unknown): ListFilter {
  const result = listFilterObjectSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new ListFilterValidationError(result.error.issues.map(flattenZodIssue));
  }
  if (
    result.data.parentWorkflowExecutionToken !== undefined &&
    result.data.parentWorkflowId === undefined
  ) {
    throw new ListFilterValidationError([
      {
        path: ['parentWorkflowExecutionToken'],
        message: 'parentWorkflowExecutionToken requires parentWorkflowId',
        code: 'custom',
      },
    ]);
  }
  const { attributes, ...filterFields } = result.data;
  const normalized: ListFilter = {
    ...filterFields,
    ...normalizeAttributes(attributes, 'attributes' in result.data),
    ...(filterFields.createdAt === undefined
      ? {}
      : { createdAt: normalizeTimeRange(filterFields.createdAt) }),
    ...(filterFields.updatedAt === undefined
      ? {}
      : { updatedAt: normalizeTimeRange(filterFields.updatedAt) }),
    ...(filterFields.executionDeadline === undefined
      ? {}
      : { executionDeadline: normalizeTimeRange(filterFields.executionDeadline) }),
  };
  return normalized;
}

export { isFailureCategory };
