import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { mapScheduleErrorToFault } from './schedule-faults.ts';
import { parseOptionalScheduleRestBodyRecord } from './schedule-rest-body.ts';

const unskipScheduleInput = z.object({
  scheduleId: z.string().min(1).describe('Id of the schedule whose skipped run to take back.'),
  occurrence: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "The skipped run to start after all, as milliseconds since the epoch: one of the schedule's skippedOccurrences.",
    ),
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Take the skip back only if the schedule is still at this revision.'),
});
const unskipScheduleOutput = z.undefined();

/** The input of `weft.schedules.unskip`: the schedule, the skipped run, and the revision read. */
export type UnskipScheduleInput = z.infer<typeof unskipScheduleInput>;
/** The output of `weft.schedules.unskip`, which answers nothing. */
export type UnskipScheduleOutput = z.infer<typeof unskipScheduleOutput>;

/**
 * `weft.schedules.unskip` (COR-2018): takes back the skip of one upcoming run, so it starts a
 * workflow after all.
 */
export const unskipScheduleOperation = defineOperation({
  name: 'weft.schedules.unskip',
  mcpExposable: false,
  summary: 'Take back the skip of an upcoming run of a recurring schedule',
  description:
    'Take back the skip of one upcoming run of a recurring schedule by `scheduleId`: ' +
    '`occurrence`, one of the schedule’s `skippedOccurrences` in milliseconds since the epoch, ' +
    'starts a workflow after all. Like a skip it leaves `revision` and `nextFireAt` as they are. ' +
    'An upcoming run that is not skipped changes nothing. A run that has already passed cannot ' +
    'be taken back, and is refused with Conflict (reason `occurrence-not-next`). Pass ' +
    '`expectedRevision` to refuse it with StaleRevision when the schedule has changed since it ' +
    'was read; the revision is checked first. Faults with NotFound when no schedule with the ' +
    'given id exists, and with Conflict when the schedule is cancelled.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: unskipScheduleInput,
  outputSchema: unskipScheduleOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:write'] } },
  discoverable: true,
  producibleFaults: ['NotFound', 'Conflict', 'StaleRevision'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<UnskipScheduleOutput> => {
    assertOperationEngineMethods(engine, ['unskipScheduleOccurrence']);

    try {
      await engine.unskipScheduleOccurrence(input.scheduleId, {
        occurrence: input.occurrence,
        ...(input.expectedRevision !== undefined && { expectedRevision: input.expectedRevision }),
      });
      return undefined;
    } catch (error) {
      throw mapScheduleErrorToFault(input.scheduleId, error);
    }
  },
});

/** `POST /v1/schedules/:id/unskip`, the REST binding of `weft.schedules.unskip`. */
export const unskipScheduleRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/schedules/:id/unskip',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.unskip',
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
