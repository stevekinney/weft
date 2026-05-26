import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { WorkflowListScanCapExceededError } from '../../core/engine/workflow-indexes.ts';
import {
  ListFilterValidationError,
  normalizeListFilter,
} from '../../core/list-filter-validation.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type {
  FailureCategory,
  ListFilter,
  PaginatedResult,
  SearchAttributeValue,
  WorkflowStatus,
  WorkflowSummary,
} from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { extractListFilterFromQuery } from './list-filter-query-extractor.ts';
import { jsonErrorResponse, shapeRestFault } from './operation-helpers.ts';

const workflowStatusSchema = z.custom<WorkflowStatus>((value) => typeof value === 'string');
const failureCategorySchema = z.custom<FailureCategory>((value) => typeof value === 'string');
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
const timeRangeSchema = z.object({
  gte: z.number().optional(),
  gt: z.number().optional(),
  lte: z.number().optional(),
  lt: z.number().optional(),
});
const listIncludeSchema = z
  .union([z.string(), z.array(z.string()).min(1)])
  .refine(
    (value) =>
      Array.isArray(value)
        ? value.every((entry) => entry === 'failureCategory')
        : value === 'failureCategory',
    { message: 'include must be "failureCategory"' },
  );

const listWorkflowsInput = z.object({
  status: z.union([workflowStatusSchema, z.array(workflowStatusSchema)]).optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  attributes: z.array(attributeFilterSchema).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
  idPrefix: z.string().optional(),
  createdAt: timeRangeSchema.optional(),
  updatedAt: timeRangeSchema.optional(),
  executionDeadline: timeRangeSchema.optional(),
  failureCategory: z.union([failureCategorySchema, z.array(failureCategorySchema)]).optional(),
  include: listIncludeSchema.optional(),
});
const listWorkflowsOutput = z.unknown();

export type ListWorkflowsInput = z.infer<typeof listWorkflowsInput>;
export type ListWorkflowsOutput = PaginatedResult<WorkflowSummary>;

export const listWorkflowsOperation = defineOperation<ListWorkflowsInput, ListWorkflowsOutput>({
  name: 'weft.workflows.list',
  mcpExposable: false,
  summary: 'List workflows',
  tags: ['Workflows'],
  inputSchema: listWorkflowsInput,
  outputSchema: listWorkflowsOutput as z.ZodType<ListWorkflowsOutput>,
  access: { kind: 'public' },
  producibleFaults: ['Unprocessable'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ListWorkflowsOutput> => {
    const e = engine as Engine;
    const { include, ...filterInput } = input;

    // Tag validation lives in `invoke` (not in the REST extractor)
    // so every transport — REST, JSON-RPC HTTP/WS/stdio — gets the
    // same enforcement. A previous version validated only inside
    // `extractListWorkflowsInput`, which let JSON-RPC clients send
    // `{tags: ['']}` and bypass `coerceStartWorkflowTags`.
    let validatedTags: string[] | undefined;
    if (filterInput.tags !== undefined) {
      try {
        validatedTags = coerceStartWorkflowTags(filterInput.tags, 'tags');
      } catch (error) {
        throw toUnprocessable(error);
      }
    }

    let filter: ListFilter;
    try {
      filter = normalizeListFilter({
        ...filterInput,
        ...(validatedTags !== undefined ? { tags: validatedTags } : {}),
      });
    } catch (error) {
      if (error instanceof ListFilterValidationError) throw toUnprocessable(error);
      throw error;
    }

    try {
      const includeFailureCategory = Array.isArray(include)
        ? include.includes('failureCategory')
        : include === 'failureCategory';
      return await e.list(
        filter,
        includeFailureCategory ? { includeFailureCategory: true } : undefined,
      );
    } catch (error) {
      if (error instanceof WorkflowListScanCapExceededError) throw toUnprocessable(error);
      throw error;
    }
  },
});

function toUnprocessable(error: unknown): OperationFault {
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'Unprocessable', message, data: { reason: message } };
}

function extractListWorkflowsInput(request: Request): ListWorkflowsInput {
  const url = new URL(request.url);
  const filter = extractListFilterFromQuery(url) as ListWorkflowsInput;

  const limit = url.searchParams.get('limit');
  if (limit !== null) {
    const parsed = Number(limit);
    if (Number.isFinite(parsed) && parsed >= 1) {
      filter.limit = Math.min(Math.floor(parsed), 1000);
    }
  }

  const offset = url.searchParams.get('offset');
  if (offset !== null) {
    const parsed = Number(offset);
    if (Number.isFinite(parsed) && parsed >= 0) {
      filter.offset = Math.floor(parsed);
    }
  }

  const includes = url.searchParams.getAll('include');
  if (includes.length === 1) {
    filter.include = includes[0]!;
  } else if (includes.length > 1) {
    filter.include = includes;
  }

  return filter;
}

function shapeListWorkflowsSuccess(result: ListWorkflowsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeListWorkflowsFault(fault: OperationFault): Response {
  // Workflow listing reports invalid filter values as 400 even when
  // the transport-neutral fault is `Unprocessable`.
  if (fault.code === 'Unprocessable') {
    return jsonErrorResponse(fault.message, 400);
  }
  return shapeRestFault(fault);
}

export const listWorkflowsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows',
  pathParamNames: [],
  operationName: 'weft.workflows.list',
  inputSources: {
    status: { kind: 'query', queryParam: 'status', repeating: true },
    type: { kind: 'query', queryParam: 'type' },
    tags: { kind: 'query', queryParam: 'tag', repeating: true },
    limit: { kind: 'query', queryParam: 'limit' },
    offset: { kind: 'query', queryParam: 'offset' },
    include: { kind: 'query', queryParam: 'include', repeating: true },
  },
  extractInput: async (request) => extractListWorkflowsInput(request),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: ListWorkflowsOutput) => shapeListWorkflowsSuccess(output),
  shapeFault: shapeListWorkflowsFault,
};
