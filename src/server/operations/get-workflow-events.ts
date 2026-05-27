import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { WorkflowEvent } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const getWorkflowEventsInput = z.object({
  workflowId: z.string().min(1),
});
const getWorkflowEventsOutput = z.unknown();

export type GetWorkflowEventsInput = z.infer<typeof getWorkflowEventsInput>;
export type GetWorkflowEventsOutput = { events: WorkflowEvent[] };

export const getWorkflowEventsOperation = defineOperation<
  GetWorkflowEventsInput,
  GetWorkflowEventsOutput
>({
  name: 'weft.workflows.events.list',
  mcpExposable: false,
  summary: 'Get workflow events by id',
  destructive: false,
  tags: ['Events'],
  inputSchema: getWorkflowEventsInput,
  outputSchema: getWorkflowEventsOutput as z.ZodType<GetWorkflowEventsOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetWorkflowEventsOutput> => {
    const e = engine as Engine;
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

function shapeGetWorkflowEventsSuccess(result: GetWorkflowEventsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeGetWorkflowEventsFault(fault: OperationFault): Response {
  return shapeRestFault(fault);
}

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
  shapeSuccess: (output: GetWorkflowEventsOutput) => shapeGetWorkflowEventsSuccess(output),
  shapeFault: shapeGetWorkflowEventsFault,
};
