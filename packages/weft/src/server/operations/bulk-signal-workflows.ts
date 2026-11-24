import { invalidParamsFault, type UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { z } from 'zod';
import { bulkSignalOutputSchema } from './bulk-output-schemas.ts';
import {
  assertOperationEngineMethods,
  engineFailureFault,
  faultMessage,
  readOptionalJsonBody,
} from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import { BulkOperationConfirmationError } from '../../core/engine.ts';
import type { BulkOperationDryRunResult, BulkSignalResult, ListFilter } from '../../core/types.ts';
import { parseBulkListFilterFromBody } from './bulk-filter-body.ts';
import { bulkListFilterInputSchema } from './bulk-filter-input.ts';
import {
  bulkOperationControlInputSchema,
  bulkOperationOptionsFromInput,
  bulkOperatorAccessPolicy,
  parseBulkOperationControlFromBody,
} from './bulk-operation-controls.ts';
import {
  staleConfirmationFault,
  validatedListFilterFromBulkInput,
} from './bulk-operation-helpers.ts';

const bulkSignalWorkflowsInput = bulkListFilterInputSchema
  .extend({
    name: z.string().min(1).describe('Name of the signal to deliver.'),
    payload: z.unknown().optional().describe('Payload delivered with the signal.'),
  })
  .merge(bulkOperationControlInputSchema);

export type BulkSignalWorkflowsInput = z.infer<typeof bulkSignalWorkflowsInput>;
export type BulkSignalWorkflowsOutput = BulkSignalResult | BulkOperationDryRunResult;

export const bulkSignalWorkflowsOperation = defineOperation({
  name: 'weft.workflows.bulk.signal',
  mcpExposable: false,
  summary: 'Signal workflows in bulk',
  description:
    'Deliver the signal `name` with an optional `payload` to every workflow that ' +
    'matches the filter. Run it first with `dryRun: true` to preview the matches and ' +
    'receive a `confirmationToken`, then repeat the same request with that token to ' +
    'commit; a commit whose token no longer matches is refused with `Conflict`, so run the ' +
    'preview again. Requires workflows:admin.',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: bulkSignalWorkflowsInput,
  outputSchema: bulkSignalOutputSchema,
  producibleFaults: ['Conflict'],
  access: bulkOperatorAccessPolicy,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine, principal }): Promise<BulkSignalWorkflowsOutput> => {
    assertOperationEngineMethods(engine, ['signalAll']);
    const e = engine;

    const filter = validatedListFilterFromBulkInput(input);
    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      if (operationOptions.dryRun === true) {
        return await e.signalAll(filter, input.name, input.payload, operationOptions);
      }
      return await e.signalAll(filter, input.name, input.payload, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw staleConfirmationFault(error);
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

    const name = Reflect.get(body, 'name');
    if (typeof name !== 'string' || name.length === 0) {
      throw invalidParamsFault('Field "name" must be a non-empty string');
    }

    return {
      ...filter,
      name,
      ...(Reflect.get(body, 'payload') === undefined
        ? {}
        : { payload: Reflect.get(body, 'payload') }),
      ...parseBulkOperationControlFromBody(body),
    };
  },
  success: { kind: 'json', status: 200 },
};
