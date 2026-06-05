import { z } from 'zod';

import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';
import {
  createSingleWorkflowControlOperation,
  extractWorkflowIdFromPath,
} from './single-workflow-control-operation.ts';

const resumeWorkflowInput = z.object({
  workflowId: z.string().min(1),
});

const resumeWorkflowOutput = z.object({
  id: z.string(),
});

export type ResumeWorkflowInput = z.infer<typeof resumeWorkflowInput>;
export type ResumeWorkflowOutput = z.infer<typeof resumeWorkflowOutput>;

export const resumeWorkflowOperation = createSingleWorkflowControlOperation<
  ResumeWorkflowInput,
  ResumeWorkflowOutput
>({
  name: 'weft.workflows.resume',
  summary: 'Resume a suspended or recovered workflow',
  description:
    'Re-drive a workflow from its persisted checkpoint by `workflowId`, returning the workflow ' +
    '`id`. Accepts a workflow that was explicitly suspended (`weft.workflows.suspend`) or one ' +
    'left running by a prior process; a suspended workflow is durably flipped back to running as ' +
    'part of resuming. Faults with NotFound when the workflow is not visible, or Conflict when it ' +
    'is in a status that cannot be resumed (terminal or pending).',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: resumeWorkflowInput,
  outputSchema: resumeWorkflowOutput,
  producibleFaults: ['NotFound', 'Conflict'],
  invoke: async ({ input, engine }): Promise<ResumeWorkflowOutput> => {
    const handle = await engine.resume(input.workflowId);
    return { id: handle.id };
  },
  mapErrorToFault: ({ message }) =>
    message.includes('Cannot resume')
      ? {
          code: 'Conflict',
          message,
          data: { reason: message },
        }
      : undefined,
});

export const resumeWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/resume',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.resume',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => extractWorkflowIdFromPath(pathParams),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeRestFault,
};
