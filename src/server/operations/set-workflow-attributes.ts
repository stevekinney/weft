import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { SearchAttributeValue } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { readRestJsonBody } from '../rest-body.ts';
import { isOperationFault } from './operation-helpers.ts';

const setWorkflowAttributesInput = z.object({
  workflowId: z.string().min(1),
  attributes: z.unknown().optional(),
});
const setWorkflowAttributesOutput = z.object({
  ok: z.literal(true),
});

export type SetWorkflowAttributesInput = z.infer<typeof setWorkflowAttributesInput>;
export type SetWorkflowAttributesOutput = z.infer<typeof setWorkflowAttributesOutput>;

export const setWorkflowAttributesOperation = defineOperation<
  SetWorkflowAttributesInput,
  SetWorkflowAttributesOutput
>({
  name: 'weft.workflows.attributes.set',
  mcpExposable: false,
  summary: 'Update search attributes for a workflow',
  // Not destructive: search attributes are operational metadata, not execution
  // state, and an overwrite is trivially reversible by setting them again. It
  // does not advance or terminate the workflow. Consistent with tags.add/remove.
  destructive: false,
  tags: ['Attributes'],
  inputSchema: setWorkflowAttributesInput,
  outputSchema: setWorkflowAttributesOutput as z.ZodType<SetWorkflowAttributesOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<SetWorkflowAttributesOutput> => {
    const e = engine as Engine;

    try {
      // REST forwards whatever lived under `attributes`
      // directly into `engine.setAttributes`, defaulting only on
      // null/undefined. Keep that contract intact here.
      await e.setAttributes(
        input.workflowId,
        (input.attributes ?? {}) as Record<string, SearchAttributeValue>,
      );
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fault: OperationFault = {
        code: 'EngineFailure',
        message,
        data: {},
      };
      throw fault;
    }
  },
});

export const setWorkflowAttributesRestBinding: UnknownRestBinding = {
  method: 'PATCH',
  path: '/v1/workflows/:id/attributes',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.attributes.set',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    attributes: { kind: 'body-field', bodyField: 'attributes' },
  },
  extractInput: async (request, pathParams, context) => {
    const body = await readRestJsonBody(request, context).catch((error) => {
      if (isOperationFault(error)) throw error;
      throw new Error('Invalid JSON body');
    });

    if (body === null) {
      throw new Error('Invalid JSON body');
    }

    return {
      workflowId: pathParams['id'] ?? '',
      attributes:
        typeof body === 'object' ? (body as Record<string, unknown>)['attributes'] : undefined,
    };
  },
  success: { kind: 'json', status: 200 },
};
