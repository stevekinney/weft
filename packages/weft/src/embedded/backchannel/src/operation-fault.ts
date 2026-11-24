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

import { type FaultCode } from './fault-code.ts';
import { faultWireAdvice } from './fault-remediation.ts';
import { usableRetryAfterSeconds, wireSafeFault } from './fault-wire-safety.ts';

/** Transports `executeOperation` sees; `mcp` (a catalog MCP mount) admits `mcpExposable` ones. */
export type TransportKind =
  'http-rest' | 'jsonRpcHttp' | 'jsonRpcWebSocket' | 'jsonRpcStdio' | 'mcp';

/** A revision identifier: a counter or an opaque token. */
export type RevisionToken = string | number;

/** A flattened zod issue, kept loose so we don't pin a zod version here. */
export type FlattenedZodIssue = {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly code: string;
};

/**
 * The faults `executeOperation` returns, each with its typed `data` payload.
 * {@link OperationFault} adds the advice every fault may carry.
 */
type OperationFaultVariant =
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
      data: { resource: string; identifier?: string | undefined; weftCode?: string };
    }
  | {
      code: 'Conflict';
      message: string;
      data: {
        reason: string;
        /** Stable, machine-readable reason approved for REST disclosure. */
        publicReason?: 'workflow-replaced' | undefined;
        // See the `NotFound.weftCode` note: `Conflict` collapses several typed
        // errors (`WorkflowAlreadyExistsError`, `StartOrSignalConflictError`,
        // `IdempotencyKeyPurgedError`), and `weftCode` recovers which one.
        weftCode?: string;
        missingTypes?: readonly string[] | undefined;
        missingWorkflowCount?: number | undefined;
        samplesTruncated?: boolean | undefined;
        // WFT-11: `engine.workflows.activate()`'s `applied: false` refusal
        // variants (`stale-generation`, `expected-generation-required`)
        // report the durable generation the caller should have supplied.
        currentGeneration?: number | undefined;
        // WFT-11: the `incompatible` refusal variant's full, ordered list of
        // `WorkflowCompatibilityReason`s — a caller branching on why
        // activation was refused needs every reason, not just the first.
        compatibilityReasons?: readonly string[] | undefined;
        // WFT-15/16: `engine.workflows.preload()`'s loaded-module-fails-
        // validation refusal — `WorkflowSourceValidationError`'s own full,
        // ordered `reasons` array (distinct from `compatibilityReasons`,
        // which is manifest-compatibility-specific).
        sourceValidationReasons?: readonly string[] | undefined;
      };
    }
  | { code: 'Unprocessable'; message: string; data: { reason: string } }
  | { code: 'PayloadTooLarge'; message: string; data: { maxBytes: number } }
  // `Timeout` allows callers to construct `data: { operationName: undefined }`
  // legally — the wire serializers strip undefined-valued keys via
  // `filterDefined`. Spelling `| undefined` explicitly accepts that under
  // `exactOptionalPropertyTypes`.
  | {
      code: 'Timeout';
      message: string;
      // `updateId` is the id a timed-out `weft.workflows.update` minted before it waited: the
      // update stays queued, and the caller reads its answer later with `weft.updates.result.get`
      // or finds it in `weft.workflows.updates.list` (COR-1463).
      data: { operationName?: string | undefined; updateId?: string | undefined };
    }
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
      data: { issues: ReadonlyArray<FlattenedZodIssue>; weftCode?: string };
    }
  | { code: 'MethodNotFound'; message: string; data: { method: string } }
  // The caller's optimistic-concurrency precondition no longer holds: the
  // resource has moved past the revision the caller expected. Distinct from
  // `Conflict` so a client can re-read and retry without parsing a reason.
  | {
      code: 'StaleRevision';
      message: string;
      data: {
        expectedRevision?: RevisionToken | undefined;
        // Required: it is what tells a client to re-read and retry, rather than
        // treat the fault as a plain `Conflict`.
        currentRevision: RevisionToken;
      };
    }
  // A rate or quota limit was hit. `retryAfterSeconds` is emitted as the REST
  // `Retry-After` header and mirrored into `data` on both transports.
  | { code: 'RateLimited'; message: string; data: { retryAfterSeconds?: number | undefined } }
  // The server (or a dependency) cannot serve the request right now but may
  // later. `reason` is JSON-RPC only; REST discloses just `retryAfterSeconds`.
  | {
      code: 'Unavailable';
      message: string;
      data: { reason?: string | undefined; retryAfterSeconds?: number | undefined };
    }
  // The server understands the request but lacks a capability it needs.
  | { code: 'UnsupportedCapability'; message: string; data: { capability: string } }
  | { code: 'EngineFailure'; message: string; data: Record<string, never> };

