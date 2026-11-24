/**
 * Helpers that build and recognise a transport-neutral {@link OperationFault}, with no knowledge of
 * a host's error classes.
 *
 * @module server/operation-fault-helpers
 */

import type { OperationFault } from './operation-fault.ts';

/** Type guard distinguishing an `OperationFault` from a value type. */
export function isOperationFault(value: unknown): value is OperationFault {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    'data' in value
  );
}

/**
 * Construct an `InvalidParams` fault with the `{ issues: [] }` data
 * shape. This is the canonical 400-class fault for caller-input validation
 * errors raised inside `invoke()` or `extractInput()`.
 *
 * Pass `weftCode` only when a typed `WeftError` is in hand (e.g. a caught
 * `WorkflowNotRegisteredError`) so REST clients can branch on it through
 * `isWeftFault`. It is omitted entirely when absent — never written as
 * `weftCode: undefined` — so the dozens of generic validation callers keep
 * their exact `{ issues: [] }` data shape.
 */
export function invalidParamsFault(message: string, weftCode?: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: weftCode === undefined ? { issues: [] } : { issues: [], weftCode },
  };
}
