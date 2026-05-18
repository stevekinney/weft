/**
 * `weft.schedules.list` operation + REST binding.
 *
 * Lists recurring schedules with optional filtering. REST response matches
 * the legacy `handleListSchedules` shape: 200 with the paginated result,
 * 400 for bad query params, or a JSON `{ error: <message> }` for other failures.
 *
 * @module server/operations/list-schedules
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type {
  PaginatedResult,
  ScheduleFilter,
  ScheduleStatus,
  ScheduleSummary,
} from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';
import { isOperationFault, resolveScheduleAccessOptions } from './schedule-faults.ts';

const VALID_SCHEDULE_STATUSES = new Set<string>(['active', 'paused', 'cancelled']);

function isValidScheduleStatus(value: string): value is ScheduleStatus {
  return VALID_SCHEDULE_STATUSES.has(value);
}

const listSchedulesInput = z.object({
  status: z.unknown().optional(),
  workflowType: z.unknown().optional(),
  tenantId: z.unknown().optional(),
  limit: z.unknown().optional(),
  offset: z.unknown().optional(),
  // JWT-authenticated tenant scope resolved by the authorize hook, not
  // passed directly by the caller. Stored on input so the hook can
  // inject it without touching the raw query string.
  _resolvedTenantId: z.string().optional(),
});

const listSchedulesOutput = z.unknown();

export type ListSchedulesInput = z.infer<typeof listSchedulesInput>;
export type ListSchedulesOutput = PaginatedResult<ScheduleSummary>;

/** Apply the status filter dimension, normalizing scalar to single-element form. */
function applyStatusFilter(filter: ScheduleFilter, input: ListSchedulesInput): void {
  if (input.status === undefined) return;

  const statuses = Array.isArray(input.status) ? input.status : [input.status];
  const normalized: ScheduleStatus[] = [];
  for (const s of statuses) {
    if (typeof s !== 'string' || !isValidScheduleStatus(s)) {
      throw invalidParamsFault('Query parameter "status" must be one of active, paused, cancelled');
    }
    normalized.push(s);
  }

  if (normalized.length === 1 && normalized[0] !== undefined) {
    filter.status = normalized[0];
  } else if (normalized.length > 1) {
    filter.status = normalized;
  }
}

/** Apply workflowType and tenantId filter dimensions. */
function applyScheduleTypeAndTenantFilter(filter: ScheduleFilter, input: ListSchedulesInput): void {
  if (input.workflowType !== undefined) {
    if (typeof input.workflowType !== 'string') {
      throw invalidParamsFault('Query parameter "workflowType" must be a string');
    }
    filter.workflowType = input.workflowType;
  }

  if (input.tenantId !== undefined) {
    if (typeof input.tenantId !== 'string') {
      throw invalidParamsFault('Query parameter "tenantId" must be a string');
    }
    filter.tenantId = input.tenantId;
  }
}

const TENANT_MISMATCH_FAULT: OperationFault = {
  code: 'Forbidden',
  message: 'Schedule access is limited to the authenticated tenant',
  data: { reason: 'tenantId mismatch with JWT claim' },
};

/** Enforce JWT tenant scope after tenantId is set on the filter. */
function applyTenantScope(
  filter: ScheduleFilter,
  input: ListSchedulesInput,
  resolvedTenantId: string | undefined,
): void {
  if (
    input._resolvedTenantId !== undefined &&
    resolvedTenantId !== undefined &&
    input._resolvedTenantId !== resolvedTenantId
  ) {
    throw TENANT_MISMATCH_FAULT;
  }

  if (resolvedTenantId !== undefined) {
    // If the caller also passed tenantId and it disagrees, that is a
    // scope-mismatch — the tenant scope wins.
    if (filter.tenantId !== undefined && filter.tenantId !== resolvedTenantId) {
      throw TENANT_MISMATCH_FAULT;
    }
    filter.tenantId = resolvedTenantId;
  }
}

/** Apply pagination filter dimensions (limit and offset). */
function applyPaginationFilter(filter: ScheduleFilter, input: ListSchedulesInput): void {
  if (input.limit !== undefined) {
    const parsed = Number(input.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw invalidParamsFault('Query parameter "limit" must be a positive integer');
    }
    filter.limit = Math.min(parsed, 1000);
  }

  if (input.offset !== undefined) {
    const parsed = Number(input.offset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw invalidParamsFault('Query parameter "offset" must be a non-negative integer');
    }
    filter.offset = parsed;
  }
}

/**
 * Validate query parameters and build a `ScheduleFilter` from the operation
 * input. Field-validation order mirrors the legacy `parseScheduleListFilter`:
 * status → workflowType → tenantId → (tenant-scope checks) → limit → offset.
 *
 * Tenant-scope enforcement happens after the tenantId field so that
 * JWT-claim mismatches are caught before pagination params are validated.
 */
function validateListSchedulesQuery(
  input: ListSchedulesInput,
  resolvedTenantId: string | undefined,
): ScheduleFilter {
  const filter: ScheduleFilter = {};
  applyStatusFilter(filter, input);
  applyScheduleTypeAndTenantFilter(filter, input);
  applyTenantScope(filter, input, resolvedTenantId);
  applyPaginationFilter(filter, input);
  return filter;
}

export const listSchedulesOperation = defineOperation<ListSchedulesInput, ListSchedulesOutput>({
  name: 'weft.schedules.list',
  mcpExposable: false,
  summary: 'List recurring schedules',
  tags: ['Schedules'],
  inputSchema: listSchedulesInput,
  outputSchema: listSchedulesOutput as z.ZodType<ListSchedulesOutput>,
  access: { kind: 'authenticated' },
  producibleFaults: ['Conflict'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<ListSchedulesOutput> => {
    const e = engine as Engine;

    // Build the ScheduleFilter from the validated input. Field-level
    // validation mirrors the legacy `parseScheduleListFilter` exactly.
    const accessOptions = resolveScheduleAccessOptions(principal);
    if (isOperationFault(accessOptions)) {
      throw accessOptions;
    }
    const resolvedTenantId = accessOptions?.tenantId;
    const filter = validateListSchedulesQuery(input, resolvedTenantId);

    return e.listSchedules(filter);
  },
});

function shapeListSchedulesFault(fault: OperationFault): Response {
  return shapeRestFault(fault);
}

export const listSchedulesRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/schedules',
  pathParamNames: [],
  operationName: 'weft.schedules.list',
  inputSources: {
    status: { kind: 'query', queryParam: 'status' },
    workflowType: { kind: 'query', queryParam: 'workflowType' },
    tenantId: { kind: 'query', queryParam: 'tenantId' },
    limit: { kind: 'query', queryParam: 'limit' },
    offset: { kind: 'query', queryParam: 'offset' },
  },
  extractInput: async (request) => {
    const url = new URL(request.url);
    const statusValues = url.searchParams.getAll('status');
    const result: ListSchedulesInput = {};

    if (statusValues.length === 1) {
      result.status = statusValues[0];
    } else if (statusValues.length > 1) {
      result.status = statusValues;
    }

    const workflowType = url.searchParams.get('workflowType');
    if (workflowType !== null) result.workflowType = workflowType;

    const tenantId = url.searchParams.get('tenantId');
    if (tenantId !== null) result.tenantId = tenantId;

    const limit = url.searchParams.get('limit');
    if (limit !== null) result.limit = limit;

    const offset = url.searchParams.get('offset');
    if (offset !== null) result.offset = offset;

    return result;
  },
  success: { kind: 'json', status: 200 },
  shapeFault: shapeListSchedulesFault,
};