/**
 * Transport-neutral fault returned by `executeOperation`. Each variant has a
 * typed `data` payload — transport adapters destructure on `code` to access
 * the shape they need.
 *
 * Every fault may also carry `remediation`: one line of plain text saying what
 * the caller can do next (`assertValidRemediation` in `fault-remediation.ts` states the limits).
 * Whether repeating the identical call can help is not a field of the fault: it
 * is a property of the code, in `FAULT_CODE_RETRYABLE`, and the wire projections
 * add it as `retryable` ({@link faultWireAdvice}).
 */
export type OperationFault = OperationFaultVariant & {
  remediation?: string | undefined;
};

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
  // 504, not `Request Timeout`: a user agent may repeat a request answered `Request Timeout` (RFC 9110
  // §15.5.9), and browsers do, so a timed-out `POST` would run again. No user agent replays a `504`.
  Timeout: 504,
  PayloadTooLarge: 413,
  NotImplemented: 501,
  UnsupportedTransport: 501,
  SubscriptionOverflow: 500,
  InvalidParams: 400,
  MethodNotFound: 404,
  StaleRevision: 409,
  RateLimited: 429,
  Unavailable: 503,
  UnsupportedCapability: 501,
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

/** Options for turning a fault into a REST response. */
export type RestFaultResponseOptions = {
  /** REST-only status override for a binding with an established non-canonical status. */
  readonly status?: number;
  /** REST-only public message override for a binding with an established response message. */
  readonly message?: string;
  /** The host's error codes; a `data.weftCode` this rejects is dropped. Omitted, any string passes. */
  readonly isKnownErrorCode?: (value: string) => boolean;
};

/**
 * The REST fault body. `weftCode` is the fine-grained error code of
 * the originating error class, present only when the fault carried one; the
 * coarse {@link FaultCode} is not in the body at all. The HTTP status is
 * derived from it, but that mapping is not injective (`NotFound` and
 * `MethodNotFound` are both 404, for example), so a REST consumer cannot
 * recover the exact `FaultCode` from the status. JSON-RPC uses
 * the same `weftCode` key for the coarse `FaultCode` instead (see
 * `fault-to-json-rpc.ts`).
 */
export type RestFaultBody = {
  readonly error: string;
  readonly weftCode?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  /** Whether repeating the identical call later can succeed; always present (see {@link faultWireAdvice}). */
  readonly retryable: boolean;
  /** One line saying what to do next, when the fault carries one. */
  readonly remediation?: string;
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
      reason: data.publicReason,
      missingTypes: data.missingTypes === undefined ? undefined : [...data.missingTypes],
      missingWorkflowCount: data.missingWorkflowCount,
      samplesTruncated: data.samplesTruncated,
      currentGeneration: data.currentGeneration,
      compatibilityReasons:
        data.compatibilityReasons === undefined ? undefined : [...data.compatibilityReasons],
      sourceValidationReasons:
        data.sourceValidationReasons === undefined ? undefined : [...data.sourceValidationReasons],
    }),
  Unprocessable: () => NO_REST_FAULT_DATA,
  PayloadTooLarge: (data) => ({ maxBytes: data.maxBytes }),
  Timeout: (data) => filterDefined({ operationName: data.operationName, updateId: data.updateId }),
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
  // Typed data lets a REST client tell "re-read and retry" (`StaleRevision`)
  // from a plain `Conflict`, and learn when to retry. `Unavailable.reason` is
  // internal detail and stays JSON-RPC only.
  StaleRevision: (data) => ({
    currentRevision: data.currentRevision,
    ...(data.expectedRevision === undefined ? {} : { expectedRevision: data.expectedRevision }),
  }),
  RateLimited: (data) =>
    filterDefined({ retryAfterSeconds: usableRetryAfterSeconds(data.retryAfterSeconds) }),
  Unavailable: (data) =>
    filterDefined({ retryAfterSeconds: usableRetryAfterSeconds(data.retryAfterSeconds) }),
  UnsupportedCapability: (data) => ({ capability: data.capability }),
};

