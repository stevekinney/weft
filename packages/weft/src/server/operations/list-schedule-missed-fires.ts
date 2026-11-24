import { invalidParamsFault, type UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import { SCHEDULE_MISSED_FIRE_LIMIT, type ScheduleMissedFire } from '../../core/types.ts';
import { mapScheduleErrorToFault } from './schedule-faults.ts';

const listScheduleMissedFiresInput = z.object({
  scheduleId: z.string().min(1).describe('Id of the schedule whose missed runs to read.'),
  limit: z
    .unknown()
    .optional()
    .describe(
      `Maximum number of rows to return, newest first. At most ${SCHEDULE_MISSED_FIRE_LIMIT}, which is also the default.`,
    ),
});
const listScheduleMissedFiresOutput = z.object({
  missed: z.array(
    z.object({
      scheduleId: z.string(),
      occurrence: z.number().int().describe('Epoch milliseconds the miss is recorded at.'),
      reason: z.enum(['late', 'dst-gap']),
      count: z.number().int().describe('How many occurrences the row stands for.'),
      recordedAt: z.number().int().describe('Epoch milliseconds the schedule recorded the miss.'),
    }),
  ),
});

export type ListScheduleMissedFiresInput = z.infer<typeof listScheduleMissedFiresInput>;
export type ListScheduleMissedFiresOutput = { missed: ScheduleMissedFire[] };

export const listScheduleMissedFiresOperation = defineOperation({
  name: 'weft.schedules.missed',
  mcpExposable: false,
  summary: 'List the runs a recurring schedule missed',
  description:
    'List the occurrences a recurring schedule missed, newest first, by `scheduleId`. A row is ' +
    "`late` when the schedule's timer reached the occurrence too late to run it (as after the " +
    'engine was down), or `dst-gap` when the wall-clock time did not exist because the clock ' +
    'sprang forward. A schedule keeps its most recent ' +
    `${SCHEDULE_MISSED_FIRE_LIMIT} rows, while its missed fire count keeps counting. Read-only. ` +
    'Faults with NotFound when no schedule with the given id exists.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: listScheduleMissedFiresInput,
  outputSchema: listScheduleMissedFiresOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:read'] } },
  discoverable: true,
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<ListScheduleMissedFiresOutput> => {
    assertOperationEngineMethods(engine, ['listScheduleMissedFires']);
    let limit: number | undefined;
    if (input.limit !== undefined) {
      limit = Number(input.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        throw invalidParamsFault('Query parameter "limit" must be a positive integer');
      }
    }

    try {
      const missed = await engine.listScheduleMissedFires(
        input.scheduleId,
        limit === undefined ? undefined : { limit },
      );
      if (missed === null) {
        throw new Error(`Schedule "${input.scheduleId}" not found`);
      }
      return { missed };
    } catch (error) {
      throw mapScheduleErrorToFault(input.scheduleId, error);
    }
  },
});

export const listScheduleMissedFiresRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/schedules/:id/missed',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.missed',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
    limit: { kind: 'query', queryParam: 'limit' },
  },
  extractInput: async (request, pathParams) => {
    const limit = new URL(request.url).searchParams.get('limit');
    return {
      scheduleId: pathParams['id'] ?? '',
      ...(limit === null ? {} : { limit }),
    };
  },
  success: { kind: 'json', status: 200 },
};
