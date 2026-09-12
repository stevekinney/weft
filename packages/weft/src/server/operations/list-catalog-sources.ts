/** `weft.catalog.sources.list` operation + REST binding. */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { listWorkflowSources } from '../../core/engine/source-listing.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const listCatalogSourcesInput = z
  .object({
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
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

export const listCatalogSourcesOperation = defineOperation<
  ListCatalogSourcesInput,
  ListCatalogSourcesOutput
>({
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
  invoke: async ({ engine, input }): Promise<ListCatalogSourcesOutput> => {
    const entries = listWorkflowSources(engine as Engine);
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
  shapeFault: shapeOperationFaultAsJson,
};
