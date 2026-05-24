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
 */
export function invalidParamsFault(message: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: { issues: [] },
  };
}

/**
 * Default REST fault shaper: masks `EngineFailure` to a generic
 * `"Internal server error"` 500; other faults map by `FAULT_CODE_TO_HTTP_STATUS`.
 * REST-only — JSON-RPC transports receive unmasked faults.
 */
export function shapeRestFault(fault: OperationFault): Response {
  if (fault.code === 'EngineFailure') {
    return jsonErrorResponse('Internal server error', 500);
  }
  return jsonErrorResponse(fault.message, FAULT_CODE_TO_HTTP_STATUS[fault.code]);
}
