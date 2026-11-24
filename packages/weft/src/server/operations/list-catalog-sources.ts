/** `weft.catalog.sources.list` operation + REST binding. */

import { z } from 'zod';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { listWorkflowSources } from '../../core/engine/source-listing.ts';
import { shapeWeftOperationFaultAsJson } from '../weft-operation-fault.ts';
import { assertOperationEngineObject } from './operation-helpers.ts';

const listCatalogSourcesInput = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Maximum number of entries to return, 1 to 1000; defaults to 100.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Number of entries to skip before the first returned; defaults to 0.'),
  })
  .strict();
const sourceSchema = z
  .object({
    name: z.string(),
    revision: z.string(),
    kind: z.literal('module'),
    state: z.enum(['idle', 'loading', 'ready', 'failed', 'cancelled']),
  })
  .strict();
const listCatalogSourcesOutput = z
  .object({
    sources: z.array(sourceSchema),
    nextOffset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ListCatalogSourcesInput = z.infer<typeof listCatalogSourcesInput>;
export type ListCatalogSourcesOutput = z.infer<typeof listCatalogSourcesOutput>;

export const listCatalogSourcesOperation = defineOperation({
  name: 'weft.catalog.sources.list',
  mcpExposable: false,
  summary: 'List registered dynamic workflow sources',
  description:
    'List all dynamically registered workflow source revisions, including sources in the idle ' +
    'state. Results are ordered by name then revision in codepoint order. `limit` defaults ' +
    'to 100 (maximum 1000) and `offset` defaults to 0. Pages ' +
    'reflect live process state and may change between requests. No source loader or durable ' +
    'storage is read. Returns only name, revision, kind, and load state; no manifest, ' +
    'contract, module content, or source location.',
  destructive: false,
  tags: ['Workflow Catalog'],
  inputSchema: listCatalogSourcesInput,
  outputSchema: listCatalogSourcesOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
  producibleFaults: [],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ host: engine, input }): Promise<ListCatalogSourcesOutput> => {
    assertOperationEngineObject(engine);
    const entries = listWorkflowSources(engine);
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    const page = entries.slice(offset, offset + limit);
    return {
      sources: page,
      ...(offset + page.length < entries.length ? { nextOffset: offset + page.length } : {}),
    };
  },
});

export const listCatalogSourcesRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/catalog/sources',
  pathParamNames: [],
  operationName: 'weft.catalog.sources.list',
  inputSources: {
    limit: { kind: 'query', queryParam: 'limit' },
    offset: { kind: 'query', queryParam: 'offset' },
  },
  extractInput: async (request) => {
    const params = new URL(request.url).searchParams;
    return {
      limit: params.has('limit') ? Number(params.get('limit')) : undefined,
      offset: params.has('offset') ? Number(params.get('offset')) : undefined,
    };
  },
  success: { kind: 'json', status: 200 },
  shapeFault: shapeWeftOperationFaultAsJson,
};
