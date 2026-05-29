import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';
import { mapScheduleErrorToFault, validateScheduleInputCadence } from './schedule-faults.ts';

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
});

export type UpdateScheduleInput = z.infer<typeof updateScheduleInput>;

export const updateScheduleOperation = defineOperation<UpdateScheduleInput, null>({
  name: 'weft.schedules.update',
  mcpExposable: false,
  summary: 'Update a recurring schedule',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: updateScheduleInput,
  outputSchema: z.null(),
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<null> => {
    const typedEngine = engine as Engine;

    // Validate the cadence here so REST and JSON-RPC share one error path.
    const spec = validateScheduleInputCadence(input);

    try {
      await typedEngine.updateSchedule(input.scheduleId, spec);
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
  },
  extractInput: async (request, pathParams) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw invalidParamsFault('Invalid JSON body');
    }

    // arrays are typeof 'object' && !== null, so they pass
    // this guard and fall through to the cadence check in `invoke`.
    if (typeof body !== 'object' || body === null) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    // Read own properties only so an array body (whose prototype carries an
    // `every` method) does not masquerade as an interval spec.
    return {
      scheduleId: pathParams['id'] ?? '',
      cronExpression: Object.hasOwn(record, 'cronExpression')
        ? record['cronExpression']
        : undefined,
      every: Object.hasOwn(record, 'every') ? record['every'] : undefined,
    };
  },
  success: { kind: 'empty', status: 204 },
  shapeFault: shapeRestFault,
};
