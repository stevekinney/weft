/**
 * Weft's {@link FaultPolicy}: the engine error classes the generic dispatch code does not name,
 * and the environment settings that decide strict mode.
 *
 * @module server/weft-fault-policy
 */

import type { FaultPolicy, OperationFault } from "../embedded/backchannel/src/index.ts";
import {
  WorkflowAlreadyExistsError,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
} from '../core/engine/errors.ts';
import { isWeftErrorCode } from '../core/weft-error.ts';
import { resolveServerEnvironment } from '../runtime/environment-configuration.ts';

function classifyWeftError(error: unknown): OperationFault | undefined {
  if (error instanceof WorkflowAlreadyExistsError) {
    return {
      code: 'Conflict',
      message: 'conflict',
      data: { reason: 'resource already exists' },
    };
  }
  if (error instanceof WorkflowNotRegisteredError) {
    return {
      code: 'InvalidParams',
      message: error.message,
      data: { issues: [] },
    };
  }
  if (error instanceof WorkflowNotFoundError) {
    return {
      code: 'NotFound',
      message: 'not found',
      data: { resource: 'workflow' },
    };
  }
  return undefined;
}

/**
 * The fault policy of a host built on Weft's engine, for `createOperationHandler({ faultPolicy })`.
 *
 * Strict mode follows the environment on every undeclared fault: strict when `WEFT_STRICT_FAULTS`
 * is `1` or `NODE_ENV` is not `production`. In production an undeclared fault passes through
 * with a warning. The three workflow error classes answer `Conflict`, `InvalidParams` and
 * `NotFound`. A REST body keeps a fault's `weftCode` only when it is one of Weft's error codes.
 *
 * @example
 * ```ts
 * import { createOperationHandler } from '@lostgradient/backchannel';
 * import { weftFaultPolicy } from '@lostgradient/weft';
 *
 * const handler = createOperationHandler({ operations: [], host: {}, faultPolicy: weftFaultPolicy });
 * void handler;
 * ```
 */
export const weftFaultPolicy: FaultPolicy = Object.freeze({
  strict: (): boolean => {
    const environment = resolveServerEnvironment();
    return environment.weftStrictFaults || environment.nodeEnv !== 'production';
  },
  classifyError: classifyWeftError,
  isKnownErrorCode: (value: string): boolean => isWeftErrorCode(value),
});
