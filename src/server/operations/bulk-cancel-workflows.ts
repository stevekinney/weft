import { z } from 'zod';

import { BulkOperationConfirmationError, type Engine } from '../../core/engine.ts';
import type { BulkCancelResult, BulkOperationDryRunResult } from '../../core/types.ts';
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
  type BulkListFilterInput,
  type BulkOperationControlInput,
} from './bulk-filter-helpers.ts';
import {
  shapeBulkJsonSuccess,
  validatedListFilterFromBulkInput,
} from './bulk-operation-helpers.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

const bulkCancelWorkflowsInput = bulkListFilterInputSchema.merge(bulkOperationControlInputSchema);
const bulkCancelWorkflowsOutput = z.unknown();

export type BulkCancelWorkflowsInput = BulkListFilterInput & BulkOperationControlInput;
export type BulkCancelWorkflowsOutput = BulkCancelResult | BulkOperationDryRunResult;

export const bulkCancelWorkflowsOperation = defineOperation<
  BulkCancelWorkflowsInput,
  BulkCancelWorkflowsOutput
>({
  name: 'weft.workflows.bulk.cancel',
  mcpExposable: false,
  summary: 'Cancel workflows in bulk',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: bulkCancelWorkflowsInput,
  outputSchema: bulkCancelWorkflowsOutput as z.ZodType<BulkCancelWorkflowsOutput>,
  access: bulkOperatorAccessPolicy,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<BulkCancelWorkflowsOutput> => {
    const e = engine as Engine;

    const filter = validatedListFilterFromBulkInput(input);
    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      if (operationOptions.dryRun === true) {
        return await e.cancelAll(filter, operationOptions);
      }
      return await e.cancelAll(filter, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw invalidParamsFault(error.message);
      }
      throw engineFailureFault(faultMessage(error));
    }
  },
});

export const bulkCancelWorkflowsRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/bulk/cancel',
  pathParamNames: [],
  operationName: 'weft.workflows.bulk.cancel',
  inputSources: {},
  extractInput: async (request) => {
    const raw = await readOptionalJsonBody(request);

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
  shapeSuccess: (output: BulkCancelWorkflowsOutput) => shapeBulkJsonSuccess(output),
  shapeFault: shapeRestFault,
};
