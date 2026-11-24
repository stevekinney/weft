/**
 * `faultToJsonRpcError` — pure mapper from a transport-neutral
 * `OperationFault` into the JSON-RPC 2.0 error object the dispatchers send.
 *
 * Wire shape: `{ code, message, data }`. The numeric `code` follows the
 * JSON-RPC spec for reserved errors (`InvalidParams: -32602`,
 * `MethodNotFound: -32601`) and the Weft domain band -32010..-32099 for
 * everything else. This stable error-code allocation ensures cross-transport
 * parity.
 *
 * Every `data` object carries `{ weftCode, httpStatus, retryable }` plus the typed
 * fault-specific payload, and `remediation` when the fault carries one. The
 * first two are a uniform machine-readable handle: clients can route on
 * `weftCode` when they want symbolic names, or on `httpStatus` (number) when
 * they want HTTP-equivalent semantics. `retryable` says whether repeating the
 * identical call later can succeed, and `remediation` what to do next (see
 * `faultWireAdvice` in `operation-fault.ts`).
 *
 * Here `weftCode` is the coarse `FaultCode` (`fault.code`, e.g. `NotFound`),
 * NOT the fine-grained `WeftErrorCode` (e.g. `WorkflowNotFoundError`) that
 * the REST body's top-level `weftCode` carries (`shapeRestFaultAsJson` in
 * `operation-fault.ts`). Because the envelope keys are written last, a
 * fine-grained `weftCode` inside the fault's own data does not survive onto
 * this wire. The asymmetry is the current wire contract; see
 * `documentation/reference/api-errors.md#wire-envelopes`.
 *
 * No engine and no I/O, apart from one diagnostic when a malformed fault is
 * replaced by the masked internal error (see `wireSafeFault`). The fault
 * decides the wire shape.
 */

import { FAULT_CODE_RETRYABLE, type FaultCode } from './fault-code.ts';
import { faultWireAdvice } from './fault-remediation.ts';
import { usableRetryAfterSeconds, wireSafeFault } from './fault-wire-safety.ts';
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

/** Maps an {@link OperationFault} to a JSON-RPC error object. */
export function faultToJsonRpcError(unsafeFault: OperationFault): JsonRpcError {
  const fault = wireSafeFault(unsafeFault);
  const code = FAULT_CODE_TO_JSON_RPC_CODE[fault.code];
  const httpStatus = FAULT_CODE_TO_HTTP_STATUS[fault.code];
  // Envelope keys are written LAST so a future payload field accidentally
  // named `weftCode` or `httpStatus` cannot overwrite the canonical metadata.
  const { retryable, remediation } = faultWireAdvice(fault);
  const data: Record<string, unknown> = {
    ...extractFaultDataPayload(fault),
    weftCode: fault.code,
    httpStatus,
    retryable,
    ...(remediation === undefined ? {} : { remediation }),
  };
  return { code, message: fault.message, data };
}

/**
 * The `error.data` of a JSON-RPC error a transport answers itself, before or beside the operation
 * pipeline (a frame too large, a refused first frame, an unknown subscription): the envelope keys
 * `faultToJsonRpcError` writes (`weftCode`, `httpStatus`, `retryable`) for the fault `code`, with
 * `payload` as the fault's own fields. A transport that writes the keys by hand drops the ones a
 * later field adds, so every such error builds its `data` here.
 */
export function faultErrorData(
  code: FaultCode,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...payload,
    weftCode: code,
    httpStatus: FAULT_CODE_TO_HTTP_STATUS[code],
    retryable: FAULT_CODE_RETRYABLE[code],
  };
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
  StaleRevision: (data) => ({
    currentRevision: data.currentRevision,
    ...(data.expectedRevision === undefined ? {} : { expectedRevision: data.expectedRevision }),
  }),
  RateLimited: (data) =>
    filterDefined({ retryAfterSeconds: usableRetryAfterSeconds(data.retryAfterSeconds) }),
  Unavailable: (data) =>
    filterDefined({
      reason: data.reason,
      retryAfterSeconds: usableRetryAfterSeconds(data.retryAfterSeconds),
    }),
  UnsupportedCapability: (data) => ({ capability: data.capability }),
};

/**
 * The fields of a fault's `data` a wire projection may send: the deny-by-default allowlist for its
 * code. The JSON-RPC envelope and the Server-Sent Events error frame both build their `data` here,
 * so a field is never sent by one transport and withheld by another.
 */
export function extractFaultDataPayload(fault: OperationFault): Record<string, unknown> {
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
    currentGeneration: data.currentGeneration,
    compatibilityReasons:
      data.compatibilityReasons === undefined ? undefined : [...data.compatibilityReasons],
    sourceValidationReasons:
      data.sourceValidationReasons === undefined ? undefined : [...data.sourceValidationReasons],
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
  return {
    ...(data.operationName === undefined ? {} : { operationName: data.operationName }),
    ...(data.updateId === undefined ? {} : { updateId: data.updateId }),
  };
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