/**
 * Map an `OperationFault` to the canonical additive REST body:
 * `{ error, weftCode?, data?, retryable, remediation? }`. The existing string `error` and optional
 * fine-grained `weftCode` (the host's error code, never a {@link FaultCode})
 * remain unchanged; `data` contains only fields from the audited allowlist
 * above. JSON-RPC uses its own broader projection, whose `data.weftCode` is the
 * coarse `FaultCode`.
 *
 * `EngineFailure` is a hard exception: its exact body remains
 * `{ "error": "Internal server error", "retryable": false }`, regardless of response overrides.
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

/** Canonical REST response used by bindings and route-dispatch fallback. */
export function shapeRestFaultAsJson(
  fault: OperationFault,
  options: RestFaultResponseOptions = {},
): Response {
  const safeFault = wireSafeFault(fault);
  const body = shapeRestFaultBody(safeFault, options);
  const status =
    safeFault.code === 'EngineFailure'
      ? 500
      : (options.status ?? FAULT_CODE_TO_HTTP_STATUS[safeFault.code]);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const retryAfter = retryAfterHeaderValue(safeFault);
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;

  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * The `Retry-After` delay-seconds value for a fault that carries
 * `retryAfterSeconds`. A non-finite or negative value is dropped rather than
 * emitted as a malformed header, and a fraction rounds up so a client never
 * retries earlier than the server asked.
 */
function retryAfterHeaderValue(fault: OperationFault): string | undefined {
  if (fault.code !== 'RateLimited' && fault.code !== 'Unavailable') return undefined;
  const seconds = usableRetryAfterSeconds(fault.data.retryAfterSeconds);
  return seconds === undefined ? undefined : String(Math.ceil(seconds));
}

/** Build the audited canonical REST body. */
function shapeRestFaultBody(
  fault: OperationFault,
  options: RestFaultResponseOptions,
): RestFaultBody {
  const { retryable, remediation } = faultWireAdvice(fault);
  if (fault.code === 'EngineFailure') return { error: 'Internal server error', retryable };

  const error = options.message ?? fault.message;
  const weftCode = weftCodeFromFaultData(fault.data, options.isKnownErrorCode);
  const data = restDataFromFault(fault);
  return {
    error,
    ...(weftCode === undefined ? {} : { weftCode }),
    ...(Object.keys(data).length > 0 ? { data } : {}),
    retryable,
    ...(remediation === undefined ? {} : { remediation }),
  };
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

function weftCodeFromFaultData(
  data: OperationFault['data'],
  isKnownErrorCode: ((value: string) => boolean) | undefined,
): string | undefined {
  const weftCode: unknown =
    typeof data === 'object' && data !== null
      ? (data as { weftCode?: unknown }).weftCode
      : undefined;
  if (typeof weftCode !== 'string') return undefined;
  return isKnownErrorCode === undefined || isKnownErrorCode(weftCode) ? weftCode : undefined;
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
  StaleRevision: -32026,
  RateLimited: -32027,
  Unavailable: -32028,
  UnsupportedCapability: -32029,
});
