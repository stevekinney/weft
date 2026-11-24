import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import {
  mapScheduleErrorToFault,
  validateScheduleInputCadence,
  validateScheduleMutableOptions,
  validateScheduleWorkflowType,
} from './schedule-faults.ts';
import {
  extractSharedScheduleRestFields,
  parseScheduleRestBodyRequestRecord,
} from './schedule-rest-body.ts';

// `cronExpression`/`every` are intentionally permissive at the schema boundary
// so REST and JSON-RPC clients hit the same validation in `invoke()`.
// `scheduleId` comes from the path on REST (and is required at the schema level
// for JSON-RPC); we keep the min-length guard.
const updateScheduleInput = z.object({
  scheduleId: z.string().min(1).describe('Id of the schedule to update.'),
  workflowType: z
    .unknown()
    .optional()
    .describe(
      'The workflow type each fire starts from now on; a non-empty string. Omitted, the schedule keeps its workflow type. A pinned schedule re-captures its pin against the new type.',
    ),
  input: z
    .unknown()
    .optional()
    .describe(
      'The input each fire starts the workflow with from now on, replacing the stored input whole. Omitted, the schedule keeps its input.',
    ),
  cronExpression: z
    .unknown()
    .optional()
    .describe(
      'Cron expression. Supply exactly one of cronExpression or every; runtime validation requires a non-empty string.',
    ),
  every: z
    .unknown()
    .optional()
    .describe(
      'Interval period (duration string or milliseconds). Supply exactly one of cronExpression or every.',
    ),
  description: z
    .unknown()
    .optional()
    .describe('Operator-facing schedule description. Runtime validation requires a string.'),
  overlap: z
    .unknown()
    .optional()
    .describe(
      'What to do when a tick fires while the previous run is still active: "skip", "queue", "cancel-running", or "allow".',
    ),
  backfill: z
    .unknown()
    .optional()
    .describe(
      "When true, ticks missed during downtime are run on recovery; when false late ticks are skipped. Omit it to keep the schedule's current setting.",
    ),
  jitter: z
    .unknown()
    .optional()
    .describe(
      'Deterministic delay spread over each occurrence, as milliseconds or a duration string such as "30s".',
    ),
  timeZone: z
    .unknown()
    .optional()
    .describe(
      'IANA time zone the cron expression is read in, such as "America/Los_Angeles", or "UTC". Omitted, a new schedule runs in UTC and an update keeps the schedule\'s zone. Only a cronExpression schedule takes one. A wall-clock time the clock skips when it springs forward is recorded as a missed fire, and one it repeats when it falls back runs once.',
    ),
  revisionPolicy: z
    .unknown()
    .optional()
    .describe(
      'Revision policy (WFT-20). Runtime validation requires "active-at-fire" or "pinned". Omitted preserves the current policy (and pin); "pinned" always re-resolves and re-captures the pin against the revision active right now.',
    ),
  metadata: z
    .unknown()
    .optional()
    .describe(
      'A plain JSON object stored with the schedule and returned with it, replacing the stored metadata whole. Omitted, the schedule keeps its metadata. It is not passed to the runs the schedule starts.',
    ),
});

export type UpdateScheduleInput = z.infer<typeof updateScheduleInput>;

export const updateScheduleOperation = defineOperation({
  name: 'weft.schedules.update',
  mcpExposable: false,
  summary: 'Update a recurring schedule',
  description:
    'Update an existing recurring schedule by `id`, replacing its recurrence specification and ' +
    'optionally changing description, overlap, backfill, jitter, or the IANA `timeZone` of a cron ' +
    'schedule, and the `workflowType` and `input` each fire starts with. Omitted options retain their ' +
    'persisted values; the schedule id never changes. Returns null on ' +
    'success. Faults with NotFound when no schedule with the given id exists and InvalidParams ' +
    'for malformed fields or an unknown time zone.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: updateScheduleInput,
  outputSchema: z.null(),
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:write'] } },
  discoverable: true,
  producibleFaults: ['NotFound', 'Conflict', 'InvalidParams'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<null> => {
    assertOperationEngineMethods(engine, ['updateSchedule']);
    const typedEngine = engine;

    // Validate the cadence here so REST and JSON-RPC share one error path.
    const spec = validateScheduleInputCadence(input);
    const options = validateScheduleMutableOptions(input);
    const workflowType = validateScheduleWorkflowType(input.workflowType);
    if (workflowType !== undefined) options.workflowType = workflowType;
    if (input.input !== undefined) options.input = input.input;

    try {
      await typedEngine.updateSchedule(input.scheduleId, spec, options);
      return null;
    } catch (error) {
      throw mapScheduleErrorToFault(input.scheduleId, error);
    }
  },
});

export const updateScheduleRestBinding: UnknownRestBinding = {
  method: 'PATCH',
  path: '/v1/schedules/:id',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.update',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
    workflowType: { kind: 'body-field', bodyField: 'workflowType' },
    input: { kind: 'body-field', bodyField: 'input' },
    cronExpression: { kind: 'body-field', bodyField: 'cronExpression' },
    every: { kind: 'body-field', bodyField: 'every' },
    description: { kind: 'body-field', bodyField: 'description' },
    overlap: { kind: 'body-field', bodyField: 'overlap' },
    backfill: { kind: 'body-field', bodyField: 'backfill' },
    jitter: { kind: 'body-field', bodyField: 'jitter' },
    timeZone: { kind: 'body-field', bodyField: 'timeZone' },
    revisionPolicy: { kind: 'body-field', bodyField: 'revisionPolicy' },
    metadata: { kind: 'body-field', bodyField: 'metadata' },
  },
  extractInput: async (request, pathParams, context) => {
    const record = await parseScheduleRestBodyRequestRecord(request, context);
    return {
      scheduleId: pathParams['id'] ?? '',
      workflowType: record['workflowType'],
      input: record['input'],
      ...extractSharedScheduleRestFields(record),
    };
  },
  success: { kind: 'empty', status: 204 },
};
