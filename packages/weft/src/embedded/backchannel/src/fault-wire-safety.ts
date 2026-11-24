/**
 * What keeps a fault from putting a value on the wire that JSON cannot carry: the factories refuse
 * a non-finite number in a fault's `data`, and the wire projections answer a fault that holds one
 * as the masked internal error instead of throwing.
 *
 * @module fault-wire-safety
 */

import type { OperationFault } from './operation-fault.ts';

/**
 * Refuse a fault whose `data` carries a number that JSON cannot represent.
 * `NaN` and `Infinity` serialize as `null`, so a `StaleRevision` with a
 * non-finite `currentRevision`, for one, would put a `null` on the wire where
 * the schema requires a revision. That is a programming error in whoever built
 * the fault, so it throws rather than producing a body that violates the
 * contract. The one exception is `retryAfterSeconds`, a hint a client can do
 * without: {@link usableRetryAfterSeconds} drops it from every projection.
 *
 * Called by the fault factories. The wire projections use {@link wireSafeFault}
 * instead, so a fault written as an object literal still gets a reply.
 */
export function assertFiniteFaultData(fault: OperationFault): void {
  const field = findNonFiniteFaultField(fault);
  if (field !== undefined) {
    throw new TypeError(
      `The ${fault.code} fault's data.${field} must be a finite number, got ${String(faultDataValue(fault, field))}`,
    );
  }
}

/** The first `data` field (other than `retryAfterSeconds`) holding a non-finite number. */
function findNonFiniteFaultField(fault: OperationFault): string | undefined {
  for (const [field, value] of Object.entries(fault.data)) {
    if (field === 'retryAfterSeconds') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) return field;
  }
  return undefined;
}

function faultDataValue(fault: OperationFault, field: string): unknown {
  return (fault.data as Record<string, unknown>)[field];
}

/**
 * The fault a wire projection may send. A fault whose `data` holds a non-finite
 * number is a programming error that slipped past the factories (for example,
 * a fault written as an object literal). Throwing from a projection would leave
 * the request without a reply (a JSON-RPC WebSocket client would wait forever),
 * so the projection logs it and answers with the masked internal error instead,
 * keeping the request's id.
 */
export function wireSafeFault(fault: OperationFault): OperationFault {
  const field = findNonFiniteFaultField(fault);
  if (field === undefined) return fault;
  console.error(
    `[weft] The ${fault.code} fault's data.${field} is not a finite number (${String(faultDataValue(fault, field))}); answering with an internal error instead.`,
  );
  return { code: 'EngineFailure', message: 'internal error', data: {} };
}

/**
 * Build a `StaleRevision` fault. Throws a `TypeError` when `currentRevision` or
 * `expectedRevision` is a non-finite number ({@link assertFiniteFaultData}).
 */
export function staleRevisionFault(
  message: string,
  data: Extract<OperationFault, { code: 'StaleRevision' }>['data'],
): Extract<OperationFault, { code: 'StaleRevision' }> {
  const fault = { code: 'StaleRevision', message, data } as const;
  assertFiniteFaultData(fault);
  return fault;
}

/**
 * A `retryAfterSeconds` a client can act on: finite and not negative. `NaN`
 * and `Infinity` do not survive JSON (they serialize as `null`), and a
 * negative delay is meaningless, so every wire projection drops them.
 */
export function usableRetryAfterSeconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds;
}
