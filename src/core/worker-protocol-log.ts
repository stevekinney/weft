/**
 * Pure structural validators for worker `log` protocol messages (#529). These have
 * NO dependency on the rest of `worker-protocol.ts` — they are leaf predicates so
 * `worker-protocol.ts` (which owns `WorkerProtocolError` and the strict asserters)
 * can import them without an import cycle. The strict, throwing path
 * (`assertWorkerLogOutbound` in `worker-protocol.ts`) wraps {@link isValidWorkerLogRecord},
 * and the host's lenient delivery path routes on {@link isWorkerLogMessage}, so both
 * paths share one definition of "valid worker log".
 *
 * The `log` lane is intentionally version-tolerant: a `log` carries no turn-protocol
 * state and is best-effort observability, so it bypasses the strict protocol-version
 * negotiation that gates state-changing messages. That is safe while only protocol v1
 * exists; a future incompatible protocol would still send `type: 'log'` and have its
 * record validated structurally here rather than rejected on version. This is the one
 * place that decision lives — see {@link isWorkerLogMessage}.
 *
 * @module core/worker-protocol-log
 */

import type { WorkflowLogLevel, WorkflowLogRecord } from './types/workflow-log.ts';

/** The set of valid {@link WorkflowLogLevel} literals, used to validate an untrusted record. */
const WORKFLOW_LOG_LEVELS = new Set<WorkflowLogLevel>(['debug', 'info', 'warn', 'error']);

/**
 * Whether `attributes` is absent or a PLAIN object, per the `WorkflowLogRecord` contract:
 * `Record<string, unknown>`. An untrusted worker can `postMessage` any structured-cloneable
 * value (arrays, `Date`, `Map`, class instances), so a bare `typeof === 'object'` would let
 * a non-plain object reach a host sink typed as a keyed bag. A plain object is one whose
 * prototype is `Object.prototype` or `null` (the literal `{}` / `Object.create(null)` cases);
 * everything else — arrays, `Date`, `Map`, custom classes — is rejected.
 */
function isValidLogAttributes(attributes: unknown): boolean {
  if (attributes === undefined) return true;
  if (typeof attributes !== 'object' || attributes === null) return false;
  const prototype = Object.getPrototypeOf(attributes);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A candidate `log` outbound message: every field is `unknown` because this lane
 * accepts the message by `type` ALONE and validates the payload separately. Narrowing
 * to this (rather than the final `Extract<WorkerOutboundMessage, { type: 'log' }>`)
 * keeps {@link isWorkerLogMessage} a SOUND predicate — it promises only what it
 * checks. The record is treated as a {@link WorkflowLogRecord} only after
 * {@link isValidWorkerLogRecord} succeeds.
 */
export interface WorkerLogMessageCandidate {
  readonly type: 'log';
  readonly protocolVersion?: unknown;
  readonly workflowId?: unknown;
  readonly record?: unknown;
}

/**
 * Whether `record` is a structurally complete {@link WorkflowLogRecord} — the single
 * source of truth for "valid worker log payload", shared by the strict-protocol
 * asserter (which throws) and the host's lenient delivery path (which drops). Because
 * the host sink is typed to receive a `WorkflowLogRecord`, this validates the FULL
 * envelope an untrusted worker must supply: `level` (allowed literal), `message`,
 * `workflowId`, `workflowType` (strings), `timestamp` (finite number), and — when
 * present — `attributes` (a plain object). A record missing any required field or
 * carrying a wrong-typed field is rejected so a malformed wire payload can never reach
 * a strongly typed host sink.
 */
export function isValidWorkerLogRecord(record: unknown): record is WorkflowLogRecord {
  if (typeof record !== 'object' || record === null) return false;
  const candidate = record as Record<string, unknown>;
  return (
    WORKFLOW_LOG_LEVELS.has(candidate['level'] as WorkflowLogLevel) &&
    typeof candidate['message'] === 'string' &&
    typeof candidate['workflowId'] === 'string' &&
    typeof candidate['workflowType'] === 'string' &&
    typeof candidate['timestamp'] === 'number' &&
    Number.isFinite(candidate['timestamp']) &&
    isValidLogAttributes(candidate['attributes'])
  );
}

/**
 * Structural type-guard that routes a message into the host's LENIENT log lane: any
 * message whose `type` is `'log'`. It matches on `type` ALONE and narrows only to
 * {@link WorkerLogMessageCandidate} (all payload fields `unknown`) — payload validity
 * is decided later by {@link isValidWorkerLogRecord}, so a malformed log is DROPPED,
 * not sent to the strict accept-or-discard gate. A `log` is best-effort observability
 * and carries no turn-protocol state, so no malformed/oversize/out-of-turn log may
 * ever discard the worker. A non-`log` message returns `false` and flows on to the
 * strict gate unchanged.
 */
export function isWorkerLogMessage(message: unknown): message is WorkerLogMessageCandidate {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>)['type'] === 'log'
  );
}
