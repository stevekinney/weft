import { z } from 'zod';

import {
  type UnknownRestBinding,
  isOperationFault,
  readRestJsonBody,
} from "../../embedded/backchannel/src/internals.ts";
import { isSignalIdWithinByteLimit } from '../../core/signal-id.ts';
import { standardSchemaValidationFault } from '../standard-schema-validation-fault.ts';
import { undeclaredMessageFault } from './operation-helpers.ts';
import {
  createSingleWorkflowControlOperation,
  extractWorkflowIdFromPath,
} from './single-workflow-control-operation.ts';

const signalWorkflowInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow to signal.'),
  signalName: z.string().min(1).describe('Name of the signal to deliver.'),
  payload: z.unknown().optional().describe('Payload delivered with the signal.'),
  signalId: z
    .string()
    .min(1)
    .refine(isSignalIdWithinByteLimit, 'signalId must be at most 128 bytes')
    .optional()
    .describe(
      'Id that makes delivery idempotent: sending the same id again delivers the signal once. At most 128 bytes.',
    ),
});
const signalWorkflowOutput = z.object({
  ok: z.literal(true),
});

export type SignalWorkflowInput = z.infer<typeof signalWorkflowInput>;
export type SignalWorkflowOutput = z.infer<typeof signalWorkflowOutput>;

export const signalWorkflowOperation = createSingleWorkflowControlOperation({
  name: 'weft.workflows.signal',
  summary: 'Send a signal to a workflow',
  description:
    'Deliver a named signal with an optional payload to a running workflow. Requires the ' +
    'workflow `id` and the signal `name`; `payload` is optional. Signals are fire-and-forget ' +
    'from the caller perspective and do not return a handler result. Faults with NotFound when ' +
    'the workflow is not visible, InvalidParams when the payload exceeds the size limit, and ' +
    'Unprocessable when the workflow declares its signals and this name is not one of them.',
  destructive: true,
  scope: 'signals:write',
  tags: ['Signals'],
  inputSchema: signalWorkflowInput,
  outputSchema: signalWorkflowOutput,
  producibleFaults: ['NotFound', 'Unprocessable'],
  requiredEngineMethods: ['signal'],
  mapErrorToFault: ({ error }) =>
    undeclaredMessageFault(error) ?? standardSchemaValidationFault(error),
  invoke: async ({ input, engine }): Promise<SignalWorkflowOutput> => {
    await engine.signal(
      input.workflowId,
      input.signalName,
      input.payload,
      input.signalId === undefined ? undefined : { signalId: input.signalId },
    );
    return { ok: true };
  },
});

export const signalWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/signal/:name',
  pathParamNames: ['id', 'name'],
  operationName: 'weft.workflows.signal',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    signalName: { kind: 'path', pathParam: 'name' },
    payload: { kind: 'body-field', bodyField: 'payload' },
  },
  extractInput: async (request, pathParams, context) => {
    const body = await readRestJsonBody(request, context).catch((error) => {
      if (isOperationFault(error)) throw error;
      return null;
    });
    const payload =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['payload']
        : undefined;
    const signalId =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['signalId']
        : undefined;

    return {
      ...extractWorkflowIdFromPath(pathParams),
      signalName: pathParams['name'] ?? '',
      payload,
      ...(signalId === undefined ? {} : { signalId }),
    };
  },
  success: { kind: 'json', status: 200 },
};
