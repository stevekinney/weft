/**
 * `weft.schedules.get` operation + REST binding.
 *
 * Returns a single recurring schedule by id.
 *
 * @module server/operations/get-schedule
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { ScheduleSummary } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const getScheduleInput = z.object({
  scheduleId: z.string().min(1),
});

const getScheduleOutput = z.unknown();

export type GetScheduleInput = z.infer<typeof getScheduleInput>;
export type GetScheduleOutput = ScheduleSummary;

export const getScheduleOperation = defineOperation<GetScheduleInput, GetScheduleOutput>({
  name: 'weft.schedules.get',
  mcpExposable: false,
  summary: 'Get a recurring schedule by id',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: getScheduleInput,
  outputSchema: getScheduleOutput as z.ZodType<GetScheduleOutput>,
  access: { kind: 'authenticated' },
  producibleFaults: ['NotFound', 'Conflict'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetScheduleOutput> => {
    const e = engine as Engine;
    const schedule = await e.getSchedule(input.scheduleId);
    if (schedule === null) {
      const notFoundFault: OperationFault = {
        code: 'NotFound',
        message: `Schedule "${input.scheduleId}" not found`,
        data: { resource: 'schedule', identifier: input.scheduleId },
      };
      throw notFoundFault;
    }
    return schedule;
  },
});

function shapeGetScheduleFault(fault: OperationFault): Response {
  return shapeRestFault(fault);
}

export const getScheduleRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/schedules/:id',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.get',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    scheduleId: pathParams['id'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeGetScheduleFault,
};
