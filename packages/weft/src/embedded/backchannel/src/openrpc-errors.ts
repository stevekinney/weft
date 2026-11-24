/**
 * OpenRPC `components.errors` derived from the closed `FaultCode` union.
 *
 * @module server/openrpc-errors
 */

import { z } from 'zod';

import type { FaultCode } from './fault-code.ts';
import { MAX_REMEDIATION_LENGTH } from './fault-remediation.ts';
import {
  FAULT_CODE_TO_HTTP_STATUS,
  FAULT_CODE_TO_JSON_RPC_CODE,
  type TransportKind,
} from './operation-fault.ts';

// ---------------------------------------------------------------------------
// Per-fault data Zod schemas
// ---------------------------------------------------------------------------

export const UnauthorizedDataSchema = z.object({ reason: z.string() });
export const ForbiddenDataSchema = z.object({ reason: z.string() });
export const NotFoundDataSchema = z.object({
  resource: z.string(),
  identifier: z.string().optional(),
});
export const ConflictDataSchema = z.object({ reason: z.string() });
export const UnprocessableDataSchema = z.object({ reason: z.string() });
export const TimeoutDataSchema = z.object({
  operationName: z.string().optional(),
  updateId: z.string().optional(),
});
export const PayloadTooLargeDataSchema = z.object({ maxBytes: z.number() });
export const NotImplementedDataSchema = z.object({});
const TransportKindSchema = z.enum([
  'http-rest',
  'jsonRpcHttp',
  'jsonRpcWebSocket',
  'jsonRpcStdio',
  'mcp',
] as const satisfies ReadonlyArray<TransportKind>);
export const UnsupportedTransportDataSchema = z.object({
  transport: TransportKindSchema,
  supported: z.array(TransportKindSchema).readonly(),
});
export const SubscriptionOverflowDataSchema = z.object({
  subscriptionId: z.string(),
  droppedCount: z.number(),
});
export const InvalidParamsDataSchema = z.object({
  issues: z
    .array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])).readonly(),
        message: z.string(),
        code: z.string(),
      }),
    )
    .readonly(),
});
export const MethodNotFoundDataSchema = z.object({ method: z.string() });
const RevisionTokenSchema = z.union([z.string(), z.number()]);
export const StaleRevisionDataSchema = z.object({
  expectedRevision: RevisionTokenSchema.optional(),
  currentRevision: RevisionTokenSchema,
});
export const RateLimitedDataSchema = z.object({ retryAfterSeconds: z.number().optional() });
export const UnavailableDataSchema = z.object({
  reason: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
});
export const UnsupportedCapabilityDataSchema = z.object({ capability: z.string() });
export const EngineFailureDataSchema = z.object({});

const FAULT_DATA_SCHEMAS: Record<FaultCode, z.ZodType> = {
  Unauthorized: UnauthorizedDataSchema,
  Forbidden: ForbiddenDataSchema,
  NotFound: NotFoundDataSchema,
  Conflict: ConflictDataSchema,
  Unprocessable: UnprocessableDataSchema,
  Timeout: TimeoutDataSchema,
  PayloadTooLarge: PayloadTooLargeDataSchema,
  NotImplemented: NotImplementedDataSchema,
  UnsupportedTransport: UnsupportedTransportDataSchema,
  SubscriptionOverflow: SubscriptionOverflowDataSchema,
  InvalidParams: InvalidParamsDataSchema,
  MethodNotFound: MethodNotFoundDataSchema,
  StaleRevision: StaleRevisionDataSchema,
  RateLimited: RateLimitedDataSchema,
  Unavailable: UnavailableDataSchema,
  UnsupportedCapability: UnsupportedCapabilityDataSchema,
  EngineFailure: EngineFailureDataSchema,
};

/**
 * Add the two advice keys every JSON-RPC fault's `error.data` carries beside its payload:
 * `retryable` always, `remediation` when the fault has one (see `faultWireAdvice`).
 */
function withFaultAdviceProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  return {
    ...schema,
    properties: {
      ...properties,
      retryable: {
        type: 'boolean',
        description: 'Whether repeating the identical call later can succeed',
      },
      remediation: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_REMEDIATION_LENGTH,
        description: 'One line of plain text saying what to do next',
      },
    },
    required: [...required, 'retryable'],
  };
}

type OpenRpcError = {
  code: number;
  message: string;
  data?: Record<string, unknown>;
  'x-http-status': number;
};

/**
 * Build the `components.errors` array for an OpenRPC document.
 *
 * Derived from `FAULT_CODE_TO_JSON_RPC_CODE` (the single source of truth).
 * Every `FaultCode` in the closed union gets one entry with:
 * - `code`: JSON-RPC error code
 * - `message`: human-readable fault name
 * - `data`: JSON Schema from the Zod schema for that fault's data payload
 * - `x-http-status`: HTTP status code for REST callers
 */
export function buildOpenRpcComponentsErrors(): Record<string, OpenRpcError> {
  const result: Record<string, OpenRpcError> = {};
  for (const [faultCode, jsonRpcCode] of Object.entries(FAULT_CODE_TO_JSON_RPC_CODE) as [
    FaultCode,
    number,
  ][]) {
    const httpStatus = FAULT_CODE_TO_HTTP_STATUS[faultCode];
    const dataSchema = FAULT_DATA_SCHEMAS[faultCode];
    const jsonSchema = z.toJSONSchema(dataSchema, {
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    const { $schema: _unused, ...dataJsonSchema } = jsonSchema as {
      $schema?: unknown;
    } & Record<string, unknown>;
    result[faultCode] = {
      code: jsonRpcCode,
      message: faultCode,
      data: withFaultAdviceProperties(dataJsonSchema),
      'x-http-status': httpStatus,
    };
  }
  return result;
}
