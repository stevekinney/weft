import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { mapScheduleErrorToFault } from './schedule-faults.ts';
import { parseOptionalScheduleRestBodyRecord } from './schedule-rest-body.ts';

const skipNextScheduleInput = z.object({
  scheduleId: z.string().min(1).describe('Id of the schedule whose run to skip.'),
  occurrence: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "The run to skip, as milliseconds since the epoch: the schedule's next run or any upcoming run after it. Refused with Conflict when it is not an upcoming run of the schedule. Omitted, the next run is skipped.",
    ),
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Apply the skip only if the schedule is still at this revision.'),
});
const skipNextScheduleOutput = z.undefined();

export type SkipNextScheduleInput = z.infer<typeof skipNextScheduleInput>;
export type SkipNextScheduleOutput = z.infer<typeof skipNextScheduleOutput>;

export const skipNextScheduleOperation = defineOperation({
  name: 'weft.schedules.skipnext',
  mcpExposable: false,
  summary: 'Skip an upcoming run of a recurring schedule',
  description:
    'Skip one upcoming run of a recurring schedule by `scheduleId`: the occurrence named by ' +
    '`occurrence` (milliseconds since the epoch), the next run or any after it, starts no ' +
    'workflow, and the runs around it fire as usual. Omitted, the next run is skipped, whichever ' +
    'it is. In a time zone the next wake-up can be the end of a daylight-saving gap that starts ' +
    'nothing, so the next run is the next real one; a run that is due but has not started is the ' +
    'next run. Skipped runs are listed as `skippedOccurrences` on the schedule until it moves past ' +
    'them, and `weft.schedules.unskip` takes one back. The skip leaves `revision` and ' +
    '`nextFireAt` as they are, and skipping a run already skipped changes nothing. A paused ' +
    'schedule accepts a skip of its runs counted from the first after now, and keeps it for when ' +
    'it is resumed. A fire moves neither `revision` nor `status`, so the run a caller read can ' +
    'start before the skip is written: the skip is refused with Conflict (reason ' +
    '`occurrence-not-next`) when `occurrence` is not an upcoming run as the write lands, whether ' +
    'a fire passed it or the cadence starts no run then. A schedule keeps at most 100 skipped ' +
    'runs, and one more is a Conflict. Pass `expectedRevision` to refuse the skip with ' +
    'StaleRevision when the schedule has changed since it was read; the revision is checked first. ' +
    'Faults with NotFound when no schedule with the given id exists, and with Conflict when the ' +
    'schedule is cancelled.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: skipNextScheduleInput,
  outputSchema: skipNextScheduleOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:write'] } },
  discoverable: true,
  producibleFaults: ['NotFound', 'Conflict', 'StaleRevision'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<SkipNextScheduleOutput> => {
    assertOperationEngineMethods(engine, ['skipNextScheduleOccurrence']);

    try {
      await engine.skipNextScheduleOccurrence(input.scheduleId, {
        ...(input.occurrence !== undefined && { occurrence: input.occurrence }),
        ...(input.expectedRevision !== undefined && { expectedRevision: input.expectedRevision }),
      });
      return undefined;
    } catch (error) {
      throw mapScheduleErrorToFault(input.scheduleId, error);
    }
  },
});

export const skipNextScheduleRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/schedules/:id/skip-next',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.skipnext',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
    occurrence: { kind: 'body-field', bodyField: 'occurrence' },
    expectedRevision: { kind: 'body-field', bodyField: 'expectedRevision' },
  },
  extractInput: async (request, pathParams, context) => {
    const body = await parseOptionalScheduleRestBodyRecord(request, context);
    return {
      scheduleId: pathParams['id'] ?? '',
      occurrence: body['occurrence'],
      expectedRevision: body['expectedRevision'],
    };
  },
  success: { kind: 'empty', status: 204 },
};
