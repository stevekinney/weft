/**
 * Classifies what an SDK call threw as an {@link A2APeerError}.
 *
 * @module a2a/peer-errors
 */

import { A2APeerError, type A2APeerErrorCode } from './peer-client-types.ts';

const ENVELOPE_CODES: ReadonlyMap<number, A2APeerErrorCode> = new Map([
  [-32001, 'task-not-found'],
  [-32002, 'task-not-cancelable'],
  [-32005, 'content-type-not-supported'],
  [-32008, 'extension-support-required'],
  [-32009, 'version-not-supported'],
]);

function findPeerError(error: unknown): A2APeerError | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor instanceof Error; depth++) {
    if (cursor instanceof A2APeerError) return cursor;
    cursor = cursor.cause;
  }
  return undefined;
}

function isTransient(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /Abort|Timeout/.test(error.name));
}

/**
 * The {@link A2APeerError} for `error`: one already raised by this client (including as a cause)
 * unchanged, a JSON-RPC error mapped by its A2A code, a network or abort failure as retryable
 * `unreachable`, and anything else as `protocol`.
 */
export function classifyPeerError(error: unknown): A2APeerError {
  const existing = findPeerError(error);
  if (existing !== undefined) return existing;
  const envelope = (error as { envelopeCode?: unknown } | null)?.envelopeCode;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof envelope === 'number' ? ENVELOPE_CODES.get(envelope) : undefined;
  if (code !== undefined) return new A2APeerError(code, message, { cause: error });
  if (isTransient(error)) {
    return new A2APeerError('unreachable', message, { cause: error, retryable: true });
  }
  return new A2APeerError('protocol', message, { cause: error });
}
