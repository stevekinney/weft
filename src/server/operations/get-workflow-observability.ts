import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { WorkflowFinalizerStatus, WorkflowScheduleProvenance } from '../../core/types.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const workflowObservabilityInput = z.object({
  workflowId: z.string().min(1),
});

const scheduleProvenanceOutput = z
  .object({
    scheduleId: z.string(),
    occurrence: z.number().optional(),
  })
  .nullable();

const finalizerStatusOutput = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('pending'), attempts: z.number().int().nonnegative() }),
    z.object({
      status: z.literal('running'),
      attempts: z.number().int().positive(),
      startedAt: z.number().nonnegative(),
    }),
    z.object({
      status: z.literal('succeeded'),
      attempts: z.number().int().positive(),
      completedAt: z.number().nonnegative(),
    }),
    z.object({
      status: z.literal('failed'),
      attempts: z.number().int().nonnegative(),
      failedAt: z.number().nonnegative(),
      error: z.string(),
    }),
  ])
  .nullable();

export type GetWorkflowObservabilityInput = z.infer<typeof workflowObservabilityInput>;
export type GetWorkflowScheduleProvenanceOutput = WorkflowScheduleProvenance | null;
export type GetWorkflowFinalizerOutput = WorkflowFinalizerStatus | null;

export const getWorkflowScheduleProvenanceOperation = defineOperation<
  GetWorkflowObservabilityInput,
  GetWorkflowScheduleProvenanceOutput
>({
  name: 'weft.workflows.scheduleprovenance.get',
  mcpExposable: false,
  summary: 'Get the schedule occurrence that launched a workflow',
  description:
    'Read the durable schedule id and optional occurrence timestamp that launched a workflow. ' +
    'Returns null for runs that were not launched by a schedule or whose workflow history was purged.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: workflowObservabilityInput,
  // Zod models an optional property as `number | undefined`; Engine omits the
  // property entirely under exactOptionalPropertyTypes.
  outputSchema: scheduleProvenanceOutput as z.ZodType<GetWorkflowScheduleProvenanceOutput>,
  access: { kind: 'public' },
  producibleFaults: [],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }) => (engine as Engine).getScheduleProvenance(input.workflowId),
});

export const getWorkflowFinalizerOperation = defineOperation<
  GetWorkflowObservabilityInput,
  GetWorkflowFinalizerOutput
>({
  name: 'weft.workflows.finalizer.get',
  mcpExposable: false,
  summary: 'Get workflow finalizer progress and outcome',
  description:
    'Read durable post-terminal finalizer progress or its succeeded or failed outcome. ' +
    'Returns null when the workflow did not record finalizer work.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: workflowObservabilityInput,
  outputSchema: finalizerStatusOutput,
  access: { kind: 'public' },
  producibleFaults: [],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }) => (engine as Engine).getFinalizerStatus(input.workflowId),
});

export const getWorkflowScheduleProvenanceRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/schedule-provenance',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.scheduleprovenance.get',
  inputSources: { workflowId: { kind: 'path', pathParam: 'id' } },
  extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeRestFault,
};

export const getWorkflowFinalizerRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/finalizer',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.finalizer.get',
  inputSources: { workflowId: { kind: 'path', pathParam: 'id' } },
  extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeRestFault,
};

export const workflowObservabilityRestBindings = [
  getWorkflowScheduleProvenanceRestBinding,
  getWorkflowFinalizerRestBinding,
] as const;

export const workflowObservabilityOperations = [
  getWorkflowScheduleProvenanceOperation,
  getWorkflowFinalizerOperation,
] as const;
