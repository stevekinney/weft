/**
 * Weft's view of the transport-neutral {@link OperationFault}: the precise types of the four
 * fields that exist for Weft's own errors, and the REST projections bound to Weft's error codes.
 *
 * `OperationFault` (`operation-fault.ts`) names those fields with structural types so the fault
 * model imports nothing from Weft. Code that reads one of them, and code that answers a REST
 * request on Weft's behalf, comes here.
 *
 * @module server/weft-operation-fault
 */

import { type OperationFault } from "../embedded/backchannel/src/index.ts";
import {
  faultToHttpResponse,
  shapeOperationFaultAsJson,
  shapeRestFaultAsJson,
  type RestFaultResponseOptions,
} from "../embedded/backchannel/src/internals.ts";
import type { WorkflowCompatibilityReason } from '../core/contract/compatibility.ts';
import type { WorkflowSourceRejectionReason } from '../core/source/errors.ts';
import { isWeftErrorCode, type WeftErrorCode } from '../core/weft-error.ts';

/** What Weft's errors add to the `data` of the faults they map onto. */
type WeftFaultDataFields = {
  readonly NotFound: { readonly weftCode?: WeftErrorCode };
  readonly Conflict: {
    readonly weftCode?: WeftErrorCode;
    readonly compatibilityReasons?: readonly WorkflowCompatibilityReason[] | undefined;
    readonly sourceValidationReasons?: readonly WorkflowSourceRejectionReason[] | undefined;
  };
  readonly InvalidParams: { readonly weftCode?: WeftErrorCode };
  readonly Timeout: { readonly updateId?: string | undefined };
};

type WeftFaultCode = keyof WeftFaultDataFields;

/**
 * The fault Weft's own code reads: {@link OperationFault} with the four Weft-only fields
 * (`weftCode`, `compatibilityReasons`, `sourceValidationReasons` and `updateId`) at their precise
 * types. Every `WeftOperationFault` is an `OperationFault`; a plain `OperationFault` is narrowed
 * to this with {@link asWeftOperationFault}.
 */
export type WeftOperationFault =
  | Exclude<OperationFault, { code: WeftFaultCode }>
  | {
      [Code in WeftFaultCode]: Omit<Extract<OperationFault, { code: Code }>, 'data'> & {
        data: Omit<
          Extract<OperationFault, { code: Code }>['data'],
          keyof WeftFaultDataFields[Code]
        > &
          WeftFaultDataFields[Code];
      };
    }[WeftFaultCode];

/**
 * Narrow a fault to Weft's precise type. The cast is sound for a fault Weft's own code built, as
 * every fault Weft produces sets those four fields only from the typed errors above.
 */
export function asWeftOperationFault(fault: OperationFault): WeftOperationFault {
  return fault as WeftOperationFault;
}

function isKnownWeftErrorCode(value: string): boolean {
  return isWeftErrorCode(value);
}

function withWeftErrorCodes(
  options: RestFaultResponseOptions | undefined,
): RestFaultResponseOptions {
  return { ...options, isKnownErrorCode: isKnownWeftErrorCode };
}

/** {@link shapeRestFaultAsJson} with a `weftCode` kept only when it is one of Weft's error codes. */
export function shapeWeftRestFaultAsJson(
  fault: OperationFault,
  options?: RestFaultResponseOptions,
): Response {
  return shapeRestFaultAsJson(fault, withWeftErrorCodes(options));
}

/** {@link shapeOperationFaultAsJson} with a `weftCode` kept only when it is one of Weft's error codes. */
export function shapeWeftOperationFaultAsJson(
  fault: OperationFault,
  options?: RestFaultResponseOptions,
): Response {
  return shapeOperationFaultAsJson(fault, withWeftErrorCodes(options));
}

/** {@link faultToHttpResponse} with a `weftCode` kept only when it is one of Weft's error codes. */
export function weftFaultToHttpResponse(fault: OperationFault): Response {
  return faultToHttpResponse(fault, withWeftErrorCodes(undefined));
}
