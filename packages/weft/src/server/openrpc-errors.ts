/**
 * OpenRPC `components.errors` derived from the closed `FaultCode` union.
 *
 * @module server/openrpc-errors
 */

import { z } from 'zod';

import type { FaultCode } from '../core/fault-code.ts';
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
export const TimeoutDataSchema = z.object({ operationName: z.string().optional() });
export const PayloadTooLargeDataSchema = z.object({ maxBytes: z.number() });
export const NotImplementedDataSchema = z.object({});
const TransportKindSchema = z.enum([
  'http-rest',
  'jsonRpcHttp',
  'jsonRpcWebSocket',
  'jsonRpcStdio',
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
  EngineFailure: EngineFailureDataSchema,
};

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
      data: dataJsonSchema,
      'x-http-status': httpStatus,
    };
  }
  return result;
}
