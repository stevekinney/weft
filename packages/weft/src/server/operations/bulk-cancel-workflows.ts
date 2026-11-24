import { invalidParamsFault, type UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { bulkCancelOutputSchema } from './bulk-output-schemas.ts';
import {
  assertOperationEngineMethods,
  engineFailureFault,
  faultMessage,
  readOptionalJsonBody,
} from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import { BulkOperationConfirmationError } from '../../core/engine.ts';
import type { BulkCancelResult, BulkOperationDryRunResult } from '../../core/types.ts';
import { parseBulkListFilterFromBody } from './bulk-filter-body.ts';
import { bulkListFilterInputSchema, type BulkListFilterInput } from './bulk-filter-input.ts';
import {
  bulkOperationControlInputSchema,
  bulkOperationOptionsFromInput,
  bulkOperatorAccessPolicy,
  parseBulkOperationControlFromBody,
  type BulkOperationControlInput,
} from './bulk-operation-controls.ts';
import {
  staleConfirmationFault,
  validatedListFilterFromBulkInput,
} from './bulk-operation-helpers.ts';

const bulkCancelWorkflowsInput = bulkListFilterInputSchema.merge(bulkOperationControlInputSchema);

export type BulkCancelWorkflowsInput = BulkListFilterInput & BulkOperationControlInput;
export type BulkCancelWorkflowsOutput = BulkCancelResult | BulkOperationDryRunResult;

export const bulkCancelWorkflowsOperation = defineOperation({
  name: 'weft.workflows.bulk.cancel',
  mcpExposable: false,
  summary: 'Cancel workflows in bulk',
  description:
    'Cancel every workflow that matches the filter. Run it first with `dryRun: true` ' +
    'to preview the matches and receive a `confirmationToken`, then repeat the same ' +
    'filter with that token to commit; a commit whose token no longer matches is refused ' +
    'with `Conflict`, so run the preview again. Requires workflows:admin.',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: bulkCancelWorkflowsInput,
  outputSchema: bulkCancelOutputSchema,
  producibleFaults: ['Conflict'],
  access: bulkOperatorAccessPolicy,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine, principal }): Promise<BulkCancelWorkflowsOutput> => {
    assertOperationEngineMethods(engine, ['cancelAll']);
    const e = engine;

    const filter = validatedListFilterFromBulkInput(input);
    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      if (operationOptions.dryRun === true) {
        return await e.cancelAll(filter, operationOptions);
      }
      return await e.cancelAll(filter, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw staleConfirmationFault(error);
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
