/**
 * Durable transport-level delivery history for a remote task's results
 * (COR-1366).
 *
 * The durable ledger (`task-ledger-types.ts`) and its per-attempt provenance
 * (`task-attempt-types.ts`) record what the LEDGER decided — `resolved`,
 * `deadLettered`, `requeued`, and so on. Neither records what each
 * individual `taskResult` SUBMISSION was answered with on the wire: the
 * `taskResultAck` disposition (`applied`/`duplicate`/`dead-lettered`,
 * `worker/protocol-messages.ts`) or a hard rejection (the WebSocket
 * transport's correlated `protocolError`, or long-poll's `403`). Those
 * answers were decided in `server/runtime/task-result-application.ts` and its
 * two transport callers, sent once, and forgotten. This record retains them
 * so `weft.tasks.deliveries` can answer the question retrospectively.
 *
 * **One record per operation, bounded.** Keyed by `operationId` alone under
 * {@link taskResultDeliveryKey}, holding at most
 * {@link TASK_RESULT_DELIVERY_HISTORY_LIMIT} entries, oldest first. When a new
 * entry would exceed the limit, the oldest entry is dropped and
 * `droppedCount` increments, so a reader can tell a complete history from a
 * truncated one. A single bounded record (rather than one key per delivery)
 * keeps each append to one compare-and-swap write and keeps retention purge
 * to one extra key per operation.
 *
 * **Never the raw attempt token.** Exactly like `TaskAttemptRecord`, an entry
 * identifies the submitted attempt by `attemptTokenDigest`
 * (`sha256Hex(attemptToken)`), which a reader correlates against
 * `weft.tasks.get`'s `attempts[].attemptTokenDigest`. A rejected submission's
 * `reason` is redacted of the raw token before it is written (see
 * `server/runtime/task-result-delivery-recorder.ts`).
 *
 * **Never the payload.** No `value`, no `error` body, no headers — this is
 * delivery metadata. A dead-lettered attempt's retained value is served only
 * by `weft.tasks.deadletters.get`, under its own, stricter access model.
 *
 * @module core/task-ledger/task-result-delivery
 */

import { encodeStorageKeyComponent } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import {
  isBoundedIdentifier,
  isBoundedReason,
  isFiniteNumber,
  isRecord,
} from './task-ledger-codec.ts';
import { MAX_TASK_REASON_BYTES, utf8ByteLength } from './task-ledger-limits.ts';

const TASK_RESULT_DELIVERY_KEY_PREFIX = 'task-result-delivery:';

/** Most entries one operation's delivery history retains; older entries are dropped first. */
export const TASK_RESULT_DELIVERY_HISTORY_LIMIT = 32;

export const TASK_RESULT_DELIVERY_RECORD_VERSION = 1;

/** The durable key for one operation's delivery history. */
export function taskResultDeliveryKey(operationId: string): string {
  return `${TASK_RESULT_DELIVERY_KEY_PREFIX}${encodeStorageKeyComponent(operationId)}`;
}

/** Which worker transport carried the submission. */
export type TaskResultDeliveryTransport = 'webSocket' | 'longPoll';

/** The `taskResultAck` disposition a submission was acknowledged with. Mirrors `TaskResultAckMessage.disposition`. */
export type TaskResultDeliveryDisposition = 'applied' | 'duplicate' | 'dead-lettered';

/**
 * Why a submission was hard-rejected. The first four mirror the shared
 * attempt gate (`TaskResultAuthorizationFailure`, minus `'unknown-operation'`,
 * which is never recorded — there is no ledger record to attach it to);
 * `'queue-mismatch'` and `'revision-mismatch'` are transport preconditions;
 * `'conflicting-content'` is the ledger's one named commit rejection; and
 * `'commit-rejected'` is every other `commitTaskLedgerCompletion` rejection
 * (a lost compare-and-swap, or the record having moved on to another
 * attempt by the time the commit ran).
 */
export type TaskResultDeliveryRejectionCode =
  | 'stale-attempt'
  | 'worker-mismatch'
  | 'attempt-token-mismatch'
  | 'queue-mismatch'
  | 'revision-mismatch'
  | 'conflicting-content'
  | 'commit-rejected';

export const TASK_RESULT_DELIVERY_REJECTION_CODES = [
  'stale-attempt',
  'worker-mismatch',
  'attempt-token-mismatch',
  'queue-mismatch',
  'revision-mismatch',
  'conflicting-content',
  'commit-rejected',
] as const satisfies readonly TaskResultDeliveryRejectionCode[];

const TASK_RESULT_DELIVERY_DISPOSITIONS = [
  'applied',
  'duplicate',
  'dead-lettered',
] as const satisfies readonly TaskResultDeliveryDisposition[];

const TASK_RESULT_DELIVERY_TRANSPORTS = [
  'webSocket',
  'longPoll',
] as const satisfies readonly TaskResultDeliveryTransport[];

const SUBMITTED_STATUSES = ['completed', 'failed', 'cancelled'] as const;

type TaskResultDeliveryCommon = Readonly<{
  /** `sha256Hex(attemptToken)` of the token the submission carried. Never the raw token. */
  attemptTokenDigest: string;
  transport: TaskResultDeliveryTransport;
  /** The submitting worker's id, when the transport knew one. */
  workerId?: string;
  /** The `status` the worker submitted. */
  submittedStatus: (typeof SUBMITTED_STATUSES)[number];
  /** Server clock when the answer was decided. */
  receivedAt: number;
}>;

