/**
 * Error raised when a worker advertises an incompatible RemoteWorker protocol
 * version during handshake.
 *
 * Phase 4 of the workflow-builder refactor bumped the wire protocol from v1 to
 * v2: each entry in `RegisterMessage.activities` is now a qualified
 * `${workflowType}.${activityName}` name rather than a bare activity name. A
 * worker built against the old SDK has no way to produce the qualified names
 * the server expects, so the server rejects the handshake before any task is
 * dispatched — the failure points at the protocol mismatch, not at a missing
 * activity later in replay.
 *
 * @module worker/worker-protocol-incompatible-error
 */

import { WeftError } from '../core/weft-error.ts';

/**
 * Build the canonical user-facing message for a protocol-version mismatch.
 *
 * Extracted so the server-side handshake path and the error class itself agree
 * on the exact wording — tests pin on this string.
 *
 * @example
 * ```ts
 * import { workerProtocolIncompatibleMessage } from '@lostgradient/weft';
 *
 * const message = workerProtocolIncompatibleMessage({ expected: 2, received: 1 });
 * ```
 */
export function workerProtocolIncompatibleMessage(versions: {
  expected: number;
  received: number | undefined;
}): string {
  const receivedDisplay = versions.received === undefined ? 'unknown' : String(versions.received);
  return `This server requires Weft worker protocol v${String(versions.expected)}; got v${receivedDisplay}. Upgrade the worker SDK to use qualified activity names (workflowType.activityName).`;
}

/**
 * Thrown / surfaced when a connecting worker advertises a `protocolVersion`
 * that this server cannot accept. Carries the expected and received versions
 * so operators can distinguish "no worker registered" from "old worker SDK".
 *
 * @example
 * ```ts
 * import { WorkerProtocolIncompatibleError } from '@lostgradient/weft';
 *
 * throw new WorkerProtocolIncompatibleError({ expected: 2, received: 1 });
 * ```
 */
export class WorkerProtocolIncompatibleError extends WeftError<'WorkerProtocolIncompatibleError'> {
  readonly expectedProtocolVersion: number;
  readonly receivedProtocolVersion: number | undefined;

  constructor(versions: { expected: number; received: number | undefined }) {
    super('WorkerProtocolIncompatibleError', workerProtocolIncompatibleMessage(versions));
    this.expectedProtocolVersion = versions.expected;
    this.receivedProtocolVersion = versions.received;
  }
}
