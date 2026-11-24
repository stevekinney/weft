import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";

const getUpdateResultInput = z.object({
  updateId: z
    .string()
    .min(1)
    .describe(
      'Id of the update request whose result is read, as returned when the update was submitted.',
    ),
});
const getUpdateResultOutput = z.unknown();

export type GetUpdateResultInput = z.infer<typeof getUpdateResultInput>;
export type GetUpdateResultOutput =
  { status: 'pending' } | { status: 'completed'; result: unknown; error?: string };

export const getUpdateResultOperation = defineOperation({
  name: 'weft.updates.result.get',
  mcpExposable: false,
  summary: 'Get the result of an update request',
  description:
    'Read the outcome of an update request by update id. Returns status `pending` ' +
    "until the workflow has answered, then status `completed` with the handler's " +
    'result, or an error message when the handler failed. Read-only.',
  destructive: false,
  tags: ['Updates'],
  inputSchema: getUpdateResultInput,
  outputSchema: getUpdateResultOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<GetUpdateResultOutput> => {
    assertOperationEngineMethods(engine, ['getUpdateResult']);
    const e = engine;
    const response = await e.getUpdateResult(input.updateId);

    if (response === null) {
      return { status: 'pending' };
    }

    return {
      status: 'completed',
      result: response.result,
      ...(response.error !== undefined ? { error: response.error } : {}),
    };
  },
});

function shapeGetUpdateResultSuccess(result: GetUpdateResultOutput): Response {
  if (result.status === 'pending') {
    return new Response(JSON.stringify(result), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const getUpdateResultRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/updates/:updateId',
  pathParamNames: ['updateId'],
  operationName: 'weft.updates.result.get',
  inputSources: {
    updateId: { kind: 'path', pathParam: 'updateId' },
  },
  extractInput: async (_request, pathParams) => ({ updateId: pathParams['updateId'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetUpdateResultOutput) => shapeGetUpdateResultSuccess(output),
};
