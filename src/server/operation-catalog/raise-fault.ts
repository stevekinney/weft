/**
 * Helpers for enforcing an operation's declared producible fault set.
 *
 * @module server/operation-catalog/raise-fault
 */

import type { FaultCode } from '../../core/fault-code.ts';
import type { OperationFault } from '../operation-fault.ts';
import type { ErasedOperation } from './types.ts';

/**
 * Fault codes that every operation can raise through the shared pipeline
 * without listing them in `producibleFaults`.
 */
export const UNIVERSAL_FAULT_DEFAULTS: ReadonlySet<FaultCode> = new Set([
  'Unauthorized',
  'Forbidden',
  'InvalidParams',
  'EngineFailure',
]);

/**
 * Throw an `OperationFault` after checking it against an operation's declared
 * `producibleFaults`.
 *
 * Development and test environments fail hard for undeclared faults. Production
 * preserves the original fault semantics and logs the declaration violation so
 * clients still receive actionable error codes.
 *
 * Universal defaults (always allowed, never need declaration):
 * Unauthorized | Forbidden | InvalidParams | EngineFailure
 *
 * In test/development (NODE_ENV !== 'production' OR WEFT_STRICT_FAULTS=1),
 * raising an undeclared fault throws a hard error so the developer must
 * declare or remove the fault. In production the original fault is preserved
 * and forwarded; the violation is logged to console.error.
 */
export function raiseFault(
  operation:
    | ErasedOperation
    | { readonly name: string; readonly producibleFaults?: readonly FaultCode[] },
  fault: OperationFault,
): never {
  const declared = new Set<FaultCode>([
    ...UNIVERSAL_FAULT_DEFAULTS,
    ...(operation.producibleFaults ?? []),
  ]);

  const isStrict = Bun.env['WEFT_STRICT_FAULTS'] === '1' || Bun.env['NODE_ENV'] !== 'production';

  if (!declared.has(fault.code)) {
    if (isStrict) {
      throw new Error(
        `Operation "${operation.name}" raised undeclared fault "${fault.code}". ` +
          `Add "${fault.code}" to producibleFaults or remove the fault.`,
      );
    }

    console.error(
      `[weft] Operation "${operation.name}" raised undeclared fault "${fault.code}". ` +
        'This will become a hard error in a future version.',
    );
  }

  throw fault;
}
