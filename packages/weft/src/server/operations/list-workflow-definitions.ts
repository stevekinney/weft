/** `weft.workflows.definitions.list` operation + REST binding. */

import { z } from 'zod';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { listWorkflowDefinitions } from '../../core/engine/definition-listing.ts';
import { shapeWeftOperationFaultAsJson } from '../weft-operation-fault.ts';
import {
  requireDefinitionEngine,
  workflowDefinitionSummaryShape,
  workflowDefinitionsReadAccess,
} from './workflow-definition-operation-support.ts';

const listWorkflowDefinitionsInput = z
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
const listWorkflowDefinitionsOutput = z
  .object({
    definitions: z.array(z.object(workflowDefinitionSummaryShape).strict()),
    nextOffset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ListWorkflowDefinitionsInput = z.infer<typeof listWorkflowDefinitionsInput>;
export type ListWorkflowDefinitionsOutput = z.infer<typeof listWorkflowDefinitionsOutput>;

export const listWorkflowDefinitionsOperation = defineOperation({
  name: 'weft.workflows.definitions.list',
  mcpExposable: false,
  summary: 'List every workflow type the engine can run',
  description:
    'List one entry per workflow type: those registered with `register()` (`origin: "code"`) and ' +
    'those registered with `registerSource()` (`origin: "source"`), including document-registered ' +
    "types. `state` is `ready` for a code type or a loaded source, and otherwise the source's " +
    '`idle`, `loading`, `failed`, or `cancelled` load state; a source already loaded in this process is `ready`. `lastFailureCategory` names the failure category when `failed` and is null otherwise. `revision` ' +
    'is the revision a new instance would run: for a source with several registered revisions, the ' +
    'active one, or null when none is. A `ready` entry also carries `workflowVersion`, ' +
    '`description`, `tags`, and the names of the signals, updates, and queries its contract ' +
    'accepts; the others are null. Listing never runs a source loader. Results are ordered by name ' +
    'in codepoint order. `limit` defaults to 100 (maximum 1000) and `offset` defaults to 0. Pages ' +
    'reflect live process state and may change between requests. `origin` records how Weft loaded ' +
    'the type, not who authored it.',
  destructive: false,
  tags: ['Workflow Catalog'],
  inputSchema: listWorkflowDefinitionsInput,
  outputSchema: listWorkflowDefinitionsOutput,
  access: workflowDefinitionsReadAccess,
  producibleFaults: [],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ host, input }): Promise<ListWorkflowDefinitionsOutput> => {
    const page = await listWorkflowDefinitions(requireDefinitionEngine(host), input);
    return {
      definitions: page.definitions.map((definition) => ({
        ...definition,
        tags: definition.tags === null ? null : [...definition.tags],
        signals: definition.signals === null ? null : [...definition.signals],
        updates: definition.updates === null ? null : [...definition.updates],
        queries: definition.queries === null ? null : [...definition.queries],
      })),
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    };
  },
});

export const listWorkflowDefinitionsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/registry/definitions',
  pathParamNames: [],
  operationName: 'weft.workflows.definitions.list',
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
