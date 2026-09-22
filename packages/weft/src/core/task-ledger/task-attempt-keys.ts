/**
 * Canonical storage keys for {@link TaskAttemptRecord} (COR-205).
 *
 * One durable record per successful claim, keyed by `(operationId,
 * attemptTokenDigest)` — see `task-attempt-types.ts`'s doc comment for why
 * the bare `attempt` number is not a safe key. Both components are
 * caller-influenced (`operationId` flows from `TaskDispatch.operationId`;
 * `attemptTokenDigest` is server-minted but still untrusted input to a key),
 * so both are encoded through {@link encodeStorageKeyComponent} exactly like
 * `taskLedgerKey` (`task-ledger-keys.ts`) encodes `operationId`.
 *
 * @module server/task-attempt-keys
 */

import { encodeStorageKeyComponent } from '../../storage/interface.ts';

const TASK_ATTEMPT_KEY_PREFIX = 'task-attempt:';

/**
 * The prefix under which every attempt record for one operation lives.
 * Bounded-scan/delete callers (purge, retention) use this directly — the
 * number of attempts per operation is bounded by the dispatch's retry
 * policy, so a prefix scan or `storageDeletePrefix` under this key is a
 * bounded operation (acceptance criterion 12), never a full-ledger scan.
 */
export function taskAttemptPrefix(operationId: string): string {
  return `${TASK_ATTEMPT_KEY_PREFIX}${encodeStorageKeyComponent(operationId)}:`;
}

/** The one durable key for a single attempt's provenance record. */
export function taskAttemptKey(operationId: string, attemptTokenDigest: string): string {
  return `${taskAttemptPrefix(operationId)}${encodeStorageKeyComponent(attemptTokenDigest)}`;
}
