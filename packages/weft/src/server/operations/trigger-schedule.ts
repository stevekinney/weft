import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import type { ScheduleTriggerResult } from '../../core/types.ts';
import { mapScheduleErrorToFault } from './schedule-faults.ts';

const triggerScheduleInput = z.object({
  scheduleId: z.string().min(1).describe('Id of the schedule to run now.'),
});
const triggerScheduleOutput = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('started'),
    workflowId: z.string().describe('The id of the workflow run that started.'),
  }),
  z.object({
    outcome: z.literal('queued'),
    workflowId: z.string().describe('The id the queued run will start under.'),
  }),
  z.object({
    outcome: z.literal('skipped'),
    blockingWorkflowId: z
      .string()
      .optional()
      .describe('The run that was still going and kept this one from starting.'),
  }),
]);

export type TriggerScheduleInput = z.infer<typeof triggerScheduleInput>;
export type TriggerScheduleOutput = ScheduleTriggerResult;

export const triggerScheduleOperation = defineOperation({
  name: 'weft.schedules.runnow',
  mcpExposable: false,
  summary: 'Run a recurring schedule now',
  description:
    'Start one run of a recurring schedule by `scheduleId` now, under its overlap policy: the ' +
    'result says whether the run `started`, was `queued` behind the running one, or was ' +
    '`skipped` because one was still going. The run is not an occurrence of the cadence, so the ' +
    "schedule's next fire time and revision do not change, and the run's schedule metadata is " +
    'marked manual. A paused schedule can be run. Faults with NotFound when no schedule with the ' +
    'given id exists, and with Conflict when it has been cancelled.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: triggerScheduleInput,
  outputSchema: triggerScheduleOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:write'] } },
  discoverable: true,
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<TriggerScheduleOutput> => {
    assertOperationEngineMethods(engine, ['triggerSchedule']);

    try {
      return await engine.triggerSchedule(input.scheduleId);
    } catch (error) {
      throw mapScheduleErrorToFault(input.scheduleId, error);
    }
  },
});

export const triggerScheduleRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/schedules/:id/run-now',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.runnow',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    scheduleId: pathParams['id'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
};
