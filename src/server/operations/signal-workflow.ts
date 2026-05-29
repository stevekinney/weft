import { z } from 'zod';

import { isSignalIdWithinByteLimit } from '../../core/signal-id.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';
import {
  createSingleWorkflowControlOperation,
  extractWorkflowIdFromPath,
} from './single-workflow-control-operation.ts';

const signalWorkflowInput = z.object({
  workflowId: z.string().min(1),
  signalName: z.string().min(1),
  payload: z.unknown().optional(),
  signalId: z
    .string()
    .min(1)
    .refine(isSignalIdWithinByteLimit, 'signalId must be at most 128 bytes')
    .optional(),
});
const signalWorkflowOutput = z.object({
  ok: z.literal(true),
});

export type SignalWorkflowInput = z.infer<typeof signalWorkflowInput>;
export type SignalWorkflowOutput = z.infer<typeof signalWorkflowOutput>;

export const signalWorkflowOperation = createSingleWorkflowControlOperation<
  SignalWorkflowInput,
  SignalWorkflowOutput
>({
  name: 'weft.workflows.signal',
  summary: 'Send a signal to a workflow',
  destructive: true,
  tags: ['Signals'],
  inputSchema: signalWorkflowInput,
  outputSchema: signalWorkflowOutput as z.ZodType<SignalWorkflowOutput>,
  producibleFaults: ['NotFound'],
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

function shapeSignalWorkflowSuccess(output: SignalWorkflowOutput): Response {
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
  extractInput: async (request, pathParams) => {
    const body = await request.json().catch(() => null);
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
  shapeSuccess: (output: SignalWorkflowOutput) => shapeSignalWorkflowSuccess(output),
  shapeFault: shapeRestFault,
};
