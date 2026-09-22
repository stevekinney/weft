import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import type { WorkflowEvent } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getWorkflowEventsInput = z.object({
  workflowId: z.string().min(1),
});
const getWorkflowEventsOutput = z.unknown();

export type GetWorkflowEventsInput = z.infer<typeof getWorkflowEventsInput>;
export type GetWorkflowEventsOutput = { events: WorkflowEvent[] };

export const getWorkflowEventsOperation = defineOperation({
  name: 'weft.workflows.events.list',
  mcpExposable: false,
  summary: 'Get workflow events by id',
  destructive: false,
  tags: ['Events'],
  inputSchema: getWorkflowEventsInput,
  outputSchema: getWorkflowEventsOutput,
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetWorkflowEventsOutput> => {
    assertOperationEngineMethods(engine, ['get', 'getEvents']);
    const e = engine;
    const state = await e.get(input.workflowId);
    if (state === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Workflow "${input.workflowId}" not found`,
        data: { resource: 'workflow', identifier: input.workflowId },
      };
      throw fault;
    }

    return { events: await e.getEvents(input.workflowId) };
  },
});

export const getWorkflowEventsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/events',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.events.list',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
  success: { kind: 'json', status: 200 },
};
