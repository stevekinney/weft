import { z } from 'zod';

import {
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  type Engine,
} from '../../core/engine.ts';
import type { BulkDeleteResult, BulkOperationDryRunResult } from '../../core/types.ts';
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
  unprocessableFault,
  type BulkListFilterInput,
  type BulkOperationControlInput,
} from './bulk-filter-helpers.ts';
import { validatedListFilterFromBulkInput } from './bulk-operation-helpers.ts';
import { invalidParamsFault } from './operation-helpers.ts';

const bulkDeleteWorkflowsInput = bulkListFilterInputSchema.merge(bulkOperationControlInputSchema);
const bulkDeleteWorkflowsOutput = z.unknown();

export type BulkDeleteWorkflowsInput = BulkListFilterInput & BulkOperationControlInput;
export type BulkDeleteWorkflowsOutput = BulkDeleteResult | BulkOperationDryRunResult;

export const bulkDeleteWorkflowsOperation = defineOperation<
  BulkDeleteWorkflowsInput,
  BulkDeleteWorkflowsOutput
>({
  name: 'weft.workflows.bulk.delete',
  mcpExposable: false,
  summary: 'Delete terminal workflows in bulk',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: bulkDeleteWorkflowsInput,
  outputSchema: bulkDeleteWorkflowsOutput as z.ZodType<BulkDeleteWorkflowsOutput>,
  access: bulkOperatorAccessPolicy,
  producibleFaults: ['Unprocessable'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<BulkDeleteWorkflowsOutput> => {
    const e = engine as Engine;

    const filter = validatedListFilterFromBulkInput(input);
    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      if (operationOptions.dryRun === true) {
        return await e.deleteAll(filter, operationOptions);
      }
      return await e.deleteAll(filter, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw invalidParamsFault(error.message);
      }
      if (error instanceof BulkDeleteRequiresTerminalWorkflowsError) {
        throw unprocessableFault(error.message);
      }

      throw engineFailureFault(faultMessage(error));
    }
  },
});

export const bulkDeleteWorkflowsRestBinding: UnknownRestBinding = {
  method: 'DELETE',
  path: '/v1/workflows/bulk',
  pathParamNames: [],
  operationName: 'weft.workflows.bulk.delete',
  inputSources: {},
  extractInput: async (request, _pathParams, context) => {
    const raw = await readOptionalJsonBody(request, context);

    try {
      return {
        ...parseBulkListFilterFromBody(raw),
        ...parseBulkOperationControlFromBody(raw),
      };
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }
  },
  success: { kind: 'json', status: 200 },
};
