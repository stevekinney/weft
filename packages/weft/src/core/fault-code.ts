/**
 * `FAULT_CODE_TO_FAILURE_CATEGORY` is the single source of truth for mapping a
 * wire fault code onto the coarser {@link FailureCategory} execution taxonomy.
 * The category is a derived convenience: it is **not** carried on the wire, so
 * a client computes it from `faultCode` rather than reading it from the body.
 *
 * The `FaultCode` type itself lives in `server/fault-code.ts`, beside the
 * transport-neutral fault model that produces it.
 */

import type { FaultCode } from "../embedded/backchannel/src/index.ts";
import type { FailureCategory } from './types/identity.ts';

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
  // The caller's expected revision no longer matches the current one.
  StaleRevision: 'application',
  // Deadline exceeded.
  Timeout: 'timeout',
  // Capacity limits.
  PayloadTooLarge: 'resource',
  SubscriptionOverflow: 'resource',
  RateLimited: 'resource',
  // Server cannot fulfill — infrastructure or unimplemented surface.
  NotImplemented: 'system',
  UnsupportedTransport: 'system',
  Unavailable: 'system',
  UnsupportedCapability: 'system',
  EngineFailure: 'system',
} as const satisfies Readonly<Record<FaultCode, FailureCategory>>);

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
