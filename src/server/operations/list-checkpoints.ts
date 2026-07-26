import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { CheckpointSummary } from '../../core/types.ts';
import { negotiatedResponse } from '../handler/response-helpers.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const listCheckpointsInput = z.object({
  workflowId: z.string().min(1),
});
const listCheckpointsOutput = z.unknown();

export type ListCheckpointsInput = z.infer<typeof listCheckpointsInput>;
export type ListCheckpointsOutput = CheckpointSummary[];

export const listCheckpointsOperation = defineOperation<
  ListCheckpointsInput,
  ListCheckpointsOutput
>({
  name: 'weft.workflows.checkpoints.list',
  mcpExposable: false,
  summary: 'List checkpoint history for a workflow',
  destructive: false,
  tags: ['Checkpoints'],
  inputSchema: listCheckpointsInput,
  outputSchema: listCheckpointsOutput as z.ZodType<ListCheckpointsOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  // Operation contract is transport-neutral: it returns the array of
  // summaries directly. JSON-RPC HTTP/WS/stdio clients receive the
  // canonical envelope around this value. The REST binding's
  // `shapeSuccess` does `Accept` negotiation (json vs msgpack) on
  // top of it — that representation choice is HTTP-specific and
  // does not belong on the operation's `Output` type.
  invoke: async ({ input, engine }): Promise<ListCheckpointsOutput> => {
    const e = engine as Engine;
    return e.listCheckpoints(input.workflowId);
  },
});

function shapeListCheckpointsSuccess(result: ListCheckpointsOutput, request: Request): Response {
  return negotiatedResponse(request, result, 200);
}

export const listCheckpointsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/checkpoints',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.checkpoints.list',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: ListCheckpointsOutput, request: Request) =>
    shapeListCheckpointsSuccess(output, request),
};
