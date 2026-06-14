import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { ScheduleOptions, ScheduleSpec } from '../../core/types.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { readRestJsonBody } from '../rest-body.ts';
import { invalidParamsFault, isOperationFault, shapeRestFault } from './operation-helpers.ts';
import { mapScheduleErrorToFault, validateScheduleInputCadence } from './schedule-faults.ts';

const VALID_SCHEDULE_OVERLAP_POLICIES = new Set<NonNullable<ScheduleOptions['overlap']>>([
  'skip',
  'queue',
  'cancel-running',
  'allow',
]);

// Inputs are intentionally permissive at the schema boundary so REST
// callers (and equivalent JSON-RPC callers) hit the same validation in
// `invoke()` rather than being rejected by Zod with a different error path.
// All field validation lives in `invoke()` to keep one cross-transport contract.
const createScheduleInput = z.object({
  type: z.unknown().describe('Workflow type name. Runtime validation requires a non-empty string.'),
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
  input: z.unknown().optional(),
  id: z.unknown().optional(),
  overlap: z.unknown().optional(),
  backfill: z.unknown().optional(),
  jitter: z.unknown().optional(),
});

const createScheduleOutput = z.object({
  id: z.string(),
});

export type CreateScheduleInput = z.infer<typeof createScheduleInput>;
export type CreateScheduleOutput = z.infer<typeof createScheduleOutput>;

type ValidatedCreateScheduleInput = {
  type: string;
  spec: ScheduleSpec;
  id: string | undefined;
  overlap: NonNullable<ScheduleOptions['overlap']> | undefined;
  backfill: boolean | undefined;
  jitter: ScheduleOptions['jitter'] | undefined;
};

/** Validate the required `type` field and the mutually exclusive cadence (cronExpression or every). */
function validateRequiredScheduleFields(input: CreateScheduleInput): {
  type: string;
  spec: ScheduleSpec;
} {
  if (typeof input.type !== 'string' || input.type.length === 0) {
    throw invalidParamsFault('Missing required field: type');
  }
  return { type: input.type, spec: validateScheduleInputCadence(input) };
}

/** Validate optional schedule fields id, overlap, backfill, and jitter. */
function validateOptionalScheduleFields(input: CreateScheduleInput): {
  id: string | undefined;
  overlap: NonNullable<ScheduleOptions['overlap']> | undefined;
  backfill: boolean | undefined;
  jitter: ScheduleOptions['jitter'] | undefined;
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
      throw invalidParamsFault('Field "overlap" must be one of skip, queue, cancel-running, allow');
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

  let validatedJitter: ScheduleOptions['jitter'] | undefined;
  if (input.jitter !== undefined) {
    if (typeof input.jitter !== 'string' && typeof input.jitter !== 'number') {
      throw invalidParamsFault(
        'Field "jitter" must be a duration string or a number of milliseconds',
      );
    }
    validatedJitter = input.jitter;
  }

  return {
    id: validatedId,
    overlap: validatedOverlap,
    backfill: validatedBackfill,
    jitter: validatedJitter,
  };
}

/**
 * Validate `CreateScheduleInput` fields in order:
 * type → cadence (cronExpression or every) → id → overlap → backfill → jitter.
 *
 * Throws an `InvalidParams` fault on the first invalid field so both REST and
 * JSON-RPC callers receive the same error messages.
 */
function validateCreateScheduleInput(input: CreateScheduleInput): ValidatedCreateScheduleInput {
  const { type, spec } = validateRequiredScheduleFields(input);
  const { id, overlap, backfill, jitter } = validateOptionalScheduleFields(input);
  return { type, spec, id, overlap, backfill, jitter };
}

export const createScheduleOperation = defineOperation<CreateScheduleInput, CreateScheduleOutput>({
  name: 'weft.schedules.create',
  mcpExposable: false,
  summary: 'Create a recurring schedule',
  description:
    'Create a schedule that starts a workflow on a recurring cadence. Requires a schedule ' +
    '`id`, the target workflow `type`, and a recurrence specification (cron expression or ' +
    'interval); accepts the workflow `input` and start options. Returns the created schedule ' +
    'id. Faults with Conflict when a schedule with the same id already exists and InvalidParams ' +
    'for a malformed recurrence specification.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: createScheduleInput,
  outputSchema: createScheduleOutput,
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<CreateScheduleOutput> => {
    const typedEngine = engine as Engine;

    // All field validation lives here so REST and JSON-RPC clients both
    // receive the same error messages verbatim. Validation order:
    // type → cadence (cronExpression or every) → id → overlap → backfill → jitter.
    const validated = validateCreateScheduleInput(input);

    const options: ScheduleOptions = {
      ...(validated.id !== undefined ? { id: validated.id } : {}),
      ...(validated.overlap !== undefined ? { overlap: validated.overlap } : {}),
      ...(validated.backfill !== undefined ? { backfill: validated.backfill } : {}),
      ...(validated.jitter !== undefined ? { jitter: validated.jitter } : {}),
    };

    try {
      const handle = await typedEngine.schedule(
        validated.type,
        input.input,
        validated.spec,
        options,
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
    every: { kind: 'body-field', bodyField: 'every' },
    input: { kind: 'body-field', bodyField: 'input' },
    id: { kind: 'body-field', bodyField: 'id' },
    overlap: { kind: 'body-field', bodyField: 'overlap' },
    backfill: { kind: 'body-field', bodyField: 'backfill' },
    jitter: { kind: 'body-field', bodyField: 'jitter' },
  },
  extractInput: async (request, _pathParams, context) => {
    let body: unknown;
    try {
      body = await readRestJsonBody(request, context);
    } catch (error) {
      if (isOperationFault(error)) throw error;
      throw invalidParamsFault('Invalid JSON body');
    }

    // arrays are typeof 'object' && !== null, so they pass
    // this guard and fall through to the type/cadence checks in
    // `invoke` (which is the single cross-transport validator).
    if (typeof body !== 'object' || body === null) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    // Read own properties only so an array body (whose prototype carries an
    // `every` method) does not masquerade as an interval spec.
    return {
      type: record['type'],
      cronExpression: Object.hasOwn(record, 'cronExpression')
        ? record['cronExpression']
        : undefined,
      every: Object.hasOwn(record, 'every') ? record['every'] : undefined,
      input: record['input'],
      id: record['id'],
      overlap: record['overlap'],
      backfill: record['backfill'],
      jitter: record['jitter'],
    };
  },
  success: { kind: 'json', status: 201 },
  shapeFault: shapeRestFault,
};
