import { invalidParamsFault, type UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { bulkDeleteOutputSchema } from './bulk-output-schemas.ts';
import {
  assertOperationEngineMethods,
  engineFailureFault,
  faultMessage,
  readOptionalJsonBody,
  unprocessableFault,
} from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import {
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
} from '../../core/engine.ts';
import type { BulkDeleteResult, BulkOperationDryRunResult } from '../../core/types.ts';
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

const bulkDeleteWorkflowsInput = bulkListFilterInputSchema.merge(bulkOperationControlInputSchema);

export type BulkDeleteWorkflowsInput = BulkListFilterInput & BulkOperationControlInput;
export type BulkDeleteWorkflowsOutput = BulkDeleteResult | BulkOperationDryRunResult;

export const bulkDeleteWorkflowsOperation = defineOperation({
  name: 'weft.workflows.bulk.delete',
  mcpExposable: false,
  summary: 'Delete terminal workflows in bulk',
  description:
    'Delete every terminal workflow that matches the filter. Irreversible. Run it ' +
    'first with `dryRun: true` to preview the matches and receive a ' +
    '`confirmationToken`, then repeat the same filter with that token to commit; a ' +
    'commit whose token no longer matches is refused with `Conflict`, so run the ' +
    'preview again. Requires workflows:admin.',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: bulkDeleteWorkflowsInput,
  outputSchema: bulkDeleteOutputSchema,
  access: bulkOperatorAccessPolicy,
  producibleFaults: ['Conflict', 'Unprocessable'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine, principal }): Promise<BulkDeleteWorkflowsOutput> => {
    assertOperationEngineMethods(engine, ['deleteAll']);
    const e = engine;

    const filter = validatedListFilterFromBulkInput(input);
    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      if (operationOptions.dryRun === true) {
        return await e.deleteAll(filter, operationOptions);
      }
      return await e.deleteAll(filter, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw staleConfirmationFault(error);
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
