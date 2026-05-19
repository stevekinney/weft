import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type { PurgeResult } from '../../core/types.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  bulkListFilterInputSchema,
  faultMessage,
  listFilterFromBulkInput,
  parseBulkListFilterFromBody,
  readOptionalJsonBody,
  type BulkListFilterInput,
} from './bulk-filter-helpers.ts';
import { shapeBulkJsonSuccess } from './bulk-operation-helpers.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

const purgeWorkflowsOutput = z.unknown();

export type PurgeWorkflowsInput = BulkListFilterInput;
export type PurgeWorkflowsOutput = PurgeResult;

export const purgeWorkflowsOperation = defineOperation<PurgeWorkflowsInput, PurgeWorkflowsOutput>({
  name: 'weft.workflows.purge',
  mcpExposable: false,
  summary: 'Purge terminal workflows',
  tags: ['Workflows'],
  inputSchema: bulkListFilterInputSchema,
  outputSchema: purgeWorkflowsOutput as z.ZodType<PurgeWorkflowsOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<PurgeWorkflowsOutput> => {
    const e = engine as Engine;

    // purge intentionally keeps inline tag coercion + filter assembly
    // local; it must allow empty filters (no scoped assert) and shape
    // faults via `shapeRestFault` (sanitized), so
    // `validatedListFilterFromBulkInput` is not appropriate here.
    // Validating tags in `invoke` also ensures JSON-RPC / stdio callers
    // hit the same `coerceStartWorkflowTags` check the REST
    // `extractInput` path runs via `parseBulkListFilterFromBody`.
    let validatedTags: string[] | undefined;
    if (input.tags !== undefined) {
      try {
        validatedTags = coerceStartWorkflowTags(input.tags, 'Field "filter.tags"');
      } catch (error) {
        throw invalidParamsFault(faultMessage(error));
      }
    }

    const filter = listFilterFromBulkInput({
      ...input,
      ...(validatedTags === undefined ? {} : { tags: validatedTags }),
    });
    return await e.purge(Object.keys(filter).length === 0 ? undefined : filter);
  },
});

export const purgeWorkflowsRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/purge',
  pathParamNames: [],
  operationName: 'weft.workflows.purge',
  inputSources: {},
  extractInput: async (request) => {
    const raw = await readOptionalJsonBody(request);

    try {
      return { ...parseBulkListFilterFromBody(raw) };
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: PurgeWorkflowsOutput) => shapeBulkJsonSuccess(output),
  shapeFault: shapeRestFault,
};
