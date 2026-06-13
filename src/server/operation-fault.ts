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

// `FaultCode` is defined in `core` so the client can consume it off the wire
// without importing from `server`. Imported for use within this module and
// re-exported so existing server call sites importing it from here are
// unaffected.
import type { FaultCode } from '../core/fault-code.ts';
import type { WeftErrorCode } from '../core/weft-error.ts';

export type { FaultCode };

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
      // `weftCode` carries the fine-grained originating public error (e.g.
      // `WorkflowNotFoundError`) so REST clients can branch transport-uniformly
      // via `isWeftFault`; the coarse `NotFound` code alone cannot distinguish a
      // missing workflow from a missing schedule. Set only at sites holding the
      // typed error, never defaulted, so existing faults stay byte-identical.
      data: { resource: string; identifier?: string | undefined; weftCode?: WeftErrorCode };
    }
  | {
      code: 'Conflict';
      message: string;
      data: {
        reason: string;
        // See the `NotFound.weftCode` note: `Conflict` collapses several typed
        // errors (`WorkflowAlreadyExistsError`, `StartOrSignalConflictError`,
        // `IdempotencyKeyPurgedError`), and `weftCode` recovers which one.
        weftCode?: WeftErrorCode;
        missingTypes?: readonly string[] | undefined;
        missingWorkflowCount?: number | undefined;
        samplesTruncated?: boolean | undefined;
      };
    }
  | { code: 'Unprocessable'; message: string; data: { reason: string } }
  // `Timeout` allows callers to construct `data: { operationName: undefined }`
  // legally — the wire serializers strip undefined-valued keys via
  // `filterDefined`. Spelling `| undefined` explicitly accepts that under
  // `exactOptionalPropertyTypes`.
  | { code: 'Timeout'; message: string; data: { operationName?: string | undefined } }
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
      // See the `NotFound.weftCode` note: `WorkflowNotRegisteredError` maps to
      // `InvalidParams`, and `weftCode` recovers that originating code for
      // transport-uniform branching.
      data: { issues: ReadonlyArray<FlattenedZodIssue>; weftCode?: WeftErrorCode };
    }
  | { code: 'MethodNotFound'; message: string; data: { method: string } }
  | { code: 'EngineFailure'; message: string; data: Record<string, never> };

/**
 * HTTP status code for each fault, used by `faultToHttpResponse`. Values
 * align with REST conventions; both `NotImplemented` and
 * `UnsupportedTransport` map to 501 because the caller asked for something
 * the server cannot fulfill.
 */
export const FAULT_CODE_TO_HTTP_STATUS: Readonly<Record<FaultCode, number>> = Object.freeze({
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  Unprocessable: 422,
  Timeout: 408,
  NotImplemented: 501,
  UnsupportedTransport: 501,
  SubscriptionOverflow: 500,
  InvalidParams: 400,
  MethodNotFound: 404,
  EngineFailure: 500,
});

/**
 * Format an `InvalidParams` fault as a single human-readable error string
 * suitable for the body of a JSON response. Joins each Zod issue as
 * `path: message` (or just `message` at the root) with `; ` separators.
 */
export function formatInvalidParamsMessage(
  fault: Extract<OperationFault, { code: 'InvalidParams' }>,
): string {
  return fault.data.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * Map an `OperationFault` to a JSON `Response` with an `{ error }` body.
 * Treats `InvalidParams` as 400 with a flattened issues message, masks
 * `EngineFailure` as `Internal server error` at 500, and uses
 * {@link FAULT_CODE_TO_HTTP_STATUS} for every other code. Used by REST
 * bindings that serve a single resource and want a uniform error shape.
 */
export function shapeOperationFaultAsJson(fault: OperationFault): Response {
  if (fault.code === 'InvalidParams') {
    return new Response(JSON.stringify({ error: formatInvalidParamsMessage(fault) }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (fault.code === 'EngineFailure') {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: fault.message }), {
    status: FAULT_CODE_TO_HTTP_STATUS[fault.code],
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * JSON-RPC error code for each fault. Reserved codes (-32700..-32603) keep
 * the spec meanings (`InvalidParams`, `MethodNotFound`); Weft domain codes
 * live in -32010..-32099 documented per design decision 4.
 */
export const FAULT_CODE_TO_JSON_RPC_CODE: Readonly<Record<FaultCode, number>> = Object.freeze({
  Unauthorized: -32010,
  Forbidden: -32011,
  NotFound: -32020,
  Conflict: -32021,
  Unprocessable: -32022,
  Timeout: -32023,
  NotImplemented: -32025,
  UnsupportedTransport: -32030,
  SubscriptionOverflow: -32031,
  EngineFailure: -32099,
  InvalidParams: -32602,
  MethodNotFound: -32601,
});
