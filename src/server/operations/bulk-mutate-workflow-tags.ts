import { z } from 'zod';

import { BulkOperationConfirmationError, type Engine } from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type {
  BulkOperationCommitOptions,
  BulkOperationDryRunOptions,
  BulkOperationDryRunResult,
  BulkTagResult,
  ListFilter,
} from '../../core/types.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  bulkListFilterInputSchema,
  bulkOperationControlInputSchema,
  bulkOperationOptionsFromInput,
  bulkOperatorAccessPolicy,
  engineFailureFault,
  faultMessage,
  parseBulkListFilterFromBody,
  parseBulkOperationControlFromBody,
  readOptionalJsonBody,
} from './bulk-filter-helpers.ts';
import {
  shapeBulkJsonSuccess,
  validatedListFilterFromBulkInput,
} from './bulk-operation-helpers.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

const bulkMutateWorkflowTagsInput = z
  .object({
    filter: bulkListFilterInputSchema.optional(),
    tags: z.array(z.string()),
    operation: z.enum(['add', 'remove']),
  })
  .merge(bulkOperationControlInputSchema);
const bulkMutateWorkflowTagsOutput = z.unknown();

export type BulkMutateWorkflowTagsInput = z.infer<typeof bulkMutateWorkflowTagsInput>;
export type BulkMutateWorkflowTagsOutput = BulkTagResult | BulkOperationDryRunResult;

export const bulkMutateWorkflowTagsOperation = defineOperation<
  BulkMutateWorkflowTagsInput,
  BulkMutateWorkflowTagsOutput
>({
  name: 'weft.workflows.bulk.tags',
  mcpExposable: false,
  summary: 'Add or remove workflow tags in bulk',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: bulkMutateWorkflowTagsInput,
  outputSchema: bulkMutateWorkflowTagsOutput as z.ZodType<BulkMutateWorkflowTagsOutput>,
  access: bulkOperatorAccessPolicy,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<BulkMutateWorkflowTagsOutput> => {
    const e = engine as Engine;

    const filter = validatedListFilterFromBulkInput(input.filter ?? {});

    let validatedTags: string[];
    try {
      validatedTags = coerceStartWorkflowTags(input.tags, 'Field "tags"');
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      return await executeBulkTagMutation(
        e,
        filter,
        validatedTags,
        input.operation,
        operationOptions,
      );
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw invalidParamsFault(error.message);
      }
      throw engineFailureFault(faultMessage(error));
    }
  },
});

async function executeBulkTagMutation(
  engine: Engine,
  filter: ListFilter,
  tags: string[],
  operation: 'add' | 'remove',
  options: BulkOperationDryRunOptions | BulkOperationCommitOptions,
): Promise<BulkMutateWorkflowTagsOutput> {
  if (options.dryRun === true) {
    return operation === 'add'
      ? await engine.tagAll(filter, tags, options)
      : await engine.untagAll(filter, tags, options);
  }

  return operation === 'add'
    ? await engine.tagAll(filter, tags, options)
    : await engine.untagAll(filter, tags, options);
}

export const bulkMutateWorkflowTagsRestBinding: UnknownRestBinding = {
  method: 'PATCH',
  path: '/v1/workflows/bulk/tags',
  pathParamNames: [],
  operationName: 'weft.workflows.bulk.tags',
  inputSources: {
    filter: { kind: 'body-field', bodyField: 'filter' },
    tags: { kind: 'body-field', bodyField: 'tags' },
    operation: { kind: 'body-field', bodyField: 'operation' },
  },
  extractInput: async (request) => {
    const raw = await readOptionalJsonBody(request);
    if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const body = raw as Record<string, unknown>;
    let filter: ListFilter;
    try {
      filter = { ...parseBulkListFilterFromBody(body) };
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    let tags: string[];
    try {
      tags = coerceStartWorkflowTags(body['tags'], 'Field "tags"');
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    const operation = body['operation'];
    if (operation !== 'add' && operation !== 'remove') {
      throw invalidParamsFault('Field "operation" must be "add" or "remove"');
    }

    return {
      filter,
      tags,
      operation,
      ...parseBulkOperationControlFromBody(body),
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: BulkMutateWorkflowTagsOutput) => shapeBulkJsonSuccess(output),
  shapeFault: shapeRestFault,
};
