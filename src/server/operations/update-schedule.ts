import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';
import { mapScheduleErrorToFault } from './schedule-faults.ts';

// `cronExpression` is intentionally permissive at the schema boundary so REST
// and JSON-RPC clients hit the same validation in `invoke()`. `scheduleId`
// comes from the path on REST (and is required at the schema level for
// JSON-RPC); we keep the min-length guard.
const updateScheduleInput = z.object({
  scheduleId: z.string().min(1),
  cronExpression: z
    .unknown()
    .describe('Cron expression. Runtime validation requires a non-empty string.'),
});

export type UpdateScheduleInput = z.infer<typeof updateScheduleInput>;

export const updateScheduleOperation = defineOperation<UpdateScheduleInput, null>({
  name: 'weft.schedules.update',
  mcpExposable: false,
  summary: 'Update a recurring schedule',
  tags: ['Schedules'],
  inputSchema: updateScheduleInput,
  outputSchema: z.null(),
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<null> => {
    const typedEngine = engine as Engine;

    // Validate cronExpression here so REST and JSON-RPC share one error path.
    if (typeof input.cronExpression !== 'string' || input.cronExpression.length === 0) {
      throw invalidParamsFault('Missing required field: cronExpression');
    }
    const cronExpression = input.cronExpression;

    try {
      await typedEngine.updateSchedule(input.scheduleId, cronExpression);
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
  },
  extractInput: async (request, pathParams) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw invalidParamsFault('Invalid JSON body');
    }

    // arrays are typeof 'object' && !== null, so they pass
    // this guard and fall through to the cronExpression check in `invoke`.
    if (typeof body !== 'object' || body === null) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    return {
      scheduleId: pathParams['id'] ?? '',
      cronExpression: record['cronExpression'],
    };
  },
  success: { kind: 'empty', status: 204 },
  shapeFault: shapeRestFault,
};
