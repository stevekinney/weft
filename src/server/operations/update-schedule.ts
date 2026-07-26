import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  mapScheduleErrorToFault,
  validateScheduleInputCadence,
  validateScheduleMutableOptions,
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
  scheduleId: z.string().min(1),
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
  overlap: z.unknown().optional(),
  backfill: z.unknown().optional(),
  jitter: z.unknown().optional(),
});

export type UpdateScheduleInput = z.infer<typeof updateScheduleInput>;

export const updateScheduleOperation = defineOperation<UpdateScheduleInput, null>({
  name: 'weft.schedules.update',
  mcpExposable: false,
  summary: 'Update a recurring schedule',
  description:
    'Update an existing recurring schedule by `id`, replacing its recurrence specification and ' +
    'optionally changing description, overlap, backfill, or jitter. Omitted options retain their ' +
    'persisted values; schedule id, workflow type, and input remain unchanged. Returns null on ' +
    'success. Faults with NotFound when no schedule with the given id exists and InvalidParams ' +
    'for malformed fields.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: updateScheduleInput,
  outputSchema: z.null(),
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict', 'InvalidParams'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<null> => {
    const typedEngine = engine as Engine;

    // Validate the cadence here so REST and JSON-RPC share one error path.
    const spec = validateScheduleInputCadence(input);
    const options = validateScheduleMutableOptions(input);

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
    cronExpression: { kind: 'body-field', bodyField: 'cronExpression' },
    every: { kind: 'body-field', bodyField: 'every' },
    description: { kind: 'body-field', bodyField: 'description' },
    overlap: { kind: 'body-field', bodyField: 'overlap' },
    backfill: { kind: 'body-field', bodyField: 'backfill' },
    jitter: { kind: 'body-field', bodyField: 'jitter' },
  },
  extractInput: async (request, pathParams, context) => {
    const record = await parseScheduleRestBodyRequestRecord(request, context);
    return {
      scheduleId: pathParams['id'] ?? '',
      ...extractSharedScheduleRestFields(record),
    };
  },
  success: { kind: 'empty', status: 204 },
};
