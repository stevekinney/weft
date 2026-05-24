/**
 * `weft.schedules.get` operation + REST binding.
 *
 * Returns a single recurring schedule by id. Respects the JWT tenant
 * scope check applied to schedule reads: when the
 * principal carries a JWT with a tenant claim, access is limited to
 * that tenant's schedules.
 *
 * @module server/operations/get-schedule
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { ScheduleSummary } from '../../core/types.ts';
import { raiseFault } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';
import { isOperationFault, resolveScheduleAccessOptions } from './schedule-faults.ts';

const getScheduleInput = z.object({
  scheduleId: z.string().min(1),
  // Optional JWT tenant override — same injection pattern as list-schedules.
  _resolvedTenantId: z.string().optional(),
});

const getScheduleOutput = z.unknown();

export type GetScheduleInput = z.infer<typeof getScheduleInput>;
export type GetScheduleOutput = ScheduleSummary;

export const getScheduleOperation = defineOperation<GetScheduleInput, GetScheduleOutput>({
  name: 'weft.schedules.get',
  mcpExposable: false,
  summary: 'Get a recurring schedule by id',
  tags: ['Schedules'],
  inputSchema: getScheduleInput,
  outputSchema: getScheduleOutput as z.ZodType<GetScheduleOutput>,
  access: { kind: 'authenticated' },
  producibleFaults: ['NotFound', 'Conflict'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<GetScheduleOutput> => {
    const e = engine as Engine;
    const accessOptions = resolveScheduleAccessOptions(principal);
    if (isOperationFault(accessOptions)) {
      throw accessOptions;
    }

    if (
      input._resolvedTenantId !== undefined &&
      accessOptions?.tenantId !== undefined &&
      input._resolvedTenantId !== accessOptions.tenantId
    ) {
      raiseFault(getScheduleOperation, {
        code: 'Forbidden',
        message: 'Schedule access is limited to the authenticated tenant',
        data: { reason: 'tenantId mismatch with JWT claim' },
      });
    }

    const schedule = await e.getSchedule(input.scheduleId, accessOptions);
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
