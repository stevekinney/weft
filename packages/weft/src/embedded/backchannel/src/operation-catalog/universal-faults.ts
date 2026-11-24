/**
 * The fault codes every operation can raise without declaring them.
 *
 * @module server/operation-catalog/universal-faults
 */

import type { OperationFault } from '../operation-fault.ts';

/**
 * Fault codes that every operation can raise through the shared pipeline
 * without listing them in `producibleFaults`.
 */
export const UNIVERSAL_FAULT_DEFAULTS: ReadonlySet<OperationFault['code']> = new Set([
  'Unauthorized',
  'Forbidden',
  'InvalidParams',
  'EngineFailure',
]);
