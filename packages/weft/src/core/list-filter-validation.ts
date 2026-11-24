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
    gte: z.number().optional().describe('Inclusive lower bound, as a millisecond timestamp.'),
    lte: z.number().optional().describe('Inclusive upper bound, as a millisecond timestamp.'),
    gt: z.number().optional().describe('Exclusive lower bound, as a millisecond timestamp.'),
    lt: z.number().optional().describe('Exclusive upper bound, as a millisecond timestamp.'),
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
 * The wire description of each {@link ListFilter} field, shared by every
 * operation that accepts the filter (list, aggregate, purge, and the bulk
 * operations) so a field reads the same wherever it appears.
 */
export const listFilterDescriptions = {
  status: 'Return only workflows in this status, or in any of these statuses.',
  type: 'Return only workflows of this registered workflow type.',
  scheduleId: 'Return only workflows started by the schedule with this id.',
  parentWorkflowId: 'Return only direct children of the workflow with this id.',
  parentWorkflowExecutionToken:
    'Narrow parentWorkflowId to one execution of the parent. Requires parentWorkflowId.',
  tags: 'Return only workflows that carry every one of these tags.',
  attributes: 'Return only workflows whose search attributes satisfy every one of these filters.',
  limit: 'Maximum number of workflows to return, 1 to 1000.',
  offset: 'Number of matching workflows to skip before the first one returned, for paging.',
  idPrefix: 'Return only workflows whose id starts with this prefix: letters, digits, "_" and "-".',
  createdAt: 'Return only workflows created within this time range.',
  updatedAt: 'Return only workflows last updated within this time range.',
  executionDeadline: 'Return only workflows whose execution deadline falls within this time range.',
  failureCategory:
    'Return only failed workflows in this failure category, or in any of these categories.',
  failedStep:
    'Return only failed workflows that stopped at the step with this operation label (an activity name, for one).',
  retrying:
    'true returns only running workflows that are retrying an activity from its second attempt on; false returns the workflows that are not.',
} as const;

/**
 * Concrete object schema for {@link ListFilter}. Supports `.omit()` and
 * `.extend()` for composition (used by the aggregate operation).
 */
export const listFilterObjectSchema = z
  .object({
    status: z
      .union([workflowStatusSchema, z.array(workflowStatusSchema)])
      .optional()
      .describe(listFilterDescriptions.status),
    type: z.string().min(1).optional().describe(listFilterDescriptions.type),
    scheduleId: z.string().min(1).optional().describe(listFilterDescriptions.scheduleId),
    parentWorkflowId: z
      .string()
      .min(1)
      .optional()
      .describe(listFilterDescriptions.parentWorkflowId),
    parentWorkflowExecutionToken: z
      .string()
      .min(1)
      .optional()
      .describe(listFilterDescriptions.parentWorkflowExecutionToken),
    tags: z.array(z.string()).optional().describe(listFilterDescriptions.tags),
    attributes: z
      .array(attributeFilterSchema)
      .optional()
      .describe(listFilterDescriptions.attributes),
    limit: z.number().int().min(1).max(1000).optional().describe(listFilterDescriptions.limit),
    offset: z.number().int().min(0).optional().describe(listFilterDescriptions.offset),
    idPrefix: z
      .string()
      .min(1)
      .regex(ID_PREFIX_PATTERN, 'idPrefix must match [A-Za-z0-9_-]+')
      .optional()
      .describe(listFilterDescriptions.idPrefix),
    createdAt: timeRangeSchema.optional().describe(listFilterDescriptions.createdAt),
    updatedAt: timeRangeSchema.optional().describe(listFilterDescriptions.updatedAt),
    executionDeadline: timeRangeSchema
      .optional()
      .describe(listFilterDescriptions.executionDeadline),
    failureCategory: z
      .union([failureCategorySchema, z.array(failureCategorySchema).min(1)])
      .optional()
      .describe(listFilterDescriptions.failureCategory),
    failedStep: z.string().min(1).optional().describe(listFilterDescriptions.failedStep),
    retrying: z.boolean().optional().describe(listFilterDescriptions.retrying),
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
