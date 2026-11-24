/** `weft.workflows.definitions.get` operation + REST binding. */

import { z } from 'zod';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { describeWorkflowDefinition } from '../../core/engine/definition-listing.ts';
import { validateWorkflowNameField } from './workflow-catalog-operation-helpers.ts';
import {
  requireDefinitionEngine,
  workflowDefinitionSummaryShape,
  workflowDefinitionsReadAccess,
} from './workflow-definition-operation-support.ts';

const getWorkflowDefinitionInput = z.object({
  name: z
    .unknown()
    .describe('Workflow type name. Runtime validation requires a wire-safe identifier.'),
});
const getWorkflowDefinitionOutput = z
  .object({
    ...workflowDefinitionSummaryShape,
    contractHash: z.string().nullable(),
    contract: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export type GetWorkflowDefinitionInput = z.infer<typeof getWorkflowDefinitionInput>;
export type GetWorkflowDefinitionOutput = z.infer<typeof getWorkflowDefinitionOutput>;

export const getWorkflowDefinitionOperation = defineOperation({
  name: 'weft.workflows.definitions.get',
  mcpExposable: false,
  summary: 'Get one workflow type with the full contract of its active revision',
  description:
    'Read one workflow type: the same fields `weft.workflows.definitions.list` returns, plus ' +
    '`contractHash` and the full `contract` (input and output schemas included) of the revision ' +
    'a new instance would run. Read-only, and it never runs a source loader, so a source that ' +
    'has not been loaded reports its load state with a null `contract`. Faults with NotFound ' +
    'when no workflow type has that name. `origin` records how Weft loaded the type, not who ' +
    'authored it.',
  destructive: false,
  tags: ['Workflow Catalog'],
  inputSchema: getWorkflowDefinitionInput,
  outputSchema: getWorkflowDefinitionOutput,
  access: workflowDefinitionsReadAccess,
  producibleFaults: ['NotFound', 'InvalidParams'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ host, input }): Promise<GetWorkflowDefinitionOutput> => {
    const name = validateWorkflowNameField(input.name);
    const detail = await describeWorkflowDefinition(requireDefinitionEngine(host), name);
    if (detail === undefined) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Workflow "${name}" is not a registered workflow type`,
        data: { resource: 'workflow-definition', identifier: name },
      };
      throw fault;
    }
    return {
      ...detail,
      tags: detail.tags === null ? null : [...detail.tags],
      signals: detail.signals === null ? null : [...detail.signals],
      updates: detail.updates === null ? null : [...detail.updates],
      queries: detail.queries === null ? null : [...detail.queries],
      contract: detail.contract === null ? null : { ...detail.contract },
    };
  },
});

export const getWorkflowDefinitionRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/registry/definitions/:name',
  pathParamNames: ['name'],
  operationName: 'weft.workflows.definitions.get',
  inputSources: {
    name: { kind: 'path', pathParam: 'name' },
  },
  extractInput: async (_request, pathParams) => ({
    name: pathParams['name'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
};
