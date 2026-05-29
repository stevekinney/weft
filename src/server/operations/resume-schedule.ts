import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';
import { mapScheduleErrorToFault } from './schedule-faults.ts';

const resumeScheduleInput = z.object({
  scheduleId: z.string().min(1),
});
const resumeScheduleOutput = z.undefined();

export type ResumeScheduleInput = z.infer<typeof resumeScheduleInput>;
export type ResumeScheduleOutput = z.infer<typeof resumeScheduleOutput>;

export const resumeScheduleOperation = defineOperation<ResumeScheduleInput, ResumeScheduleOutput>({
  name: 'weft.schedules.resume',
  mcpExposable: false,
  summary: 'Resume a recurring schedule',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: resumeScheduleInput,
  outputSchema: resumeScheduleOutput as z.ZodType<ResumeScheduleOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ResumeScheduleOutput> => {
    const typedEngine = engine as Engine;

    try {
      await typedEngine.resumeSchedule(input.scheduleId);
      return undefined;
    } catch (error) {
      throw mapScheduleErrorToFault(input.scheduleId, error);
    }
  },
});

export const resumeScheduleRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/schedules/:id/resume',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.resume',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    scheduleId: pathParams['id'] ?? '',
  }),
  success: { kind: 'empty', status: 204 },
  shapeFault: shapeRestFault,
};
