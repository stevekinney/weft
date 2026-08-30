/**
 * `faultToHttpResponse` — pure mapper from a transport-neutral
 * `OperationFault` into a `Response` shaped for the REST surface.
 *
 * This fallback uses the same flat, audited projection as every explicit REST
 * binding. Keeping one mapper prevents a binding that omits `shapeFault` from
 * accidentally exposing a broader nested payload or raw EngineFailure detail.
 */

import { shapeRestFaultAsJson, type OperationFault } from './operation-fault.ts';

export function faultToHttpResponse(fault: OperationFault): Response {
  return shapeRestFaultAsJson(fault);
}
