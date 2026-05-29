/**
 * `weft.workflows.replay` operation + REST binding.
 *
 * Reconstructs historical workflow state at a checkpoint step. This is a
 * side-effecting read (it does not mutate the live workflow), so it is
 * declared `authenticated` with a scope requirement to prevent anonymous
 * access to sensitive historical state.
 *
 * REST response: content-negotiated JSON or msgpack, 404 for missing
 * workflow or step.
 *
 * @module server/operations/replay-workflow
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { WorkflowReplay } from '../../core/types.ts';
import { negotiatedResponse } from '../handler/response-helpers.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

const replayWorkflowInput = z.object({
  workflowId: z.string().min(1),
  step: z.union([z.string(), z.number()]),
});

const replayWorkflowOutput = z.unknown();

export type ReplayWorkflowInput = z.infer<typeof replayWorkflowInput>;
export type ReplayWorkflowOutput = WorkflowReplay;

export const replayWorkflowOperation = defineOperation<ReplayWorkflowInput, ReplayWorkflowOutput>({
  name: 'weft.workflows.replay',
  mcpExposable: false,
  summary: 'Replay a workflow to a historical checkpoint step',
  description:
    'Reconstruct the historical state of a workflow at a given checkpoint step and return a ' +
    'replay view. This is a read-only reconstruction via the engine replay machinery — the ' +
    'live workflow is never mutated or rewound. Faults with NotFound when the workflow or ' +
    'checkpoint step is not visible.',
  // Not destructive: this is a side-effecting read (workflows:read scope, GET
  // binding). It reconstructs historical state via replayTo() and returns a
  // WorkflowReplay value — the live workflow is never mutated or rewound.
  destructive: false,
  tags: ['Checkpoints'],
  inputSchema: replayWorkflowInput,
  outputSchema: replayWorkflowOutput as z.ZodType<ReplayWorkflowOutput>,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['workflows:read'] },
  },
  producibleFaults: ['NotFound', 'Conflict'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ReplayWorkflowOutput> => {
    const e = engine as Engine;

    // Confirm the workflow exists first: 404 takes precedence over the step check.
    const state = await e.get(input.workflowId);
    if (state === null) {
      const notFoundFault: OperationFault = {
        code: 'NotFound',
        message: `Workflow "${input.workflowId}" not found`,
        data: { resource: 'workflow', identifier: input.workflowId },
      };
      throw notFoundFault;
    }

    const stepNumber = Number(input.step);
    if (!Number.isSafeInteger(stepNumber) || stepNumber < 0) {
      throw invalidParamsFault(`Invalid step: ${String(input.step)}`);
    }

    const replay = await e.replayTo(input.workflowId, stepNumber);
    if (replay === null) {
      const notFoundFault: OperationFault = {
        code: 'NotFound',
        message: `Replay not found at step ${stepNumber} for workflow ${input.workflowId}`,
        data: { resource: 'replay', identifier: `${input.workflowId}@${stepNumber}` },
      };
      throw notFoundFault;
    }

    return replay;
  },
});

function shapeReplayWorkflowFault(fault: OperationFault): Response {
  return shapeRestFault(fault);
}

/**
 * Content-negotiate success: REST callers that `Accept: application/msgpack`
 * get msgpack encoding; everyone else gets JSON.
 */
function shapeReplayWorkflowSuccess(output: ReplayWorkflowOutput, request: Request): Response {
  return negotiatedResponse(request, output, 200);
}

export const replayWorkflowRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/replay/:step',
  pathParamNames: ['id', 'step'],
  operationName: 'weft.workflows.replay',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    step: { kind: 'path', pathParam: 'step' },
  },
  extractInput: async (_request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
    step: pathParams['step'] ?? '0',
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: ReplayWorkflowOutput, request: Request) =>
    shapeReplayWorkflowSuccess(output, request),
  shapeFault: shapeReplayWorkflowFault,
};
