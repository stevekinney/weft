import { z } from 'zod';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { WorkflowListScanCapExceededError } from '../../core/engine/workflow-indexes.ts';
import { ListFilterValidationError } from '../../core/list-filter-validation-error.ts';
import {
  listFilterDescriptions,
  listFilterObjectSchema,
  normalizeListFilter,
} from '../../core/list-filter-validation.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type { ListFilter, PaginatedResult, WorkflowSummary } from '../../core/types.ts';
import { extractListFilterFromQuery } from './list-filter-query-extractor.ts';
import { assertOperationEngineMethods, shapeRestFault } from './operation-helpers.ts';

const listIncludeSchema = z
  .union([z.string(), z.array(z.string()).min(1)])
  .refine(
    (value) =>
      Array.isArray(value)
        ? value.every((entry) => entry === 'failureCategory')
        : value === 'failureCategory',
    { message: 'include must be "failureCategory"' },
  );

const listWorkflowsInput = z
  .object({
    ...listFilterObjectSchema.shape,
    // Transport parsing stays permissive; invoke owns canonical validation and
    // preserves the existing field-specific fault envelope.
    status: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(listFilterDescriptions.status),
    type: z.string().optional().describe(listFilterDescriptions.type),
    idPrefix: z.string().optional().describe(listFilterDescriptions.idPrefix),
    createdAt: z
      .object(listFilterObjectSchema.shape.createdAt.unwrap().shape)
      .strict()
      .optional()
      .describe(listFilterDescriptions.createdAt),
    updatedAt: z
      .object(listFilterObjectSchema.shape.updatedAt.unwrap().shape)
      .strict()
      .optional()
      .describe(listFilterDescriptions.updatedAt),
    executionDeadline: z
      .object(listFilterObjectSchema.shape.executionDeadline.unwrap().shape)
      .strict()
      .optional()
      .describe(listFilterDescriptions.executionDeadline),
    failureCategory: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(listFilterDescriptions.failureCategory),
    include: listIncludeSchema
      .optional()
      .describe(
        'Extra data to attach to each summary. Only "failureCategory" is supported, as one value or an array.',
      ),
  })
  .strict();
const listWorkflowsOutput = z.unknown();

export type ListWorkflowsInput = z.infer<typeof listWorkflowsInput>;
export type ListWorkflowsOutput = PaginatedResult<WorkflowSummary>;

export const listWorkflowsOperation = defineOperation({
  name: 'weft.workflows.list',
  mcpExposable: false,
  summary: 'List workflows',
  description:
    'List workflows visible to the caller, optionally filtered by status, type, originating ' +
    'schedule, direct parent run, tags, id prefix, failure category, failing step, whether an ' +
    'activity is being retried, and time range, with pagination via ' +
    '`limit`/`offset`. ' +
    'Read-only. Returns the matching workflow summaries in the engine default ordering.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: listWorkflowsInput,
  outputSchema: listWorkflowsOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
  discoverable: true,
  producibleFaults: ['Unprocessable'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<ListWorkflowsOutput> => {
    assertOperationEngineMethods(engine, ['list']);
    const e = engine;
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
      // `normalizeListFilter` raises only `ListFilterValidationError` for any input the operation
      // schema lets through; anything else is a defect and propagates untouched.
      throw error instanceof ListFilterValidationError ? toUnprocessable(error) : error;
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

function extractListWorkflowsInput(request: Request) {
  const url = new URL(request.url);
  const filter = extractListFilterFromQuery(url);

  const limitValue = parseOptionalInteger(url.searchParams.get('limit'), 1, 1000);
  const offsetValue = parseOptionalInteger(url.searchParams.get('offset'), 0);

  const includes = url.searchParams.getAll('include');
  const include = includes.length === 1 ? includes[0] : includes.length > 1 ? includes : undefined;

  return {
    ...filter,
    ...(limitValue === undefined ? {} : { limit: limitValue }),
    ...(offsetValue === undefined ? {} : { offset: offsetValue }),
    ...(include === undefined ? {} : { include }),
  };
}

function parseOptionalInteger(value: string | null, minimum: number, maximum?: number) {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return undefined;
  const integer = Math.floor(parsed);
  return maximum === undefined ? integer : Math.min(integer, maximum);
}

function shapeListWorkflowsFault(fault: OperationFault): Response {
  // Workflow listing reports invalid filter values as 400 even when
  // the transport-neutral fault is `Unprocessable`.
  if (fault.code === 'Unprocessable') {
    return shapeRestFault(fault, { status: 400 });
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
    scheduleId: { kind: 'query', queryParam: 'schedule_id' },
    parentWorkflowId: { kind: 'query', queryParam: 'parent_workflow_id' },
    parentWorkflowExecutionToken: {
      kind: 'query',
      queryParam: 'parent_workflow_execution_token',
    },
    tags: { kind: 'query', queryParam: 'tag', repeating: true },
    failureCategory: { kind: 'query', queryParam: 'failure_category', repeating: true },
    failedStep: { kind: 'query', queryParam: 'failed_step' },
    retrying: { kind: 'query', queryParam: 'retrying' },
    limit: { kind: 'query', queryParam: 'limit' },
    offset: { kind: 'query', queryParam: 'offset' },
    include: { kind: 'query', queryParam: 'include', repeating: true },
  },
  extractInput: async (request) => extractListWorkflowsInput(request),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeListWorkflowsFault,
};
