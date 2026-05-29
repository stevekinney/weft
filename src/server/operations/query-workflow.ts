import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

const queryWorkflowInput = z.object({
  workflowId: z.string().min(1),
  queryName: z.string().min(1),
  input: z.unknown().optional(),
});
const queryWorkflowOutput = z.unknown();

export type QueryWorkflowInput = z.infer<typeof queryWorkflowInput>;
export type QueryWorkflowOutput = { result: unknown };

export const queryWorkflowOperation = defineOperation<QueryWorkflowInput, QueryWorkflowOutput>({
  name: 'weft.workflows.query',
  mcpExposable: false,
  summary: 'Query workflow state by id',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: queryWorkflowInput,
  outputSchema: queryWorkflowOutput as z.ZodType<QueryWorkflowOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotImplemented'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<QueryWorkflowOutput> => {
    const e = engine as Engine;

    try {
      const result = await e.query(input.workflowId, input.queryName, input.input);
      return { result: result ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('not supported')) {
        const fault: OperationFault = {
          code: 'NotImplemented',
          message,
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
    }
  },
});

function shapeQueryWorkflowSuccess(result: QueryWorkflowOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const queryWorkflowRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/query/:name',
  pathParamNames: ['id', 'name'],
  operationName: 'weft.workflows.query',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    queryName: { kind: 'path', pathParam: 'name' },
  },
  extractInput: async (_request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
    queryName: pathParams['name'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: QueryWorkflowOutput) => shapeQueryWorkflowSuccess(output),
  shapeFault: shapeRestFault,
};

export const queryWorkflowWithInputRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/query/:name',
  pathParamNames: ['id', 'name'],
  operationName: 'weft.workflows.query',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    queryName: { kind: 'path', pathParam: 'name' },
    input: { kind: 'body-field', bodyField: 'input' },
  },
  extractInput: async (request, pathParams) => {
    const rawBody = await request.text();
    if (rawBody.trim().length === 0) {
      return {
        workflowId: pathParams['id'] ?? '',
        queryName: pathParams['name'] ?? '',
        input: undefined,
      };
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      throw invalidParamsFault('Invalid JSON body');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    return {
      workflowId: pathParams['id'] ?? '',
      queryName: pathParams['name'] ?? '',
      input: (body as Record<string, unknown>)['input'],
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: QueryWorkflowOutput) => shapeQueryWorkflowSuccess(output),
  shapeFault: shapeRestFault,
};
