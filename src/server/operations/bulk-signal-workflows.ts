import { z } from 'zod';

import { BulkOperationConfirmationError, type Engine } from '../../core/engine.ts';
import type { BulkOperationDryRunResult, BulkSignalResult, ListFilter } from '../../core/types.ts';
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

const bulkSignalWorkflowsInput = bulkListFilterInputSchema
  .extend({
    name: z.string().min(1),
    payload: z.unknown().optional(),
  })
  .merge(bulkOperationControlInputSchema);
const bulkSignalWorkflowsOutput = z.unknown();

export type BulkSignalWorkflowsInput = z.infer<typeof bulkSignalWorkflowsInput>;
export type BulkSignalWorkflowsOutput = BulkSignalResult | BulkOperationDryRunResult;

export const bulkSignalWorkflowsOperation = defineOperation<
  BulkSignalWorkflowsInput,
  BulkSignalWorkflowsOutput
>({
  name: 'weft.workflows.bulk.signal',
  mcpExposable: false,
  summary: 'Signal workflows in bulk',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: bulkSignalWorkflowsInput,
  outputSchema: bulkSignalWorkflowsOutput as z.ZodType<BulkSignalWorkflowsOutput>,
  access: bulkOperatorAccessPolicy,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<BulkSignalWorkflowsOutput> => {
    const e = engine as Engine;

    const filter = validatedListFilterFromBulkInput(input);
    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      if (operationOptions.dryRun === true) {
        return await e.signalAll(filter, input.name, input.payload, operationOptions);
      }
      return await e.signalAll(filter, input.name, input.payload, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw invalidParamsFault(error.message);
      }
      throw engineFailureFault(faultMessage(error));
    }
  },
});

export const bulkSignalWorkflowsRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/bulk/signal',
  pathParamNames: [],
  operationName: 'weft.workflows.bulk.signal',
  inputSources: {
    name: { kind: 'body-field', bodyField: 'name' },
    payload: { kind: 'body-field', bodyField: 'payload' },
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

    const name = body['name'];
    if (typeof name !== 'string' || name.length === 0) {
      throw invalidParamsFault('Field "name" must be a non-empty string');
    }

    return {
      ...filter,
      name,
      ...(body['payload'] === undefined ? {} : { payload: body['payload'] }),
      ...parseBulkOperationControlFromBody(body),
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: BulkSignalWorkflowsOutput) => shapeBulkJsonSuccess(output),
  shapeFault: shapeRestFault,
};
