import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import type { CheckpointSummary } from '../../core/types.ts';
import { negotiatedResponse } from '../handler/response-helpers.ts';

const listCheckpointsInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow whose checkpoints are listed.'),
});
const listCheckpointsOutput = z.unknown();

export type ListCheckpointsInput = z.infer<typeof listCheckpointsInput>;
export type ListCheckpointsOutput = CheckpointSummary[];

export const listCheckpointsOperation = defineOperation({
  name: 'weft.workflows.checkpoints.list',
  mcpExposable: false,
  summary: 'List checkpoint history for a workflow',
  description:
    'List the persisted checkpoints of a workflow, as its checkpoint history. Read-only.',
  destructive: false,
  tags: ['Checkpoints'],
  inputSchema: listCheckpointsInput,
  outputSchema: listCheckpointsOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  // Operation contract is transport-neutral: it returns the array of
  // summaries directly. JSON-RPC HTTP/WS/stdio clients receive the
  // canonical envelope around this value. The REST binding's
  // `shapeSuccess` does `Accept` negotiation (json vs msgpack) on
  // top of it — that representation choice is HTTP-specific and
  // does not belong on the operation's `Output` type.
  invoke: async ({ input, host: engine }): Promise<ListCheckpointsOutput> => {
    assertOperationEngineMethods(engine, ['listCheckpoints']);
    const e = engine;
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
