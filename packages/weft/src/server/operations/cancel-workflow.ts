import { z } from 'zod';

import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  createSingleWorkflowControlOperation,
  extractWorkflowIdFromPath,
} from './single-workflow-control-operation.ts';

const cancelWorkflowInput = z.object({
  workflowId: z.string().min(1),
});
const cancelWorkflowOutput = z.undefined();

export type CancelWorkflowInput = z.infer<typeof cancelWorkflowInput>;
export type CancelWorkflowOutput = z.infer<typeof cancelWorkflowOutput>;

export const cancelWorkflowOperation = createSingleWorkflowControlOperation<
  CancelWorkflowInput,
  CancelWorkflowOutput
>({
  name: 'weft.workflows.cancel',
  summary: 'Cancel a running workflow',
  description:
    'Request cancellation of a running workflow by `id`. Cancellation is cooperative: the ' +
    'workflow observes a cancellation signal and unwinds via its own cleanup logic, so this ' +
    'is irreversible from the caller perspective. Faults with NotFound when the workflow is ' +
    'not visible.',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: cancelWorkflowInput,
  outputSchema: cancelWorkflowOutput,
  producibleFaults: ['NotFound'],
  invoke: async ({ input, engine }): Promise<CancelWorkflowOutput> => {
    await engine.cancel(input.workflowId);
    return undefined;
  },
});

export const cancelWorkflowRestBinding: UnknownRestBinding = {
  method: 'DELETE',
  path: '/v1/workflows/:id',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.cancel',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => extractWorkflowIdFromPath(pathParams),
  success: { kind: 'empty', status: 204 },
};
