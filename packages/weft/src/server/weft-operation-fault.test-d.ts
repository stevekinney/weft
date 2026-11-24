import type { OperationFault } from "../embedded/backchannel/src/index.ts";
import type { WorkflowCompatibilityReason } from '../core/contract/compatibility.ts';
import type { WorkflowSourceRejectionReason } from '../core/source/errors.ts';
import type { WeftErrorCode } from '../core/weft-error.ts';
import type { WeftOperationFault } from './weft-operation-fault.ts';

type DataOf<Code extends OperationFault['code']> = Extract<
  WeftOperationFault,
  { code: Code }
>['data'];

// Weft code that reads one of the four fields sees the precise Weft type.
export const notFoundCode: WeftErrorCode | undefined = (
  { code: 'NotFound', message: 'm', data: { resource: 'r' } } as Extract<
    WeftOperationFault,
    { code: 'NotFound' }
  >
).data.weftCode;
export const conflictCode: WeftErrorCode | undefined = ({} as DataOf<'Conflict'>).weftCode;
export const invalidParamsCode: WeftErrorCode | undefined = ({} as DataOf<'InvalidParams'>)
  .weftCode;
export const compatibility: readonly WorkflowCompatibilityReason[] | undefined = (
  {} as DataOf<'Conflict'>
).compatibilityReasons;
export const sourceValidation: readonly WorkflowSourceRejectionReason[] | undefined = (
  {} as DataOf<'Conflict'>
).sourceValidationReasons;
export const updateId: string | undefined = ({} as DataOf<'Timeout'>).updateId;

export const arbitraryCode: Extract<WeftOperationFault, { code: 'NotFound' }>['data'] = {
  resource: 'r',
  // @ts-expect-error a weftCode on a Weft fault is one of Weft's error codes, not any string.
  weftCode: 'NotAWeftErrorCode',
};

export const arbitraryReason: DataOf<'Conflict'> = {
  reason: 'r',
  // @ts-expect-error a compatibility reason on a Weft fault is one of Weft's reasons.
  compatibilityReasons: ['not-a-reason'],
};

// A Weft fault is an operation fault, which names the same fields with structural types.
export const asOperationFault: OperationFault = {} as WeftOperationFault;
export const operationFaultCode: string | undefined = (
  {} as Extract<OperationFault, { code: 'NotFound' }>
).data.weftCode;
