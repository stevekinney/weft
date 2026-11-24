/**
 * `faultToHttpResponse` — pure mapper from a transport-neutral
 * `OperationFault` into a `Response` shaped for the REST surface.
 *
 * This fallback uses the same flat, audited projection as every explicit REST
 * binding. Keeping one mapper prevents a binding that omits `shapeFault` from
 * accidentally exposing a broader nested payload or raw EngineFailure detail.
 */

import {
  shapeRestFaultAsJson,
  type OperationFault,
  type RestFaultResponseOptions,
} from './operation-fault.ts';

/** Maps an {@link OperationFault} to its REST response. */
export function faultToHttpResponse(
  fault: OperationFault,
  options?: RestFaultResponseOptions,
): Response {
  return shapeRestFaultAsJson(fault, options);
}
