import { purgeOutputSchema } from './bulk-output-schemas.ts';
import {
  assertOperationEngineMethods,
  faultMessage,
  invalidParamsFault,
  readOptionalJsonBody,
} from './operation-helpers.ts';

import type { z } from 'zod';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { parseBulkListFilterFromBody } from './bulk-filter-body.ts';
import {
  bulkListFilterInputSchema,
  listFilterFromBulkInput,
  type BulkListFilterInput,
} from './bulk-filter-input.ts';

export type PurgeWorkflowsInput = BulkListFilterInput;
export type PurgeWorkflowsOutput = z.output<typeof purgeOutputSchema>;

export const purgeWorkflowsOperation = defineOperation({
  name: 'weft.workflows.purge',
  mcpExposable: false,
  summary: 'Purge terminal workflows',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: bulkListFilterInputSchema,
  outputSchema: purgeOutputSchema,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<PurgeWorkflowsOutput> => {
    assertOperationEngineMethods(engine, ['purge']);
    const e = engine;

    // purge intentionally keeps inline tag coercion + filter assembly
    // local; it must allow empty filters (no scoped assert) and use the
    // canonical REST fault fallback (sanitized), so
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
    const result = await e.purge(Object.keys(filter).length === 0 ? undefined : filter);
    return { deleted: result.deleted };
  },
});

export const purgeWorkflowsRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/purge',
  pathParamNames: [],
  operationName: 'weft.workflows.purge',
  inputSources: {},
  extractInput: async (request, _pathParams, context) => {
    const raw = await readOptionalJsonBody(request, context);

    try {
      return { ...parseBulkListFilterFromBody(raw) };
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }
  },
  success: { kind: 'json', status: 200 },
};
