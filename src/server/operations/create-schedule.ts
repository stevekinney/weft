import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { ScheduleOptions } from '../../core/types.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault } from './operation-helpers.ts';
import {
  isOperationFault,
  mapScheduleErrorToFault,
  resolveScheduleAccessOptions,
  shapeScheduleFault,
} from './schedule-faults.ts';

const VALID_SCHEDULE_OVERLAP_POLICIES = new Set<NonNullable<ScheduleOptions['overlap']>>([
  'skip',
  'queue',
  'cancel-running',
  'allow',
]);

// Inputs are intentionally permissive at the schema boundary so legacy REST
// callers (and equivalent JSON-RPC callers) hit the same validation in
// `invoke()` rather than being rejected by Zod with a different error path.
// All field validation lives in `invoke()` to keep one cross-transport contract.
const createScheduleInput = z.object({
  type: z.unknown().describe('Workflow type name. Runtime validation requires a non-empty string.'),
  cronExpression: z
    .unknown()
    .describe('Cron expression. Runtime validation requires a non-empty string.'),
  input: z.unknown().optional(),
  id: z.unknown().optional(),
  overlap: z.unknown().optional(),
  backfill: z.unknown().optional(),
});

const createScheduleOutput = z.object({
  id: z.string(),
});

export type CreateScheduleInput = z.infer<typeof createScheduleInput>;
export type CreateScheduleOutput = z.infer<typeof createScheduleOutput>;

type ValidatedCreateScheduleInput = {
  type: string;
  cronExpression: string;
  id: string | undefined;
  overlap: NonNullable<ScheduleOptions['overlap']> | undefined;
  backfill: boolean | undefined;
};

/** Validate the required string fields type and cronExpression. */
function validateRequiredScheduleFields(
  input: CreateScheduleInput,
): { type: string; cronExpression: string } {
  if (typeof input.type !== 'string' || input.type.length === 0) {
    throw invalidParamsFault('Missing required field: type');
  }
  if (typeof input.cronExpression !== 'string' || input.cronExpression.length === 0) {
    throw invalidParamsFault('Missing required field: cronExpression');
  }
  return { type: input.type, cronExpression: input.cronExpression };
}

/** Validate optional schedule fields id, overlap, and backfill. */
function validateOptionalScheduleFields(input: CreateScheduleInput): {
  id: string | undefined;
  overlap: NonNullable<ScheduleOptions['overlap']> | undefined;
  backfill: boolean | undefined;
} {
  let validatedId: string | undefined;
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw invalidParamsFault('Field "id" must be a non-empty string');
    }
    validatedId = input.id;
  }

  let validatedOverlap: NonNullable<ScheduleOptions['overlap']> | undefined;
  if (input.overlap !== undefined) {
    if (typeof input.overlap !== 'string' || !isScheduleOverlapPolicy(input.overlap)) {
      throw invalidParamsFault(
        'Field "overlap" must be one of skip, queue, cancel-running, allow',
      );
    }
    validatedOverlap = input.overlap;
  }

  let validatedBackfill: boolean | undefined;
  if (input.backfill !== undefined) {
    if (typeof input.backfill !== 'boolean') {
      throw invalidParamsFault('Field "backfill" must be a boolean');
    }
    validatedBackfill = input.backfill;
  }

  return { id: validatedId, overlap: validatedOverlap, backfill: validatedBackfill };
}

/**
 * Validate `CreateScheduleInput` fields in legacy order:
 * type → cronExpression → id → overlap → backfill.
 *
 * Throws an `InvalidParams` fault on the first invalid field so both REST and
 * JSON-RPC callers receive the same error messages.
 */
function validateCreateScheduleInput(input: CreateScheduleInput): ValidatedCreateScheduleInput {
  const { type, cronExpression } = validateRequiredScheduleFields(input);
  const { id, overlap, backfill } = validateOptionalScheduleFields(input);
  return { type, cronExpression, id, overlap, backfill };
}

export const createScheduleOperation = defineOperation<CreateScheduleInput, CreateScheduleOutput>({
  name: 'weft.schedules.create',
  mcpExposable: false,
  summary: 'Create a recurring schedule',
  tags: ['Schedules'],
  inputSchema: createScheduleInput,
  outputSchema: createScheduleOutput,
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<CreateScheduleOutput> => {
    const typedEngine = engine as Engine;

    // All field validation lives here so REST and JSON-RPC clients both
    // receive the legacy error messages verbatim. Order matches legacy
    // `validateScheduleOptions`: type → cronExpression → id → overlap → backfill.
    const validated = validateCreateScheduleInput(input);

    const accessOptions = resolveScheduleAccessOptions(principal);
    if (isOperationFault(accessOptions)) {
      throw accessOptions;
    }

    const options: ScheduleOptions = {
      ...(validated.id !== undefined ? { id: validated.id } : {}),
      ...(validated.overlap !== undefined ? { overlap: validated.overlap } : {}),
      ...(validated.backfill !== undefined ? { backfill: validated.backfill } : {}),
    };

    try {
      const handle = await typedEngine.schedule(
        validated.type,
        input.input,
        validated.cronExpression,
        options,
        accessOptions,
      );
      return { id: handle.id };
    } catch (error) {
      // Engine errors map to the canonical schedule fault classification;
      // identifier defaults to the validated id when present.
      throw mapScheduleErrorToFault(validated.id ?? '', error);
    }
  },
});

function isScheduleOverlapPolicy(value: string): value is NonNullable<ScheduleOptions['overlap']> {
  return VALID_SCHEDULE_OVERLAP_POLICIES.has(value as NonNullable<ScheduleOptions['overlap']>);
}

export const createScheduleRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/schedules',
  pathParamNames: [],
  operationName: 'weft.schedules.create',
  inputSources: {
    type: { kind: 'body-field', bodyField: 'type' },
    cronExpression: { kind: 'body-field', bodyField: 'cronExpression' },
    input: { kind: 'body-field', bodyField: 'input' },
    id: { kind: 'body-field', bodyField: 'id' },
    overlap: { kind: 'body-field', bodyField: 'overlap' },
    backfill: { kind: 'body-field', bodyField: 'backfill' },
  },
  extractInput: async (request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw invalidParamsFault('Invalid JSON body');
    }

    // Legacy parity: arrays are typeof 'object' && !== null, so they pass
    // this guard and fall through to the type/cronExpression checks in
    // `invoke` (which is the single cross-transport validator).
    if (typeof body !== 'object' || body === null) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    return {
      type: record['type'],
      cronExpression: record['cronExpression'],
      input: record['input'],
      id: record['id'],
      overlap: record['overlap'],
      backfill: record['backfill'],
    };
  },
  success: { kind: 'json', status: 201 },
  shapeFault: shapeScheduleFault,
};
