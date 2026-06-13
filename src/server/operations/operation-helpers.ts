import { isWeftErrorCode, type WeftErrorCode } from '../../core/weft-error.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';

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
 * Build a JSON error response with the flat shape `{ error: <message> }` and
 * `Content-Type: application/json`. Used by per-operation `shapeFault`
 * implementations that need ad-hoc status codes outside the canonical map.
 */
export function jsonErrorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
 * Default REST fault shaper: masks `EngineFailure` to a generic
 * `"Internal server error"` 500; other faults map by `FAULT_CODE_TO_HTTP_STATUS`.
 * REST-only — JSON-RPC transports receive unmasked faults.
 *
 * When the fault carries a fine-grained `data.weftCode` (set only at sites that
 * hold a typed `WeftError`, e.g. `WorkflowNotFoundError` /
 * `WorkflowNotRegisteredError`), it is emitted as a top-level `weftCode` sibling
 * of the flat `{ error }` body so REST clients can branch transport-uniformly
 * via `isWeftFault`. The body's `error` stays a plain string, so the new field
 * is a sibling rather than nested. Faults without a `weftCode` keep their exact
 * `{ error }` shape, and `EngineFailure` stays masked (it carries no weftCode).
 */
export function shapeRestFault(fault: OperationFault): Response {
  if (fault.code === 'EngineFailure') {
    return jsonErrorResponse('Internal server error', 500);
  }
  const status = FAULT_CODE_TO_HTTP_STATUS[fault.code];
  const weftCode = weftCodeFromFaultData(fault.data);
  if (weftCode === undefined) {
    return jsonErrorResponse(fault.message, status);
  }
  return new Response(JSON.stringify({ error: fault.message, weftCode }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Read a fine-grained `weftCode` off a fault's `data`, when present. */
function weftCodeFromFaultData(data: OperationFault['data']): WeftErrorCode | undefined {
  if (typeof data !== 'object' || data === null || !('weftCode' in data)) {
    return undefined;
  }
  return isWeftErrorCode(data.weftCode) ? data.weftCode : undefined;
}