/** A submission answered with a `taskResultAck`. */
export type TaskResultDeliveryAcknowledged = TaskResultDeliveryCommon &
  Readonly<{
    outcome: 'acknowledged';
    disposition: TaskResultDeliveryDisposition;
    /**
     * `true` when the submitted payload exceeded the server's payload limit,
     * so the server committed a synthesized failure in its place (and, on
     * WebSocket, also sent an uncorrelated `protocolError`). Absent otherwise.
     */
    oversizedPayload?: true;
  }>;

/** A submission answered with a hard rejection (`protocolError` / `403`). */
export type TaskResultDeliveryRejected = TaskResultDeliveryCommon &
  Readonly<{
    outcome: 'rejected';
    rejectionCode: TaskResultDeliveryRejectionCode;
    /**
     * Why the submission was rejected, with the raw attempt token redacted.
     * Bounded to `MAX_TASK_REASON_BYTES`. On WebSocket this is the
     * `protocolError` text the worker received. On long-poll it is composed by
     * the server: the `403` body carries only the bare `reason` code, so the
     * worker never sees this text.
     */
    reason: string;
  }>;

export type TaskResultDeliveryEntry = TaskResultDeliveryAcknowledged | TaskResultDeliveryRejected;

export type TaskResultDeliveryHistory = Readonly<{
  recordVersion: 1;
  operationId: string;
  /** Oldest first, at most {@link TASK_RESULT_DELIVERY_HISTORY_LIMIT}. */
  entries: readonly TaskResultDeliveryEntry[];
  /** How many older entries were dropped to stay within the limit. */
  droppedCount: number;
}>;

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isDeliveryCommon(value: Record<string, unknown>): boolean {
  return (
    isBoundedIdentifier(value['attemptTokenDigest']) &&
    includes(TASK_RESULT_DELIVERY_TRANSPORTS, value['transport']) &&
    (value['workerId'] === undefined || isBoundedIdentifier(value['workerId'])) &&
    includes(SUBMITTED_STATUSES, value['submittedStatus']) &&
    isFiniteNumber(value['receivedAt'])
  );
}

/** Validate one decoded entry from `unknown`, the same hostile-record posture as `task-attempt-codec.ts`. */
export function isTaskResultDeliveryEntry(value: unknown): value is TaskResultDeliveryEntry {
  if (!isRecord(value) || !isDeliveryCommon(value)) return false;
  if (value['outcome'] === 'acknowledged') {
    return (
      includes(TASK_RESULT_DELIVERY_DISPOSITIONS, value['disposition']) &&
      (value['oversizedPayload'] === undefined || value['oversizedPayload'] === true)
    );
  }
  return (
    value['outcome'] === 'rejected' &&
    includes(TASK_RESULT_DELIVERY_REJECTION_CODES, value['rejectionCode']) &&
    isBoundedReason(value['reason'])
  );
}

/** Validate a decoded value as a {@link TaskResultDeliveryHistory}. */
export function isTaskResultDeliveryHistory(value: unknown): value is TaskResultDeliveryHistory {
  if (!isRecord(value)) return false;
  const entries = value['entries'];
  return (
    value['recordVersion'] === TASK_RESULT_DELIVERY_RECORD_VERSION &&
    isBoundedIdentifier(value['operationId']) &&
    Array.isArray(entries) &&
    entries.length <= TASK_RESULT_DELIVERY_HISTORY_LIMIT &&
    entries.every(isTaskResultDeliveryEntry) &&
    isFiniteNumber(value['droppedCount']) &&
    value['droppedCount'] >= 0
  );
}

export function encodeTaskResultDeliveryHistory(history: TaskResultDeliveryHistory): Uint8Array {
  return encode(history);
}

/** Decode and validate; `null` for absent bytes or a record that fails validation. */
export function decodeTaskResultDeliveryHistory(
  bytes: Uint8Array | null,
): TaskResultDeliveryHistory | null {
  if (bytes === null) return null;
  const decoded: unknown = decode(bytes);
  return isTaskResultDeliveryHistory(decoded) ? decoded : null;
}

/**
 * Append `entry` to `history` (or start a new history), dropping the oldest
 * entries beyond {@link TASK_RESULT_DELIVERY_HISTORY_LIMIT}. Pure.
 */
export function appendTaskResultDelivery(
  history: TaskResultDeliveryHistory | null,
  operationId: string,
  entry: TaskResultDeliveryEntry,
): TaskResultDeliveryHistory {
  const combined = [...(history?.entries ?? []), entry];
  const overflow = Math.max(0, combined.length - TASK_RESULT_DELIVERY_HISTORY_LIMIT);
  return {
    recordVersion: TASK_RESULT_DELIVERY_RECORD_VERSION,
    operationId,
    entries: combined.slice(overflow),
    droppedCount: (history?.droppedCount ?? 0) + overflow,
  };
}

/**
 * Bound free text to `MAX_TASK_REASON_BYTES` of UTF-8 without splitting a
 * code point, so a recorded reason always passes {@link isBoundedReason}.
 * An empty input becomes a fixed placeholder for the same reason.
 */
export function boundTaskResultDeliveryReason(reason: string): string {
  if (reason.length === 0) return 'rejected';
  if (utf8ByteLength(reason) <= MAX_TASK_REASON_BYTES) return reason;
  let bounded = '';
  let bytes = 0;
  for (const character of reason) {
    const size = utf8ByteLength(character);
    if (bytes + size > MAX_TASK_REASON_BYTES) break;
    bounded += character;
    bytes += size;
  }
  return bounded;
}
