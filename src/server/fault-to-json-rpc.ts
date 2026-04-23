/**
 * `faultToJsonRpcError` — pure mapper from a transport-neutral
 * `OperationFault` into the JSON-RPC 2.0 error object the dispatchers send.
 *
 * Wire shape: `{ code, message, data }`. The numeric `code` follows the
 * JSON-RPC spec for reserved errors (`InvalidParams: -32602`,
 * `MethodNotFound: -32601`) and the Weft domain band -32010..-32099 for
 * everything else (per Track 8 design decision 4).
 *
 * Every `data` object carries `{ weftCode, httpStatus }` plus the typed
 * fault-specific payload. The pair is a uniform machine-readable handle:
 * clients can route on `weftCode` (string) when they want symbolic names,
 * or on `httpStatus` (number) when they want HTTP-equivalent semantics.
 *
 * Pure: no engine, no I/O. The fault decides the wire shape.
 */

import {
  FAULT_CODE_TO_HTTP_STATUS,
  FAULT_CODE_TO_JSON_RPC_CODE,
  type OperationFault,
} from './operation-fault.ts';

export type JsonRpcError = {
  code: number;
  message: string;
  data: Record<string, unknown>;
};

export function faultToJsonRpcError(fault: OperationFault): JsonRpcError {
  const code = FAULT_CODE_TO_JSON_RPC_CODE[fault.code];
  const httpStatus = FAULT_CODE_TO_HTTP_STATUS[fault.code];
  // Envelope keys are written LAST so a future payload field accidentally
  // named `weftCode` or `httpStatus` cannot overwrite the canonical metadata.
  const data: Record<string, unknown> = {
    ...extractFaultDataPayload(fault),
    weftCode: fault.code,
    httpStatus,
  };
  return { code, message: fault.message, data };
}

/**
 * Extract the fault's typed `data` payload as a plain object suitable for
 * spreading into the JSON-RPC `data` envelope. Exhaustive over `FaultCode`
 * with no `default` branch — adding a new fault variant must produce a
 * compile error here so we deliberately decide what its data shape spreads
 * to (and verify no field collides with the envelope's `weftCode` /
 * `httpStatus` keys).
 */
function extractFaultDataPayload(fault: OperationFault): Record<string, unknown> {
  switch (fault.code) {
    case 'NotImplemented':
    case 'EngineFailure':
      return {};
    case 'Unauthorized':
    case 'Forbidden':
    case 'Conflict':
    case 'Unprocessable':
      return { reason: fault.data.reason };
    case 'NotFound':
      return fault.data.identifier === undefined
        ? { resource: fault.data.resource }
        : { resource: fault.data.resource, identifier: fault.data.identifier };
    case 'Timeout':
      return fault.data.operationName === undefined
        ? {}
        : { operationName: fault.data.operationName };
    case 'RateLimited':
      // Only expose retryAfterMs when it's a finite positive number — NaN /
      // Infinity would JSON-serialize to `null` and leave clients with a
      // typed-as-number field whose wire value violates the type contract.
      return typeof fault.data.retryAfterMs === 'number' &&
        Number.isFinite(fault.data.retryAfterMs) &&
        fault.data.retryAfterMs > 0
        ? { retryAfterMs: fault.data.retryAfterMs }
        : {};
    case 'UnsupportedTransport':
      return { transport: fault.data.transport, supported: [...fault.data.supported] };
    case 'SubscriptionOverflow':
      return {
        subscriptionId: fault.data.subscriptionId,
        droppedCount: fault.data.droppedCount,
      };
    case 'InvalidParams':
      return { issues: fault.data.issues.map((issue) => ({ ...issue, path: [...issue.path] })) };
    case 'MethodNotFound':
      return { method: fault.data.method };
  }
}
