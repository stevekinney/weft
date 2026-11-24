import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import type { SearchAttributeValue } from '../../core/types.ts';

const getWorkflowAttributesInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow whose search attributes are read.'),
});
const getWorkflowAttributesOutput = z.unknown();

export type GetWorkflowAttributesInput = z.infer<typeof getWorkflowAttributesInput>;
export type GetWorkflowAttributesOutput = Record<string, SearchAttributeValue>;

export const getWorkflowAttributesOperation = defineOperation({
  name: 'weft.workflows.attributes.get',
  mcpExposable: false,
  summary: 'Get workflow attributes by id',
  description:
    'Read the search attributes currently set on a workflow. Read-only. Faults with ' +
    'NotFound when the workflow has no attributes record.',
  destructive: false,
  tags: ['Attributes'],
  inputSchema: getWorkflowAttributesInput,
  outputSchema: getWorkflowAttributesOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['attributes:read'] } },
  discoverable: true,
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<GetWorkflowAttributesOutput> => {
    assertOperationEngineMethods(engine, ['getAttributes']);
    const e = engine;
    const attributes = await e.getAttributes(input.workflowId);
    if (attributes === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Attributes for workflow "${input.workflowId}" not found`,
        data: { resource: 'attributes', identifier: input.workflowId },
      };
      throw fault;
    }

    return attributes;
  },
});

export const getWorkflowAttributesRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/attributes',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.attributes.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
  success: { kind: 'json', status: 200 },
};
