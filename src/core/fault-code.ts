/**
 * `FaultCode` is the stable, machine-readable discriminant that the server's
 * operation pipeline attaches to every fault. Transport adapters serialize it
 * onto the wire so clients can branch on the failure programmatically rather
 * than string-matching a human message:
 *
 *   - REST: `{ error: { code, message, data? } }` (see `fault-to-http.ts`).
 *   - JSON-RPC: `data.weftCode` (see `fault-to-json-rpc.ts`).
 *
 * The type lives in `core` — not `server` — because both the server (which
 * produces faults) and the client (which consumes them off the wire) need it,
 * and the client must not import from `server`. The server re-exports it from
 * `operation-fault.ts` so its existing call sites are unaffected.
 *
 * `FAULT_CODE_TO_FAILURE_CATEGORY` is the single source of truth for mapping a
 * wire fault code onto the coarser {@link FailureCategory} execution taxonomy.
 * The category is a derived convenience: it is **not** carried on the wire, so
 * a client computes it from `faultCode` rather than reading it from the body.
 */

import type { FailureCategory } from './types/identity.ts';

/**
 * Stable fault code names. The full vocabulary is closed for v1; new codes can
 * be added additively, and the `satisfies` map below forces every new code to
 * declare its failure category at compile time.
 *
 * @example
 * ```ts
 * import { HttpClientError, type FaultCode } from '@lostgradient/weft';
 *
 * function describe(error: HttpClientError): string {
 *   const code: FaultCode | undefined = error.faultCode;
 *   return code === 'NotFound' ? 'missing resource' : (code ?? 'unknown');
 * }
 * void describe;
 * ```
 */
export type FaultCode =
  | 'Unauthorized'
  | 'Forbidden'
  | 'NotFound'
  | 'Conflict'
  | 'Unprocessable'
  | 'Timeout'
  | 'NotImplemented'
  | 'UnsupportedTransport'
  | 'SubscriptionOverflow'
  | 'InvalidParams'
  | 'MethodNotFound'
  | 'EngineFailure';

/**
 * Maps each wire {@link FaultCode} onto a {@link FailureCategory}.
 *
 * There is deliberately no `cancellation` entry: cancellation never crosses
 * the REST fault wire (HTTP has no fault code for an aborted request), so no
 * fault code can derive that category.
 *
 * Declared with `satisfies` so adding a future `FaultCode` is a compile error
 * until it is mapped here.
 *
 * @example
 * ```ts
 * import { FAULT_CODE_TO_FAILURE_CATEGORY } from '@lostgradient/weft';
 *
 * FAULT_CODE_TO_FAILURE_CATEGORY.Timeout; // 'timeout'
 * ```
 */
export const FAULT_CODE_TO_FAILURE_CATEGORY = Object.freeze({
  // Client-side request faults: the caller asked for something invalid,
  // unauthorized, or against current state.
  Unauthorized: 'application',
  Forbidden: 'application',
  NotFound: 'application',
  Conflict: 'application',
  Unprocessable: 'application',
  InvalidParams: 'application',
  MethodNotFound: 'application',
  // Deadline exceeded.
  Timeout: 'timeout',
  // Capacity limits.
  SubscriptionOverflow: 'resource',
  // Server cannot fulfill — infrastructure or unimplemented surface.
  NotImplemented: 'system',
  UnsupportedTransport: 'system',
  EngineFailure: 'system',
} as const satisfies Readonly<Record<FaultCode, FailureCategory>>);

const faultCodes = new Set<unknown>(Object.keys(FAULT_CODE_TO_FAILURE_CATEGORY));

/**
 * Type guard: narrows an unknown wire value to a known {@link FaultCode}.
 *
 * @example
 * ```ts
 * import { isFaultCode } from '@lostgradient/weft';
 *
 * isFaultCode('NotFound'); // true
 * isFaultCode('teapot'); // false
 * ```
 */
export function isFaultCode(value: unknown): value is FaultCode {
  return faultCodes.has(value);
}

/**
 * Returns the {@link FailureCategory} a given {@link FaultCode} belongs to.
 *
 * @example
 * ```ts
 * import { failureCategoryForFaultCode } from '@lostgradient/weft';
 *
 * failureCategoryForFaultCode('Timeout'); // 'timeout'
 * failureCategoryForFaultCode('EngineFailure'); // 'system'
 * ```
 */
export function failureCategoryForFaultCode(code: FaultCode): FailureCategory {
  return FAULT_CODE_TO_FAILURE_CATEGORY[code];
}
