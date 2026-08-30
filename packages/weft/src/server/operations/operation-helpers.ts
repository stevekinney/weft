import type { WeftErrorCode } from '../../core/weft-error.ts';
import {
  shapeRestFaultAsJson,
  type OperationFault,
  type RestFaultResponseOptions,
} from '../operation-fault.ts';

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
export function invalidParamsFault(message: string, weftCode?: WeftErrorCode): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: weftCode === undefined ? { issues: [] } : { issues: [], weftCode },
  };
}

/**
 * Default REST fault shaper. Delegates to the centralized, exhaustively
 * audited REST projection so direct and per-operation bindings cannot drift.
 * REST-only — JSON-RPC transports receive their distinct operation fault data.
 *
 * When the fault carries a fine-grained `data.weftCode` (set only at sites that
 * hold a typed `WeftError`), it remains a top-level `weftCode` sibling. Safe
 * structured fields are added under `data`; fields outside the per-code
 * allowlist are withheld. `EngineFailure` stays byte-identically masked.
 */
export function shapeRestFault(
  fault: OperationFault,
  options?: RestFaultResponseOptions,
): Response {
  return shapeRestFaultAsJson(fault, options);
}
