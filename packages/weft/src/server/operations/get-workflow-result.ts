import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const getWorkflowResultInput = z.object({
  workflowId: z.string().min(1),
});
const getWorkflowResultOutput = z.unknown();

export type GetWorkflowResultInput = z.infer<typeof getWorkflowResultInput>;
export type GetWorkflowResultOutput = { result: unknown };

export const getWorkflowResultOperation = defineOperation<
  GetWorkflowResultInput,
  GetWorkflowResultOutput
>({
  name: 'weft.workflows.result.get',
  mcpExposable: false,
  summary: 'Get workflow result by id',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: getWorkflowResultInput,
  outputSchema: getWorkflowResultOutput as z.ZodType<GetWorkflowResultOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Unprocessable', 'Timeout'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetWorkflowResultOutput> => {
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

    if (state.status === 'completed') {
      return { result: state.result };
    }

    if (state.status === 'failed') {
      const message = state.error ?? 'Workflow failed';
      const fault: OperationFault = {
        code: 'Unprocessable',
        message,
        data: { reason: message },
      };
      throw fault;
    }

    if (state.status === 'cancelled') {
      const fault: OperationFault = {
        code: 'Unprocessable',
        message: 'Workflow cancelled',
        data: { reason: 'Workflow cancelled' },
      };
      throw fault;
    }

    const handle = e.getHandle(input.workflowId);
    const timeoutMilliseconds = 30_000;

    // Clear the loser timer in `finally` so the common path (`handle.result()` wins)
    // does not leak a dangling 30s timer that pins the rejection closure alive.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        handle.result(),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Timeout waiting for workflow result')),
            timeoutMilliseconds,
          );
        }),
      ]);

      return { result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('Timeout')) {
        const fault: OperationFault = {
          code: 'Timeout',
          message: 'Timeout waiting for workflow result',
          data: {},
        };
        throw fault;
      }

      // Carry the real engine message on the fault so JSON-RPC callers
      // still receive it; the REST surface masks `EngineFailure` to a
      // generic "Internal server error" 500 via `shapeRestFault`, so the
      // raw message never reaches REST clients.
      const fault: OperationFault = {
        code: 'EngineFailure',
        message,
        data: {},
      };
      throw fault;
    } finally {
      // `clearTimeout(undefined)` is a safe no-op, so no guard is needed.
      clearTimeout(timeoutId);
    }
  },
});

function shapeGetWorkflowResultFault(fault: OperationFault): Response {
  if (fault.code === 'Timeout') {
    return shapeRestFault(fault, { message: 'Timeout waiting for workflow result', status: 408 });
  }
  // Every other fault goes through the canonical `shapeRestFault`, which
  // masks EngineFailure to a generic "Internal server error" 500 and maps
  // client faults to their status from the fault map.
  return shapeRestFault(fault);
}

export const getWorkflowResultRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/result',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.result.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeGetWorkflowResultFault,
};
