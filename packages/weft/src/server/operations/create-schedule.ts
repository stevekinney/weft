import { z } from 'zod';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import { type UnknownRestBinding, invalidParamsFault } from "../../embedded/backchannel/src/internals.ts";
import type { ScheduleOptions, ScheduleSpec } from '../../core/types.ts';
import { assertOperationEngineMethods } from './operation-helpers.ts';
import {
  mapScheduleErrorToFault,
  validateScheduleInputCadence,
  validateScheduleMutableOptions,
} from './schedule-faults.ts';
import {
  extractSharedScheduleRestFields,
  parseScheduleRestBodyRequestRecord,
} from './schedule-rest-body.ts';

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
  input: z.unknown().optional().describe('Input payload handed to each run the schedule starts.'),
  id: z.unknown().optional().describe('Client-chosen schedule id. Omit it to have one generated.'),
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
      'When true, ticks missed during downtime are run on recovery; when false (default) late ticks are skipped.',
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
      'Revision policy (WFT-20). Runtime validation requires "active-at-fire" or "pinned"; defaults to "active-at-fire".',
    ),
  metadata: z
    .unknown()
    .optional()
    .describe(
      'A plain JSON object stored with the schedule and returned with it, such as who owns it. It is not passed to the runs the schedule starts. Runtime validation requires a JSON object.',
    ),
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
  description: string | undefined;
  overlap: NonNullable<ScheduleOptions['overlap']> | undefined;
  backfill: boolean | undefined;
  jitter: ScheduleOptions['jitter'] | undefined;
  timeZone: string | undefined;
  revisionPolicy: ScheduleOptions['revisionPolicy'] | undefined;
  metadata: ScheduleOptions['metadata'] | undefined;
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

/** Validate the create-only schedule id. */
function validateScheduleId(value: CreateScheduleInput['id']): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParamsFault('Field "id" must be a non-empty string');
  }
  return value;
}

/** Validate create fields in order: id, then the shared mutable schedule options. */
function validateOptionalScheduleFields(input: CreateScheduleInput): {
  id: string | undefined;
  description: string | undefined;
  overlap: NonNullable<ScheduleOptions['overlap']> | undefined;
  backfill: boolean | undefined;
  jitter: ScheduleOptions['jitter'] | undefined;
  timeZone: string | undefined;
  revisionPolicy: ScheduleOptions['revisionPolicy'] | undefined;
  metadata: ScheduleOptions['metadata'] | undefined;
} {
  const validatedId = validateScheduleId(input.id);
  const validatedOptions = validateScheduleMutableOptions(input);

  return {
    id: validatedId,
    description: validatedOptions.description,
    overlap: validatedOptions.overlap,
    backfill: validatedOptions.backfill,
    jitter: validatedOptions.jitter,
    timeZone: validatedOptions.timeZone,
    revisionPolicy: validatedOptions.revisionPolicy,
    metadata: validatedOptions.metadata,
  };
}

/**
 * Validate `CreateScheduleInput` fields in order:
 * type → cadence (cronExpression or every) → id → description → metadata → overlap → backfill → jitter → timeZone → revisionPolicy.
 *
 * Throws an `InvalidParams` fault on the first invalid field so both REST and
 * JSON-RPC callers receive the same error messages.
 */
function validateCreateScheduleInput(input: CreateScheduleInput): ValidatedCreateScheduleInput {
  const { type, spec } = validateRequiredScheduleFields(input);
  const { id, description, overlap, backfill, jitter, timeZone, revisionPolicy, metadata } =
    validateOptionalScheduleFields(input);
  return {
    type,
    spec,
    id,
    description,
    overlap,
    backfill,
    jitter,
    timeZone,
    revisionPolicy,
    metadata,
  };
}

export const createScheduleOperation = defineOperation({
  name: 'weft.schedules.create',
  mcpExposable: false,
  summary: 'Create a recurring schedule',
  description:
    'Create a schedule that starts a workflow on a recurring cadence. Requires a schedule ' +
    '`id`, the target workflow `type`, and a recurrence specification (cron expression or ' +
    'interval); accepts the workflow `input` and start options, and for a cron schedule the IANA ' +
    '`timeZone` its wall-clock times are read in (UTC when omitted). Returns the created schedule ' +
    'id. Faults with Conflict when a schedule with the same id already exists and InvalidParams ' +
    'for a malformed recurrence specification or an unknown time zone.',
  destructive: false,
  tags: ['Schedules'],
  inputSchema: createScheduleInput,
  outputSchema: createScheduleOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:write'] } },
  discoverable: true,
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<CreateScheduleOutput> => {
    assertOperationEngineMethods(engine, ['schedule']);
    const typedEngine = engine;

    // All field validation lives here so REST and JSON-RPC clients both
    // receive the same error messages verbatim. Validation order:
    // type → cadence (cronExpression or every) → id → description → overlap → backfill → jitter.
    const validated = validateCreateScheduleInput(input);

    const options: ScheduleOptions = {
      ...(validated.id !== undefined ? { id: validated.id } : {}),
      ...(validated.description !== undefined ? { description: validated.description } : {}),
      ...(validated.overlap !== undefined ? { overlap: validated.overlap } : {}),
      ...(validated.backfill !== undefined ? { backfill: validated.backfill } : {}),
      ...(validated.jitter !== undefined ? { jitter: validated.jitter } : {}),
      ...(validated.timeZone !== undefined ? { timeZone: validated.timeZone } : {}),
      ...(validated.revisionPolicy !== undefined
        ? { revisionPolicy: validated.revisionPolicy }
        : {}),
      ...(validated.metadata !== undefined ? { metadata: validated.metadata } : {}),
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
    description: { kind: 'body-field', bodyField: 'description' },
    overlap: { kind: 'body-field', bodyField: 'overlap' },
    backfill: { kind: 'body-field', bodyField: 'backfill' },
    jitter: { kind: 'body-field', bodyField: 'jitter' },
    timeZone: { kind: 'body-field', bodyField: 'timeZone' },
    revisionPolicy: { kind: 'body-field', bodyField: 'revisionPolicy' },
    metadata: { kind: 'body-field', bodyField: 'metadata' },
  },
  extractInput: async (request, _pathParams, context) => {
    const record = await parseScheduleRestBodyRequestRecord(request, context);
    return {
      type: record['type'],
      input: record['input'],
      id: record['id'],
      ...extractSharedScheduleRestFields(record),
    };
  },
  success: { kind: 'json', status: 201 },
};
