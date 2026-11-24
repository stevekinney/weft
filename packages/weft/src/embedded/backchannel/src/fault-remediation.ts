/**
 * What a fault tells the caller about the way on: `remediation` (one line of plain text, what to do
 * next) and, from the code's table, `retryable`. {@link faultWireAdvice} is the one place the REST,
 * JSON-RPC and MCP projections get both from, so the transports cannot drift.
 *
 * @module fault-remediation
 */

import { FAULT_CODE_RETRYABLE } from './fault-code.ts';
import type { OperationFault } from './operation-fault.ts';

/** The longest `remediation`, in characters (Unicode code points). */
export const MAX_REMEDIATION_LENGTH = 500;

const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Why `value` cannot be a fault's `remediation`, or `undefined` when it can. A remediation is one
 * line of plain text: 1 to {@link MAX_REMEDIATION_LENGTH} characters, containing no character in
 * the Unicode control category (`Cc`), a newline or a tab included.
 */
export function remediationProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length === 0) return 'must not be empty';
  if (Array.from(value).length > MAX_REMEDIATION_LENGTH) {
    return `must be at most ${MAX_REMEDIATION_LENGTH} characters`;
  }
  if (CONTROL_CHARACTER.test(value)) return 'must be one line with no control characters';
  return undefined;
}

/** Throws a `TypeError` when `value` is not a valid `remediation` ({@link remediationProblem}). */
export function assertValidRemediation(value: unknown): asserts value is string {
  const problem = remediationProblem(value);
  if (problem !== undefined) throw new TypeError(`A fault's remediation ${problem}`);
}

/** `fault` with `remediation` set; throws a `TypeError` when the text is not valid. */
export function withRemediation<Fault extends OperationFault>(
  fault: Fault,
  remediation: string,
): Fault {
  assertValidRemediation(remediation);
  return { ...fault, remediation };
}

/**
 * The advice every wire projection (REST, JSON-RPC, MCP) puts on a fault: `retryable` always, from
 * the code's single table, and `remediation` only when the fault carries a valid one. An invalid
 * value is dropped rather than thrown, as a projection must always answer. `EngineFailure`
 * discloses nothing, so it never carries a remediation even when the fault object holds one.
 */
export function faultWireAdvice(fault: OperationFault): {
  readonly retryable: boolean;
  readonly remediation?: string;
} {
  const retryable = FAULT_CODE_RETRYABLE[fault.code];
  const { remediation } = fault;
  if (fault.code === 'EngineFailure' || remediation === undefined) return { retryable };
  return remediationProblem(remediation) === undefined ? { retryable, remediation } : { retryable };
}
