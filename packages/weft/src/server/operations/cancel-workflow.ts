import { z } from 'zod';

import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { workflowStatusSchema } from '../../core/list-filter-validation.ts';
import {
  createSingleWorkflowControlOperation,
  extractWorkflowIdFromPath,
} from './single-workflow-control-operation.ts';

const cancelWorkflowInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow to cancel.'),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'When true, report the workflow status and whether a cancel would take effect, and change nothing.',
    ),
});
const cancelWorkflowOutput = z.union([
  z.object({ workflowId: z.string(), status: z.literal('cancel-requested') }),
  z.object({
    workflowId: z.string(),
    status: z.literal('already-terminal'),
    terminalStatus: z.enum(['completed', 'failed', 'cancelled', 'timed-out']),
  }),
  z.object({
    dryRun: z.literal(true),
    workflowId: z.string(),
    status: workflowStatusSchema,
    cancellable: z.boolean(),
  }),
]);

export type CancelWorkflowInput = z.infer<typeof cancelWorkflowInput>;
export type CancelWorkflowOutput = z.infer<typeof cancelWorkflowOutput>;

export const cancelWorkflowOperation = createSingleWorkflowControlOperation({
  name: 'weft.workflows.cancel',
  summary: 'Cancel a running workflow',
  description:
    'Request cancellation of a running workflow by `id`. Cancellation is cooperative: the ' +
    'workflow observes a cancellation signal and unwinds via its own cleanup logic, so this ' +
    'is irreversible from the caller perspective. Pass `dryRun: true` to learn the ' +
    "workflow's status and whether a cancel would take effect, without cancelling. Faults " +
    'with NotFound when the workflow is not visible.',
  destructive: true,
  scope: 'workflows:write',
  tags: ['Workflows'],
  inputSchema: cancelWorkflowInput,
  outputSchema: cancelWorkflowOutput,
  producibleFaults: ['Conflict', 'NotFound'],
  mapErrorToFault: ({ message }) =>
    message.includes('replaced before it was cancelled.')
      ? {
          code: 'Conflict',
          message,
          data: { reason: 'workflow-replaced', publicReason: 'workflow-replaced' },
        }
      : undefined,
  requiredEngineMethods: ['cancel', 'previewCancel'],
  invoke: async ({ input, engine }): Promise<CancelWorkflowOutput> => {
    if (input.dryRun === true) return await engine.previewCancel(input.workflowId);
    return await engine.cancel(input.workflowId);
  },
});

export const cancelWorkflowRestBinding: UnknownRestBinding = {
  method: 'DELETE',
  path: '/v1/workflows/:id',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.cancel',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    dryRun: { kind: 'query', queryParam: 'dry_run' },
  },
  extractInput: async (request, pathParams) => {
    const dryRun = new URL(request.url).searchParams.get('dry_run');
    return {
      ...extractWorkflowIdFromPath(pathParams),
      // This operation is irreversible, so a value that is not exactly `true` or `false` (`1`,
      // `TRUE`, an empty string) is passed on as it came, for the schema to refuse, never read as
      // false.
      ...(dryRun === null
        ? {}
        : { dryRun: dryRun === 'true' ? true : dryRun === 'false' ? false : dryRun }),
    };
  },
  success: { kind: 'json', status: 200 },
};
