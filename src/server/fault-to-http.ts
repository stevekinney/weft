/**
 * `faultToHttpResponse` — pure mapper from a transport-neutral
 * `OperationFault` into a `Response` shaped for the REST surface.
 *
 * Body shape: `{ error: { code, message, data? } }`. The `code` matches the
 * fault discriminant verbatim so REST clients can switch on the same names
 * that JSON-RPC clients see in their `data.weftCode`.
 *
 * Pure: no engine, no I/O, no logging. Errors visible to clients are
 * exactly what the fault carries; internal `EngineFailure` detail belongs
 * in server logs, not the response body.
 */

import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from './operation-fault.ts';

export function faultToHttpResponse(fault: OperationFault): Response {
  const status = FAULT_CODE_TO_HTTP_STATUS[fault.code];
  const body = JSON.stringify({ error: shapeErrorBody(fault) });
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });

  return new Response(body, { status, headers });
}

type ErrorBody = {
  code: OperationFault['code'];
  message: string;
  data?: unknown;
};

function shapeErrorBody(fault: OperationFault): ErrorBody {
  const base: ErrorBody = { code: fault.code, message: fault.message };
  // EngineFailure and NotImplemented carry `data: {}` for type uniformity
  // but the wire body omits the field — the empty object would be noise
  // for clients that branch on `data` presence.
  if (fault.code === 'EngineFailure' || fault.code === 'NotImplemented') {
    return base;
  }
  if (fault.code === 'Timeout') return shapeTimeoutBody(base, fault.data);
  if (fault.code === 'NotFound') return shapeNotFoundBody(base, fault.data);
  return { ...base, data: fault.data };
}

function shapeTimeoutBody(
  base: ErrorBody,
  data: Extract<OperationFault, { code: 'Timeout' }>['data'],
): ErrorBody {
  const defined = filterDefined(data);
  return Object.keys(defined).length === 0 ? base : { ...base, data: defined };
}

function shapeNotFoundBody(
  base: ErrorBody,
  data: Extract<OperationFault, { code: 'NotFound' }>['data'],
): ErrorBody {
  // Forward only the fields that are present so a NotFound without an
  // identifier or weftCode keeps its minimal `{ resource }` wire shape.
  // `weftCode` keeps its `WeftErrorCode` type (derived from the fault payload)
  // rather than widening to `string`, so a future edit can't serialize an
  // invalid code.
  const shaped: {
    resource: string;
    identifier?: string;
    weftCode?: NonNullable<typeof data.weftCode>;
  } = {
    resource: data.resource,
  };
  if (data.identifier !== undefined) shaped.identifier = data.identifier;
  if (data.weftCode !== undefined) shaped.weftCode = data.weftCode;
  return { ...base, data: shaped };
}

function filterDefined(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}
