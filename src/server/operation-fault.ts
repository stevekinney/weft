/**
 * Transport-neutral fault model for the operation pipeline.
 *
 * `OperationFault` is what `executeOperation` returns when a request fails.
 * It carries a stable `code` (the discriminator), a human-readable `message`
 * for logs, and a typed `data` payload narrowed per-code via discriminated
 * union — so transport adapters can serialize the fault into the exact
 * wire shape their protocol expects without a string-sniffing layer.
 *
 * Two pure mapper functions translate the fault into a transport-specific
 * shape:
 *   - `faultToHttpResponse(fault)` for REST.
 *   - `faultToJsonRpcError(fault)` for the JSON-RPC transports.
 * Both consume `OperationFault` directly; serialization is not a method on
 * the fault class because that would force every transport to know about
 * every other transport's wire shape.
 *
 * **Scope.** The union covers operation-pipeline faults — what
 * `executeOperation` produces. Pure protocol-frame errors (JSON parse
 * failure, invalid JSON-RPC request envelope) live in the JSON-RPC parser
 * and use the spec-mandated reserved codes (-32700 / -32600); they do NOT
 * pass through this fault model. The v1 union is open for additive
 * extension — future codes (e.g. `PreconditionFailed`, `PayloadTooLarge`,
 * `ResourceExhausted`) can be added without breaking existing serializers
 * because the per-code mapping tables are exhaustive `Record<FaultCode, T>`
 * and the JSON-RPC payload extractor is an exhaustive switch.
 *
 * **Every fault has a `data` field.** Even codes with no payload-specific
 * detail (`NotImplemented`, `EngineFailure`) carry `data: {}` so transport
 * adapters never branch on `data === undefined`. This uniformity is what
 * lets the exhaustive switch in `extractFaultDataPayload` stay small.
 *
 * See Track 8 design decision 4.
 */

/** Stable code names. The full vocabulary is closed for v1. */
export type FaultCode =
  | 'Unauthorized'
  | 'Forbidden'
  | 'NotFound'
  | 'Conflict'
  | 'Unprocessable'
  | 'Timeout'
  | 'RateLimited'
  | 'NotImplemented'
  | 'UnsupportedTransport'
  | 'SubscriptionOverflow'
  | 'InvalidParams'
  | 'MethodNotFound'
  | 'EngineFailure';

/** Transport identifiers as seen by `executeOperation`. */
export type TransportKind = 'http-rest' | 'jsonRpcHttp' | 'jsonRpcWebSocket' | 'jsonRpcStdio';

/** A flattened zod issue, kept loose so we don't pin a zod version here. */
export type FlattenedZodIssue = {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly code: string;
};

/**
 * Transport-neutral fault returned by `executeOperation`. Each variant has a
 * typed `data` payload — transport adapters destructure on `code` to access
 * the shape they need.
 */
export type OperationFault =
  | { code: 'Unauthorized'; message: string; data: { reason: string } }
  | { code: 'Forbidden'; message: string; data: { reason: string } }
  | {
      code: 'NotFound';
      message: string;
      data: { resource: string; identifier?: string };
    }
  | { code: 'Conflict'; message: string; data: { reason: string } }
  | { code: 'Unprocessable'; message: string; data: { reason: string } }
  // Both `Timeout` and `RateLimited` allow callers to construct
  // `data: { hint: undefined }` legally — the wire serializers strip
  // undefined-valued keys via `filterDefined`. Spelling `| undefined`
  // explicitly accepts that under `exactOptionalPropertyTypes`.
  | { code: 'Timeout'; message: string; data: { operationName?: string | undefined } }
  | { code: 'RateLimited'; message: string; data: { retryAfterMs?: number | undefined } }
  | { code: 'NotImplemented'; message: string; data: Record<string, never> }
  | {
      code: 'UnsupportedTransport';
      message: string;
      data: { transport: TransportKind; supported: ReadonlyArray<TransportKind> };
    }
  | {
      code: 'SubscriptionOverflow';
      message: string;
      data: { subscriptionId: string; droppedCount: number };
    }
  | {
      code: 'InvalidParams';
      message: string;
      data: { issues: ReadonlyArray<FlattenedZodIssue> };
    }
  | { code: 'MethodNotFound'; message: string; data: { method: string } }
  | { code: 'EngineFailure'; message: string; data: Record<string, never> };

/**
 * HTTP status code for each fault, used by `faultToHttpResponse`. Values
 * align with REST conventions; both `NotImplemented` and
 * `UnsupportedTransport` map to 501 because the caller asked for something
 * the server cannot fulfill.
 */
export const FAULT_CODE_TO_HTTP_STATUS: Record<FaultCode, number> = {
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  Unprocessable: 422,
  Timeout: 408,
  RateLimited: 429,
  NotImplemented: 501,
  UnsupportedTransport: 501,
  SubscriptionOverflow: 500,
  InvalidParams: 400,
  MethodNotFound: 404,
  EngineFailure: 500,
};

/**
 * JSON-RPC error code for each fault. Reserved codes (-32700..-32603) keep
 * the spec meanings (`InvalidParams`, `MethodNotFound`); Weft domain codes
 * live in -32010..-32099 documented per design decision 4.
 */
export const FAULT_CODE_TO_JSON_RPC_CODE: Record<FaultCode, number> = {
  Unauthorized: -32010,
  Forbidden: -32011,
  NotFound: -32020,
  Conflict: -32021,
  Unprocessable: -32022,
  Timeout: -32023,
  RateLimited: -32024,
  NotImplemented: -32025,
  UnsupportedTransport: -32030,
  SubscriptionOverflow: -32031,
  EngineFailure: -32099,
  InvalidParams: -32602,
  MethodNotFound: -32601,
};
