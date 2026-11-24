import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import type { CheckpointState } from '../../core/types.ts';
import { negotiatedResponse } from '../handler/response-helpers.ts';

const getCheckpointAtInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow whose checkpoint is read.'),
  step: z
    .number()
    .int()
    .nonnegative()
    .describe('Step number of the checkpoint to read; zero or greater.'),
});
const getCheckpointAtOutput = z.unknown();

export type GetCheckpointAtInput = z.infer<typeof getCheckpointAtInput>;
export type GetCheckpointAtOutput = CheckpointState;

export const getCheckpointAtOperation = defineOperation({
  name: 'weft.workflows.checkpoints.get',
  mcpExposable: false,
  summary: 'Get a specific checkpoint by step number',
  description:
    'Read one persisted checkpoint of a workflow by step number. Read-only. Faults ' +
    'with NotFound when the workflow or that step has no visible checkpoint.',
  destructive: false,
  tags: ['Checkpoints'],
  inputSchema: getCheckpointAtInput,
  outputSchema: getCheckpointAtOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
  discoverable: true,
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  // Operation contract is transport-neutral: returns the
  // `CheckpointState` directly. Accept-header negotiation between
  // json and msgpack happens in the REST binding's `shapeSuccess`,
  // not in the operation output, so JSON-RPC clients receive a
  // clean canonical envelope.
  invoke: async ({ input, host: engine }): Promise<GetCheckpointAtOutput> => {
    assertOperationEngineMethods(engine, ['getCheckpointAt']);
    const e = engine;
    const state = await e.getCheckpointAt(input.workflowId, input.step);
    if (state === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Checkpoint not found at step ${input.step} for workflow ${input.workflowId}`,
        data: { resource: 'checkpoint', identifier: `${input.workflowId}:${input.step}` },
      };
      throw fault;
    }
    return state;
  },
});

function shapeGetCheckpointAtSuccess(result: GetCheckpointAtOutput, request: Request): Response {
  return negotiatedResponse(request, result, 200);
}

export const getCheckpointAtRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/checkpoints/:step',
  pathParamNames: ['id', 'step'],
  operationName: 'weft.workflows.checkpoints.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    step: { kind: 'path', pathParam: 'step' },
  },
  extractInput: async (_request, pathParams) => {
    const stepParam = pathParams['step'] ?? '';

    // Accept only canonical decimal digits: no leading sign, no
    // scientific notation, no hex prefix. `Number()` would happily
    // coerce `1e2` to 100 and `0x10` to 16, accepting step URLs that
    // should be rejected as malformed.
    if (!/^\d+$/.test(stepParam)) {
      const fault: OperationFault = {
        code: 'InvalidParams',
        message: `Invalid step: ${stepParam}`,
        data: {
          issues: [{ path: ['step'], message: `Invalid step: ${stepParam}`, code: 'custom' }],
        },
      };
      throw fault;
    }

    const step = Number(stepParam);
    if (!Number.isSafeInteger(step) || step < 0) {
      const fault: OperationFault = {
        code: 'InvalidParams',
        message: `Invalid step: ${stepParam}`,
        data: {
          issues: [{ path: ['step'], message: `Invalid step: ${stepParam}`, code: 'custom' }],
        },
      };
      throw fault;
    }

    return {
      workflowId: pathParams['id'] ?? '',
      step,
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetCheckpointAtOutput, request: Request) =>
    shapeGetCheckpointAtSuccess(output, request),
};
