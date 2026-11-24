/**
 * `FaultCode` is the stable, machine-readable discriminant that the server's
 * operation pipeline attaches to every fault. Transport adapters serialize it
 * onto the wire so clients can branch on the failure programmatically rather
 * than string-matching a human message:
 *
 *   - REST operation routes: the HTTP status derived from this code, plus a
 *     `{ error, weftCode?, data?, retryable, remediation? }` body. The body
 *     never carries the `FaultCode` itself: its optional `weftCode` is the
 *     fine-grained `WeftErrorCode` of the originating error class (see
 *     `shapeRestFaultAsJson` in `operation-fault.ts`). `EngineFailure` is
 *     masked to exactly `{ "error": "Internal server error", "retryable": false }`.
 *   - JSON-RPC: `error.data.weftCode` is this coarse `FaultCode`, alongside
 *     `error.data.httpStatus` (see `fault-to-json-rpc.ts`). The fine-grained
 *     `WeftErrorCode` is not carried on this transport.
 *   - Both transports, and an MCP tool error's `structuredContent`, carry
 *     `retryable` (always, from {@link FAULT_CODE_RETRYABLE}) and
 *     `remediation` (when the fault sets one).
 *
 * The same key therefore names different vocabularies per transport; see
 * `documentation/reference/api-errors.md#wire-envelopes`.
 *
 * The type lives in its own file because the server (which produces faults)
 * and the client (which consumes them off the wire) both need it, and it
 * imports nothing, so it stays with the transport-neutral operation layer.
 * `core/fault-code.ts` keeps `FAULT_CODE_TO_FAILURE_CATEGORY`, the mapping onto
 * Weft's execution taxonomy.
 */

/**
 * Every stable fault code name, in declaration order. The full vocabulary is
 * closed for v1; new codes can be added additively, and the maps keyed by
 * {@link FaultCode} force every new code to be handled at compile time.
 */
export const FAULT_CODES = [
  'Unauthorized',
  'Forbidden',
  'NotFound',
  'Conflict',
  'Unprocessable',
  'Timeout',
  'PayloadTooLarge',
  'NotImplemented',
  'UnsupportedTransport',
  'SubscriptionOverflow',
  'InvalidParams',
  'MethodNotFound',
  'StaleRevision',
  'RateLimited',
  'Unavailable',
  'UnsupportedCapability',
  'EngineFailure',
] as const;

/**
 * Stable fault code names. The full vocabulary is closed for v1; new codes can
 * be added additively, and the `satisfies` map in `core/fault-code.ts` forces
 * every new code to declare its failure category at compile time.
 *
 * See `documentation/reference/api-errors.md#faultcode` for the HTTP status,
 * JSON-RPC error code, and failure category of every fault code.
 *
 * @example
 * ```ts
 * import { type FaultCode } from '@lostgradient/backchannel';
 * import { HttpClientError } from '@lostgradient/weft';
 *
 * function describe(error: HttpClientError): string {
 *   const code: FaultCode | undefined = error.faultCode;
 *   return code === 'NotFound' ? 'missing resource' : (code ?? 'unknown');
 * }
 * void describe;
 * ```
 */
export type FaultCode = (typeof FAULT_CODES)[number];

/**
 * Whether the caller can expect the identical call to succeed if it simply tries again later.
 * Every fault puts this on the wire as `retryable`: in the REST body, in the JSON-RPC
 * `error.data`, and in an MCP tool error's `structuredContent`.
 *
 * The rule: a code is `true` only when the same call, repeated unchanged after a wait, can
 * succeed with no change by the caller. A fault that needs fresh state (re-read the resource, take
 * a new revision) or different input, credentials or capabilities is `false`; its `remediation`
 * says what to change. `retryable` belongs to the code, not to the call site, so this table owns
 * it. A code that covers both a transient and a permanent case is `false`.
 *
 * A new {@link FaultCode} cannot compile until it has a value here, and `fault-code.test.ts`
 * fails when the table and {@link FAULT_CODES} disagree.
 */
export const FAULT_CODE_RETRYABLE: Readonly<Record<FaultCode, boolean>> = Object.freeze({
  // The caller must present a credential, or a different one.
  Unauthorized: false,
  Forbidden: false,
  // The resource is absent, or the request contradicts its current state: different input or a
  // changed target is needed.
  NotFound: false,
  Conflict: false,
  Unprocessable: false,
  // The operation ran out of time, not out of options: the same call can finish within its
  // budget on a quieter server. A timed-out `weft.workflows.update` stays queued, and its
  // `data.updateId` finds the answer, which `remediation` can say.
  Timeout: true,
  PayloadTooLarge: false,
  NotImplemented: false,
  UnsupportedTransport: false,
  // The subscriber fell behind and events were dropped; resuming needs a new cursor, so the
  // identical call is not the repair.
  SubscriptionOverflow: false,
  InvalidParams: false,
  MethodNotFound: false,
  // The caller's revision is behind the resource: re-read, then send the new revision.
  StaleRevision: false,
  RateLimited: true,
  Unavailable: true,
  UnsupportedCapability: false,
  // A server defect. It discloses nothing and promises nothing.
  EngineFailure: false,
});

/** Whether `code`'s fault tells the caller that repeating the identical call later can succeed. */
export function isFaultRetryable(code: FaultCode): boolean {
  return FAULT_CODE_RETRYABLE[code];
}

const faultCodes = new Set<unknown>(FAULT_CODES);

/**
 * Type guard: narrows an unknown wire value to a known {@link FaultCode}.
 *
 * @example
 * ```ts
 * import { isFaultCode } from '@lostgradient/backchannel';
 *
 * isFaultCode('NotFound'); // true
 * isFaultCode('teapot'); // false
 * ```
 */
export function isFaultCode(value: unknown): value is FaultCode {
  return faultCodes.has(value);
}
