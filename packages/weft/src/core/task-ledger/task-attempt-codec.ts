/**
 * Type guard and encode/decode for {@link TaskAttemptRecord} (COR-205).
 *
 * Mirrors `task-ledger-codec.ts`'s hostile-persisted-record posture exactly —
 * every field is proven from `unknown` before this record is trusted, reusing
 * the exact same bound predicates (`isBoundedIdentifier`, `isFiniteNumber`,
 * `isValidExecutionIdentity`, `isValidExecutionRequirement`, …) rather than a
 * second, independently drifting copy. A byte-corrupt or hand-edited record
 * that fails validation decodes to `null`, exactly like a malformed
 * `RemoteTaskRecord` — never partially trusted, never thrown past the caller.
 *
 * @module server/task-attempt-codec
 */

import { decode, encode } from '../codec.ts';
import type { TaskAttemptDisposition, TaskAttemptRecord } from './task-attempt-types.ts';
import {
  isBoundedIdentifier,
  isBoundedReason,
  isFiniteNumber,
  isOptionalFiniteNumber,
  isRecord,
  isValidExecutionIdentity,
  isValidExecutionRequirement,
} from './task-ledger-codec.ts';
import { MAX_TASK_IDENTIFIER_BYTES } from './task-ledger-limits.ts';

const TASK_ATTEMPT_DISPOSITIONS = [
  'leased',
  'requeued',
  'retryExhausted',
  'resolved',
  'cancelled',
  'deadLettered',
] as const satisfies readonly TaskAttemptDisposition[];

function isTaskAttemptDisposition(value: unknown): value is TaskAttemptDisposition {
  return (
    typeof value === 'string' && (TASK_ATTEMPT_DISPOSITIONS as readonly string[]).includes(value)
  );
}

/**
 * A `sha256Hex()` digest is always `sha256:` plus 64 lowercase hex
 * characters (71 bytes total) — comfortably inside
 * {@link MAX_TASK_IDENTIFIER_BYTES}, so the shared bounded-identifier check
 * is enough; no separate, narrower bound is needed.
 */
function isValidAttemptTokenDigest(value: unknown): value is string {
  return isBoundedIdentifier(value, MAX_TASK_IDENTIFIER_BYTES);
}

/** Discriminate and validate a decoded value as a {@link TaskAttemptRecord}. */
export function isTaskAttemptRecord(value: unknown): value is TaskAttemptRecord {
  if (!isRecord(value)) return false;
  return (
    value['recordVersion'] === 1 &&
    isBoundedIdentifier(value['operationId']) &&
    isFiniteNumber(value['attempt']) &&
    isValidAttemptTokenDigest(value['attemptTokenDigest']) &&
    isBoundedIdentifier(value['workerSessionId']) &&
    isOptionalFiniteNumber(value['sessionGeneration']) &&
    (value['executionIdentity'] === undefined ||
      isValidExecutionIdentity(value['executionIdentity'])) &&
    isValidExecutionRequirement(value['executionRequirement']) &&
    isFiniteNumber(value['claimedAt']) &&
    isTaskAttemptDisposition(value['disposition']) &&
    isFiniteNumber(value['dispositionAt']) &&
    (value['dispositionReason'] === undefined || isBoundedReason(value['dispositionReason'])) &&
    isOptionalFiniteNumber(value['lastHeartbeatAt'])
  );
}

/** Canonical encoding for a validated {@link TaskAttemptRecord}. */
export function encodeTaskAttemptRecord(record: TaskAttemptRecord): Uint8Array {
  return encode(record);
}

/**
 * Decode and validate a task-attempt record. Returns `null` when the bytes
 * are absent or decode to a value that fails bounds validation — the same
 * "malformed stored identity" contract `decodeRemoteTaskRecord` documents.
 */
export function decodeTaskAttemptRecord(bytes: Uint8Array | null): TaskAttemptRecord | null {
  if (bytes === null) return null;
  const decoded: unknown = decode(bytes);
  return isTaskAttemptRecord(decoded) ? decoded : null;
}
