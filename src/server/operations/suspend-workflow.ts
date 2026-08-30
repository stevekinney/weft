import { z } from 'zod';

import { WorkflowSuspendNotSupportedError } from '../../core/engine/errors.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  createSingleWorkflowControlOperation,
  extractWorkflowIdFromPath,
} from './single-workflow-control-operation.ts';

const suspendWorkflowInput = z.object({
  workflowId: z.string().min(1),
});
const suspendWorkflowOutput = z.undefined();

export type SuspendWorkflowInput = z.infer<typeof suspendWorkflowInput>;
export type SuspendWorkflowOutput = z.infer<typeof suspendWorkflowOutput>;

export const suspendWorkflowOperation = createSingleWorkflowControlOperation<
  SuspendWorkflowInput,
  SuspendWorkflowOutput
>({
  name: 'weft.workflows.suspend',
  summary: 'Suspend a running workflow',
  description:
    'Request suspension of a running workflow by `id` without terminating it. The workflow ' +
    'transitions to the non-terminal `suspended` status, keeps its durable checkpoint, and is ' +
    'later resumable via `resume`. Unlike cancellation, suspension does not run cancel handlers ' +
    'and does not settle the result. Suspending a workflow that is not running is a no-op. ' +
    'Faults with Unprocessable when the engine runs in worker execution mode (which cannot pause ' +
    'a run without cancelling it).',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: suspendWorkflowInput,
  outputSchema: suspendWorkflowOutput,
  producibleFaults: ['Unprocessable'],
  invoke: async ({ input, engine }): Promise<SuspendWorkflowOutput> => {
    await engine.suspend(input.workflowId);
    return undefined;
  },
  mapErrorToFault: ({ error, message }) =>
    error instanceof WorkflowSuspendNotSupportedError
      ? { code: 'Unprocessable', message, data: { reason: message } }
      : undefined,
});

export const suspendWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/suspend',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.suspend',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => extractWorkflowIdFromPath(pathParams),
  success: { kind: 'empty', status: 204 },
};
