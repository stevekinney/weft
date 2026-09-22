import { z } from 'zod';
import { bulkTagOutputSchema } from './bulk-output-schemas.ts';
import {
  assertOperationEngineMethods,
  engineFailureFault,
  faultMessage,
  invalidParamsFault,
  readOptionalJsonBody,
} from './operation-helpers.ts';

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
import { parseBulkListFilterFromBody } from './bulk-filter-body.ts';
import { bulkListFilterInputSchema } from './bulk-filter-input.ts';
import {
  bulkOperationControlInputSchema,
  bulkOperationOptionsFromInput,
  bulkOperatorAccessPolicy,
  parseBulkOperationControlFromBody,
} from './bulk-operation-controls.ts';
import { validatedListFilterFromBulkInput } from './bulk-operation-helpers.ts';

const bulkMutateWorkflowTagsInput = z
  .object({
    filter: bulkListFilterInputSchema.optional(),
    tags: z.array(z.string()),
    operation: z.enum(['add', 'remove']),
  })
  .merge(bulkOperationControlInputSchema);

export type BulkMutateWorkflowTagsInput = z.infer<typeof bulkMutateWorkflowTagsInput>;
export type BulkMutateWorkflowTagsOutput = BulkTagResult | BulkOperationDryRunResult;

export const bulkMutateWorkflowTagsOperation = defineOperation({
  name: 'weft.workflows.bulk.tags',
  mcpExposable: false,
  summary: 'Add or remove workflow tags in bulk',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: bulkMutateWorkflowTagsInput,
  outputSchema: bulkTagOutputSchema,
  access: bulkOperatorAccessPolicy,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<BulkMutateWorkflowTagsOutput> => {
    assertOperationEngineMethods(engine, ['tagAll', 'untagAll']);
    const e = engine;

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
  engine: Pick<Engine, 'tagAll' | 'untagAll'>,
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
  extractInput: async (request, _pathParams, context) => {
    const raw = await readOptionalJsonBody(request, context);
    if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const body = raw;
    let filter: ListFilter;
    try {
      filter = { ...parseBulkListFilterFromBody(body) };
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    let tags: string[];
    try {
      tags = coerceStartWorkflowTags(Reflect.get(body, 'tags'), 'Field "tags"');
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    const operation = Reflect.get(body, 'operation');
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
};
