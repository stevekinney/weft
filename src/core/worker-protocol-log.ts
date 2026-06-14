/**
 * Pure structural validators for worker `log` protocol messages (#529). These have
 * NO dependency on the rest of `worker-protocol.ts` — they are leaf predicates so
 * `worker-protocol.ts` (which owns `WorkerProtocolError` and the strict asserters)
 * can import them without an import cycle. The strict, throwing path
 * (`assertWorkerLogOutbound` in `worker-protocol.ts`) wraps {@link isValidWorkerLogRecord},
 * and the host's lenient delivery path routes on {@link isWorkerLogMessage}, so both
 * paths share one definition of "valid worker log".
 *
 * @module core/worker-protocol-log
 */

import type { WorkerOutboundMessage } from './types.ts';

/**
 * Whether a worker `log` message's `record` field is a structurally valid
 * {@link import('./types/workflow-log.ts').WorkflowLogRecord} — the single source of
 * truth for "valid worker log payload", shared by the strict-protocol asserter (which
 * throws) and the host's lenient delivery path (which drops).
 */
export function isValidWorkerLogRecord(record: unknown): boolean {
  if (typeof record !== 'object' || record === null) return false;
  const candidate = record as Record<string, unknown>;
  if (typeof candidate['message'] !== 'string') return false;
  return (
    candidate['level'] === 'debug' ||
    candidate['level'] === 'info' ||
    candidate['level'] === 'warn' ||
    candidate['level'] === 'error'
  );
}

/**
 * Structural type-guard that routes a message into the host's LENIENT log lane: any
 * message whose `type` is `'log'`. It matches on `type` ALONE — payload validity is
 * decided later by {@link isValidWorkerLogRecord}, so a malformed log is DROPPED, not
 * sent to the strict accept-or-discard gate. A `log` is best-effort observability and
 * carries no turn-protocol state, so no malformed/oversize/out-of-turn log may ever
 * discard the worker. A non-`log` message returns `false` and flows on to the strict
 * gate unchanged.
 */
export function isWorkerLogMessage(
  message: unknown,
): message is Extract<WorkerOutboundMessage, { type: 'log' }> {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>)['type'] === 'log'
  );
}
