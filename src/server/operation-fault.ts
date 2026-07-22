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
 * The stable fault model with transport-neutral code, message, and typed
 * `data` payload forms the basis of cross-transport parity: every fault is
 * serialized consistently across REST and JSON-RPC transports.
 */

// `FaultCode` is defined in `core` so the client can consume it off the wire
// without importing from `server`. Imported for use within this module and
// re-exported so existing server call sites importing it from here are
// unaffected.
import type { FaultCode } from '../core/fault-code.ts';
import { isWeftErrorCode, type WeftErrorCode } from '../core/weft-error.ts';

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
  | { code: 'PayloadTooLarge'; message: string; data: { maxBytes: number } }
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
  PayloadTooLarge: 413,
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

export type RestFaultResponseOptions = {
  /** REST-only status override for a binding with an established non-canonical status. */
  readonly status?: number;
  /** REST-only public message override for a binding with an established response message. */
  readonly message?: string;
};

export type RestFaultBody = {
  readonly error: string;
  readonly weftCode?: WeftErrorCode;
  readonly data?: Readonly<Record<string, unknown>>;
};

type RestProjectableFault = Exclude<OperationFault, { code: 'EngineFailure' }>;

type RestFaultDataExtractor<Code extends RestProjectableFault['code']> = (
  data: Extract<RestProjectableFault, { code: Code }>['data'],
) => Readonly<Record<string, unknown>>;

type RestFaultDataExtractors = {
  [Code in RestProjectableFault['code']]: RestFaultDataExtractor<Code>;
};

const NO_REST_FAULT_DATA: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * REST is a deliberately smaller disclosure boundary than JSON-RPC. This
 * exhaustive table is deny-by-default: adding a new `FaultCode` cannot compile
 * until its REST-visible fields are reviewed explicitly.
 */
const REST_FAULT_DATA_EXTRACTORS: RestFaultDataExtractors = {
  Unauthorized: () => NO_REST_FAULT_DATA,
  Forbidden: () => NO_REST_FAULT_DATA,
  NotFound: (data) =>
    filterDefined({
      resource: data.resource,
      identifier:
        data.identifier === undefined || data.identifier.length === 0 ? undefined : data.identifier,
    }),
  Conflict: (data) =>
    filterDefined({
      missingTypes: data.missingTypes === undefined ? undefined : [...data.missingTypes],
      missingWorkflowCount: data.missingWorkflowCount,
      samplesTruncated: data.samplesTruncated,
    }),
  Unprocessable: () => NO_REST_FAULT_DATA,
  PayloadTooLarge: (data) => ({ maxBytes: data.maxBytes }),
  Timeout: (data) => filterDefined({ operationName: data.operationName }),
  NotImplemented: () => NO_REST_FAULT_DATA,
  UnsupportedTransport: (data) => ({
    transport: data.transport,
    supported: [...data.supported],
  }),
  SubscriptionOverflow: (data) => ({ droppedCount: data.droppedCount }),
  InvalidParams: (data) =>
    data.issues.length === 0
      ? NO_REST_FAULT_DATA
      : {
          issues: data.issues.map((issue) => ({
            path: [...issue.path],
            message: issue.message,
            code: issue.code,
          })),
        },
  MethodNotFound: (data) => ({ method: data.method }),
};

/**
 * Map an `OperationFault` to the canonical additive REST body:
 * `{ error, weftCode?, data? }`. The existing string `error` and optional
 * fine-grained `weftCode` remain unchanged; `data` contains only fields from
 * the audited allowlist above. JSON-RPC uses its own broader projection.
 *
 * `EngineFailure` is a hard exception: its exact body remains
 * `{ "error": "Internal server error" }`, regardless of response overrides.
 */
export function shapeOperationFaultAsJson(
  fault: OperationFault,
  options: RestFaultResponseOptions = {},
): Response {
  const message =
    options.message ??
    (fault.code === 'InvalidParams' ? formatInvalidParamsMessage(fault) : undefined);
  return shapeRestFaultAsJson(fault, { ...options, ...(message === undefined ? {} : { message }) });
}

/** Canonical flat REST response used by bindings and route-dispatch fallback. */
export function shapeRestFaultAsJson(
  fault: OperationFault,
  options: RestFaultResponseOptions = {},
): Response {
  const body = shapeRestFaultBody(fault, options.message);
  const status =
    fault.code === 'EngineFailure'
      ? 500
      : (options.status ?? FAULT_CODE_TO_HTTP_STATUS[fault.code]);

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build the audited body for bespoke REST shapers that retain extra legacy fields. */
export function shapeRestFaultBody(fault: OperationFault, message?: string): RestFaultBody {
  if (fault.code === 'EngineFailure') return { error: 'Internal server error' };

  const error = message ?? fault.message;
  const weftCode = weftCodeFromFaultData(fault.data);
  const data = restDataFromFault(fault);
  const body: {
    error: string;
    weftCode?: WeftErrorCode;
    data?: Readonly<Record<string, unknown>>;
  } = { error };
  if (weftCode !== undefined) body.weftCode = weftCode;
  if (Object.keys(data).length > 0) body.data = data;
  return body;
}

function restDataFromFault(fault: RestProjectableFault): Readonly<Record<string, unknown>> {
  // The table maps every discriminant to the matching data extractor. TypeScript
  // cannot preserve that correlation through a dynamic lookup, so this narrow
  // assertion reconnects the already-exhaustive key/value relationship.
  const extractor = REST_FAULT_DATA_EXTRACTORS[fault.code] as RestFaultDataExtractor<
    typeof fault.code
  >;
  return extractor(fault.data);
}

function weftCodeFromFaultData(data: OperationFault['data']): WeftErrorCode | undefined {
  if (typeof data !== 'object' || data === null || !('weftCode' in data)) return undefined;
  return isWeftErrorCode(data.weftCode) ? data.weftCode : undefined;
}

function filterDefined(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
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
  PayloadTooLarge: -32024,
  NotImplemented: -32025,
  UnsupportedTransport: -32030,
  SubscriptionOverflow: -32031,
  EngineFailure: -32099,
  InvalidParams: -32602,
  MethodNotFound: -32601,
});
