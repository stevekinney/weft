import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';
import { mapScheduleErrorToFault } from './schedule-faults.ts';

const cancelScheduleInput = z.object({
  scheduleId: z.string().min(1),
});
const cancelScheduleOutput = z.undefined();

export type CancelScheduleInput = z.infer<typeof cancelScheduleInput>;
export type CancelScheduleOutput = z.infer<typeof cancelScheduleOutput>;

export const cancelScheduleOperation = defineOperation<CancelScheduleInput, CancelScheduleOutput>({
  name: 'weft.schedules.cancel',
  mcpExposable: false,
  summary: 'Cancel a recurring schedule',
  destructive: true,
  tags: ['Schedules'],
  inputSchema: cancelScheduleInput,
  outputSchema: cancelScheduleOutput as z.ZodType<CancelScheduleOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<CancelScheduleOutput> => {
    const typedEngine = engine as Engine;

    try {
      await typedEngine.cancelSchedule(input.scheduleId);
      return undefined;
    } catch (error) {
      throw mapScheduleErrorToFault(input.scheduleId, error);
    }
  },
});

export const cancelScheduleRestBinding: UnknownRestBinding = {
  method: 'DELETE',
  path: '/v1/schedules/:id',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.cancel',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    scheduleId: pathParams['id'] ?? '',
  }),
  success: { kind: 'empty', status: 204 },
  shapeFault: shapeRestFault,
};
