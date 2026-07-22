import { describe, expect, it } from 'bun:test';

import type { z } from 'zod';
import type { FaultCode } from '../core/fault-code.ts';
import {
  buildOpenRpcComponentsErrors,
  ConflictDataSchema,
  EngineFailureDataSchema,
  ForbiddenDataSchema,
  InvalidParamsDataSchema,
  MethodNotFoundDataSchema,
  NotFoundDataSchema,
  NotImplementedDataSchema,
  SubscriptionOverflowDataSchema,
  TimeoutDataSchema,
  UnauthorizedDataSchema,
  UnprocessableDataSchema,
  UnsupportedTransportDataSchema,
} from './openrpc-errors.ts';
import {
  FAULT_CODE_TO_HTTP_STATUS,
  FAULT_CODE_TO_JSON_RPC_CODE,
  type OperationFault,
} from './operation-fault.ts';

type OperationFaultWithCode<Code extends FaultCode> = Extract<OperationFault, { code: Code }>;
// Bidirectional assertion: each fault's data type and the corresponding Zod
// schema's inferred type must be mutually assignable. Catches drift in BOTH
// directions — a schema narrower than the fault (would reject valid data) AND
// a schema wider than the fault (would accept data the fault never produces).
type AssertMutuallyExtends<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

type _CheckUnauthorized = AssertMutuallyExtends<
  OperationFaultWithCode<'Unauthorized'>['data'],
  z.infer<typeof UnauthorizedDataSchema>
>;
type _CheckForbidden = AssertMutuallyExtends<
  OperationFaultWithCode<'Forbidden'>['data'],
  z.infer<typeof ForbiddenDataSchema>
>;
type _CheckNotFound = AssertMutuallyExtends<
  OperationFaultWithCode<'NotFound'>['data'],
  z.infer<typeof NotFoundDataSchema>
>;
type _CheckConflict = AssertMutuallyExtends<
  OperationFaultWithCode<'Conflict'>['data'],
  z.infer<typeof ConflictDataSchema>
>;
type _CheckUnprocessable = AssertMutuallyExtends<
  OperationFaultWithCode<'Unprocessable'>['data'],
  z.infer<typeof UnprocessableDataSchema>
>;
type _CheckTimeout = AssertMutuallyExtends<
  OperationFaultWithCode<'Timeout'>['data'],
  z.infer<typeof TimeoutDataSchema>
>;
type _CheckNotImplemented = AssertMutuallyExtends<
  OperationFaultWithCode<'NotImplemented'>['data'],
  z.infer<typeof NotImplementedDataSchema>
>;
type _CheckUnsupportedTransport = AssertMutuallyExtends<
  OperationFaultWithCode<'UnsupportedTransport'>['data'],
  z.infer<typeof UnsupportedTransportDataSchema>
>;
type _CheckSubscriptionOverflow = AssertMutuallyExtends<
  OperationFaultWithCode<'SubscriptionOverflow'>['data'],
  z.infer<typeof SubscriptionOverflowDataSchema>
>;
type _CheckInvalidParams = AssertMutuallyExtends<
  OperationFaultWithCode<'InvalidParams'>['data'],
  z.infer<typeof InvalidParamsDataSchema>
>;
type _CheckMethodNotFound = AssertMutuallyExtends<
  OperationFaultWithCode<'MethodNotFound'>['data'],
  z.infer<typeof MethodNotFoundDataSchema>
>;
type _CheckEngineFailure = AssertMutuallyExtends<
  OperationFaultWithCode<'EngineFailure'>['data'],
  z.infer<typeof EngineFailureDataSchema>
>;

const typeSyncChecks = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
] satisfies [
  _CheckUnauthorized,
  _CheckForbidden,
  _CheckNotFound,
  _CheckConflict,
  _CheckUnprocessable,
  _CheckTimeout,
  _CheckNotImplemented,
  _CheckUnsupportedTransport,
  _CheckSubscriptionOverflow,
  _CheckInvalidParams,
  _CheckMethodNotFound,
  _CheckEngineFailure,
];

describe('OpenRPC components.errors', () => {
  it('keeps the compile-time fault data schema sync checks active', () => {
    expect(typeSyncChecks).toHaveLength(12);
  });

  it('emits exactly one error component per FaultCode with matching transport codes', () => {
    const errors = buildOpenRpcComponentsErrors();
    const faultCodes = Object.keys(FAULT_CODE_TO_JSON_RPC_CODE).toSorted();

    expect(Object.keys(errors).toSorted()).toEqual(faultCodes);
    for (const faultCode of faultCodes as FaultCode[]) {
      expect(errors[faultCode]).toMatchObject({
        code: FAULT_CODE_TO_JSON_RPC_CODE[faultCode],
        message: faultCode,
        'x-http-status': FAULT_CODE_TO_HTTP_STATUS[faultCode],
      });
    }
  });

  it('emits a non-null data JSON Schema for every error component', () => {
    const errors = buildOpenRpcComponentsErrors();

    for (const error of Object.values(errors)) {
      expect(error.data).toBeDefined();
      expect(error.data).not.toBeNull();
      expect(typeof error.data).toBe('object');
    }
  });
});
