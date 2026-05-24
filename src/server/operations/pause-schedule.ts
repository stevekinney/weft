import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';
import { mapScheduleErrorToFault } from './schedule-faults.ts';

const pauseScheduleInput = z.object({
  scheduleId: z.string().min(1),
});
const pauseScheduleOutput = z.undefined();

export type PauseScheduleInput = z.infer<typeof pauseScheduleInput>;
export type PauseScheduleOutput = z.infer<typeof pauseScheduleOutput>;

export const pauseScheduleOperation = defineOperation<PauseScheduleInput, PauseScheduleOutput>({
  name: 'weft.schedules.pause',
  mcpExposable: false,
  summary: 'Pause a recurring schedule',
  tags: ['Schedules'],
  inputSchema: pauseScheduleInput,
  outputSchema: pauseScheduleOutput as z.ZodType<PauseScheduleOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<PauseScheduleOutput> => {
    const e = engine as Engine;

    try {
      await e.pauseSchedule(input.scheduleId, undefined);
      return undefined;
    } catch (error) {
      throw mapScheduleErrorToFault(input.scheduleId, error);
    }
  },
});

export const pauseScheduleRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/schedules/:id/pause',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.pause',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    scheduleId: pathParams['id'] ?? '',
  }),
  success: { kind: 'empty', status: 204 },
  shapeFault: shapeRestFault,
};
