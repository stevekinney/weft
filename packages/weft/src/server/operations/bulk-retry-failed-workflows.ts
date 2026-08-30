import { z } from 'zod';

import { BulkOperationConfirmationError, type Engine } from '../../core/engine.ts';
import type { BulkOperationDryRunResult, BulkRetryFailedResult } from '../../core/types.ts';
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
import { validatedListFilterFromBulkInput } from './bulk-operation-helpers.ts';
import { invalidParamsFault } from './operation-helpers.ts';

const bulkRetryFailedWorkflowsInput = bulkListFilterInputSchema.merge(
  bulkOperationControlInputSchema,
);
const bulkRetryFailedWorkflowsOutput = z.unknown();

export type BulkRetryFailedWorkflowsInput = BulkListFilterInput & BulkOperationControlInput;
export type BulkRetryFailedWorkflowsOutput = BulkRetryFailedResult | BulkOperationDryRunResult;

export const bulkRetryFailedWorkflowsOperation = defineOperation<
  BulkRetryFailedWorkflowsInput,
  BulkRetryFailedWorkflowsOutput
>({
  name: 'weft.workflows.bulk.retryfailed',
  mcpExposable: false,
  summary: 'Retry failed workflows in bulk',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: bulkRetryFailedWorkflowsInput,
  outputSchema: bulkRetryFailedWorkflowsOutput as z.ZodType<BulkRetryFailedWorkflowsOutput>,
  access: bulkOperatorAccessPolicy,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<BulkRetryFailedWorkflowsOutput> => {
    const e = engine as Engine;

    const filter = validatedListFilterFromBulkInput(input);
    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      // Preserve the Engine overload split: dry-run and commit options have
      // distinct result types even though both delegate to the same operation.
      if (operationOptions.dryRun === true) {
        return await e.retryFailedAll(filter, operationOptions);
      }
      return await e.retryFailedAll(filter, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw invalidParamsFault(error.message);
      }
      throw engineFailureFault(faultMessage(error));
    }
  },
});

export const bulkRetryFailedWorkflowsRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/bulk/retry-failed',
  pathParamNames: [],
  operationName: 'weft.workflows.bulk.retryfailed',
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
