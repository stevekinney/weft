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
 * Per-fault-code payload extractors. The table is typed so every
 * `OperationFault['code']` MUST map to an extractor — adding a new fault
 * variant produces a compile error here (no `default` branch), forcing a
 * deliberate decision about its wire payload and a check that no field
 * collides with the envelope's `weftCode` / `httpStatus` keys.
 */
type FaultExtractor<C extends OperationFault['code']> = (
  data: Extract<OperationFault, { code: C }>['data'],
) => Record<string, unknown>;

type FaultExtractors = {
  [C in OperationFault['code']]: FaultExtractor<C>;
};

const EMPTY: Record<string, unknown> = {};

const FAULT_DATA_EXTRACTORS: FaultExtractors = {
  NotImplemented: () => EMPTY,
  EngineFailure: () => EMPTY,
  Unauthorized: (data) => ({ reason: data.reason }),
  Forbidden: (data) => ({ reason: data.reason }),
  Unprocessable: (data) => ({ reason: data.reason }),
  Conflict: dataForConflict,
  NotFound: dataForNotFound,
  Timeout: dataForTimeout,
  PayloadTooLarge: (data) => ({ maxBytes: data.maxBytes }),
  UnsupportedTransport: dataForUnsupportedTransport,
  SubscriptionOverflow: dataForSubscriptionOverflow,
  InvalidParams: dataForInvalidParams,
  MethodNotFound: (data) => ({ method: data.method }),
};

function extractFaultDataPayload(fault: OperationFault): Record<string, unknown> {
  // The cast is sound because `FAULT_DATA_EXTRACTORS` is typed so each key
  // maps to an extractor for that fault's data — TypeScript cannot narrow
  // `fault.data` through the dynamic lookup, so we delegate to the table.
  const extractor = FAULT_DATA_EXTRACTORS[fault.code] as FaultExtractor<typeof fault.code>;
  return extractor(fault.data);
}

function dataForConflict(
  data: Extract<OperationFault, { code: 'Conflict' }>['data'],
): Record<string, unknown> {
  return filterDefined({
    reason: data.reason,
    missingTypes: data.missingTypes === undefined ? undefined : [...data.missingTypes],
    missingWorkflowCount: data.missingWorkflowCount,
    samplesTruncated: data.samplesTruncated,
  });
}

function dataForNotFound(
  data: Extract<OperationFault, { code: 'NotFound' }>['data'],
): Record<string, unknown> {
  return data.identifier === undefined
    ? { resource: data.resource }
    : { resource: data.resource, identifier: data.identifier };
}

function dataForTimeout(
  data: Extract<OperationFault, { code: 'Timeout' }>['data'],
): Record<string, unknown> {
  return data.operationName === undefined ? {} : { operationName: data.operationName };
}

function dataForUnsupportedTransport(
  data: Extract<OperationFault, { code: 'UnsupportedTransport' }>['data'],
): Record<string, unknown> {
  return { transport: data.transport, supported: [...data.supported] };
}

function dataForSubscriptionOverflow(
  data: Extract<OperationFault, { code: 'SubscriptionOverflow' }>['data'],
): Record<string, unknown> {
  return { subscriptionId: data.subscriptionId, droppedCount: data.droppedCount };
}

function dataForInvalidParams(
  data: Extract<OperationFault, { code: 'InvalidParams' }>['data'],
): Record<string, unknown> {
  return { issues: data.issues.map((issue) => ({ ...issue, path: [...issue.path] })) };
}

function filterDefined(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}
