/**
 * `weft.workflows.revisions.list` operation + REST binding.
 *
 * Lists every durably installed revision of one workflow name.
 *
 * @module server/operations/list-workflow-revisions
 */

import { z } from 'zod';

import type { WorkflowRevisionRecord } from '../../core/catalog/index.ts';
import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  validateWorkflowNameField,
  workflowsReadAccess,
} from './workflow-catalog-operation-helpers.ts';

const listWorkflowRevisionsInput = z.object({
  name: z.unknown().describe('Workflow name. Runtime validation requires a wire-safe identifier.'),
});
const listWorkflowRevisionsOutput = z.unknown();

export type ListWorkflowRevisionsInput = z.infer<typeof listWorkflowRevisionsInput>;
export type ListWorkflowRevisionsOutput = readonly WorkflowRevisionRecord[];

export const listWorkflowRevisionsOperation = defineOperation<
  ListWorkflowRevisionsInput,
  ListWorkflowRevisionsOutput
>({
  name: 'weft.workflows.revisions.list',
  mcpExposable: false,
  summary: 'List every installed revision of a workflow',
  description:
    'Read every durably installed revision of `name`, sorted deterministically by revision. ' +
    'Read-only. Returns an empty array for a name with no installed revisions, rather than a ' +
    'NotFound fault — an empty catalog is not an error.',
  destructive: false,
  tags: ['Workflow Catalog'],
  inputSchema: listWorkflowRevisionsInput,
  outputSchema: listWorkflowRevisionsOutput as z.ZodType<ListWorkflowRevisionsOutput>,
  access: workflowsReadAccess,
  producibleFaults: ['InvalidParams'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ListWorkflowRevisionsOutput> => {
    const e = engine as Engine;
    const name = validateWorkflowNameField(input.name);
    return e.workflows.listRevisions(name);
  },
});

export const listWorkflowRevisionsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/registry/workflows/:name/revisions',
  pathParamNames: ['name'],
  operationName: 'weft.workflows.revisions.list',
  inputSources: {
    name: { kind: 'path', pathParam: 'name' },
  },
  extractInput: async (_request, pathParams) => ({
    name: pathParams['name'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
};
