import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { mapScheduleErrorToFault } from './schedule-faults.ts';

const pauseScheduleInput = z.object({
  scheduleId: z.string().min(1).describe('Id of the schedule to pause.'),
});
const pauseScheduleOutput = z.undefined();

export type PauseScheduleInput = z.infer<typeof pauseScheduleInput>;
export type PauseScheduleOutput = z.infer<typeof pauseScheduleOutput>;

export const pauseScheduleOperation = defineOperation({
  name: 'weft.schedules.pause',
  mcpExposable: false,
  summary: 'Pause a recurring schedule',
  description:
    'Pause a recurring schedule by `scheduleId` so it stops launching new workflows while ' +
    'retaining its definition. Reversible via resume. Faults with NotFound when no schedule ' +
    'with the given id exists.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: pauseScheduleInput,
  outputSchema: pauseScheduleOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:write'] } },
  discoverable: true,
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<PauseScheduleOutput> => {
    assertOperationEngineMethods(engine, ['pauseSchedule']);
    const typedEngine = engine;

    try {
      await typedEngine.pauseSchedule(input.scheduleId);
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
};
