import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { mapScheduleErrorToFault } from './schedule-faults.ts';

const resumeScheduleInput = z.object({
  scheduleId: z.string().min(1),
});
const resumeScheduleOutput = z.undefined();

export type ResumeScheduleInput = z.infer<typeof resumeScheduleInput>;
export type ResumeScheduleOutput = z.infer<typeof resumeScheduleOutput>;

export const resumeScheduleOperation = defineOperation({
  name: 'weft.schedules.resume',
  mcpExposable: false,
  summary: 'Resume a recurring schedule',
  description:
    'Resume a paused recurring schedule by `scheduleId` so it begins launching workflows on ' +
    'its cadence again. Faults with NotFound when no schedule with the given id exists.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: resumeScheduleInput,
  outputSchema: resumeScheduleOutput,
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ResumeScheduleOutput> => {
    assertOperationEngineMethods(engine, ['resumeSchedule']);
    const typedEngine = engine;

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
};
