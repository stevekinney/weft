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
import type { FailureCategory, WorkflowStatus } from './types/identity.ts';
import type { ListFilter } from './types/list-options.ts';
import { flattenZodIssue, type ValidationIssue } from './validation-issues.ts';
import { WeftError } from './weft-error.ts';

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

const workflowStatusSchema: z.ZodType<WorkflowStatus> = z.enum(WORKFLOW_STATUSES);
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

// Search-attribute filters retain the existing permissive shape — they are not
// the focus of this validation module. Visibility-filter callers validate
// attribute names elsewhere (in the engine and aggregate path).
const searchAttributeValueSchema: z.ZodType = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.date(),
  z.array(z.string()),
]);

const attributeFilterSchema = z.object({
  key: z.union([z.string().min(1), z.any()]),
  value: searchAttributeValueSchema.optional(),
  gt: searchAttributeValueSchema.optional(),
  lt: searchAttributeValueSchema.optional(),
  gte: searchAttributeValueSchema.optional(),
  lte: searchAttributeValueSchema.optional(),
});

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
 * Thrown by {@link normalizeListFilter} when the input fails validation.
 * Carries flattened Zod issues so transport adapters can map directly to the
 * existing `InvalidParams` fault shape.
 */
export class ListFilterValidationError extends WeftError<'ListFilterValidationError'> {
  readonly issues: ReadonlyArray<FilterValidationIssue>;

  constructor(issues: ReadonlyArray<FilterValidationIssue>) {
    const summary = issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    super('ListFilterValidationError', summary.length > 0 ? summary : 'Invalid list filter');
    this.issues = issues;
  }
}

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
  return result.data as ListFilter;
}

export { isFailureCategory };
