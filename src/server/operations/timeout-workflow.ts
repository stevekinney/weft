import { z } from 'zod';

import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  createSingleWorkflowControlOperation,
  extractWorkflowIdFromPath,
} from './single-workflow-control-operation.ts';

const timeoutWorkflowInput = z.object({
  workflowId: z.string().min(1),
});

export type TimeoutWorkflowInput = z.infer<typeof timeoutWorkflowInput>;

export const timeoutWorkflowOperation = createSingleWorkflowControlOperation<
  TimeoutWorkflowInput,
  null
>({
  name: 'weft.workflows.timeout',
  summary: 'Force-timeout a workflow',
  description:
    'Force a running workflow into the timed-out terminal state by `id`, as if its execution ' +
    'timeout had elapsed. Irreversible. Use for operator intervention on stuck workflows. ' +
    'Faults with NotFound when the workflow is not visible.',
  destructive: true,
  tags: ['Workflows'],
  inputSchema: timeoutWorkflowInput,
  outputSchema: z.null(),
  producibleFaults: ['NotFound'],
  invoke: async ({ input, engine }): Promise<null> => {
    await engine.timeout(input.workflowId);
    return null;
  },
});

export const timeoutWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/timeout',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.timeout',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => extractWorkflowIdFromPath(pathParams),
  success: { kind: 'empty', status: 204 },
};
