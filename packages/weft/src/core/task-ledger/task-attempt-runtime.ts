/**
 * Provenance write-builders for {@link TaskAttemptRecord} (COR-205),
 * shared by every ledger transition call site that creates or updates one:
 * claim (WebSocket and long-poll), requeue/retry-exhaustion, cancellation
 * (cooperative and forced), completion, dead-letter, and heartbeat renewal.
 *
 * Every function here returns `BatchOperation[]` ready to splice into
 * `commitTaskLedgerTransition`'s `buildAdditionalWrites` callback, so the
 * attempt-record write always lands in the SAME `conditionalBatch` call as
 * the owning ledger transition (acceptance criterion 11). None of these
 * touch a raw `attemptToken` — every caller passes (or this module derives)
 * a digest before a record is ever built (criteria 8 and 10).
 *
 * @module server/runtime/task-attempt-runtime
 */

import type { BatchOperation, Storage } from '../../storage/interface.ts';
import { sha256HexSync } from '../../worker/manifest/content-digest.ts';
import type { WorkerExecutionIdentity } from '../../worker/manifest/types.ts';
import {
  decodeTaskAttemptRecord,
  encodeTaskAttemptRecord,
  taskAttemptKey,
  type TaskAttemptDisposition,
  type TaskAttemptRecord,
} from './task-attempt.ts';
import type { RemoteTaskRecord, WorkerExecutionRequirementInput } from './task-ledger.ts';

/**
 * `sha256HexSync(attemptToken)` — the one place every call site derives an
 * attempt's digest. Deliberately the SYNCHRONOUS digest (`node:crypto`'s
 * `createHash`), not the async `sha256Hex` (WebCrypto's `subtle.digest`):
 * several callers of the write-builders below run inside a fire-and-forget
 * commit path (a WebSocket heartbeat, a worker-disconnect requeue) that a
 * caller — production code returning immediately from a message handler, or
 * a test flushing a bounded number of microtasks — never actually awaits to
 * completion. `subtle.digest` resolves through a real async completion, not
 * a plain microtask chain, and will not resolve within either of those
 * without a genuine `await`; the synchronous digest has no such gap. See
 * `sha256HexSync`'s own doc comment for the full rationale.
 */
export function digestAttemptToken(attemptToken: string): string {
  return sha256HexSync(attemptToken);
}

export type ClaimAttemptRecordInput = Readonly<{
  operationId: string;
  attempt: number;
  attemptTokenDigest: string;
  workerSessionId: string;
  sessionGeneration?: number;
  executionIdentity?: WorkerExecutionIdentity;
  executionRequirement?: WorkerExecutionRequirementInput;
  claimedAt: number;
}>;

/**
 * Build the fresh `TaskAttemptRecord` write for a successful claim
 * (acceptance criterion 1) — a brand-new `(operationId, attemptTokenDigest)`
 * slot, never a merge, since a claim always mints a fresh `attemptToken` and
 * therefore a fresh digest (`task-dispatch.ts`'s and `task-polling.ts`'s
 * doc comments on `attemptToken` minting).
 */
export function buildClaimAttemptRecordWrite(input: ClaimAttemptRecordInput): BatchOperation {
  const record: TaskAttemptRecord = {
    recordVersion: 1,
    operationId: input.operationId,
    attempt: input.attempt,
    attemptTokenDigest: input.attemptTokenDigest,
    workerSessionId: input.workerSessionId,
    ...(input.sessionGeneration !== undefined
      ? { sessionGeneration: input.sessionGeneration }
      : {}),
    ...(input.executionIdentity !== undefined
      ? { executionIdentity: input.executionIdentity }
      : {}),
    ...(input.executionRequirement !== undefined
      ? { executionRequirement: input.executionRequirement }
      : {}),
    claimedAt: input.claimedAt,
    disposition: 'leased',
    dispositionAt: input.claimedAt,
  };
  return {
    type: 'put',
    key: taskAttemptKey(input.operationId, input.attemptTokenDigest),
    value: encodeTaskAttemptRecord(record),
  };
}

export type AttemptDispositionUpdate = Readonly<{
  disposition?: TaskAttemptDisposition;
  dispositionAt?: number;
  dispositionReason?: string;
  lastHeartbeatAt?: number;
}>;

/**
 * Merge `update` onto the existing attempt record for `(operationId,
 * attemptTokenDigest)` and return its replacement write, or `undefined` when
 * no such record exists — never fabricated, since a missing attempt record
 * means either this attempt predates COR-205 or (acceptance criterion 2) its
 * claim never durably landed in the first place. Any field `update` omits is
 * carried over unchanged, so a heartbeat-only update (`{ lastHeartbeatAt }`)
 * never disturbs `disposition`/`dispositionAt`/`dispositionReason`.
 */
async function buildAttemptDispositionWrite(
  storage: Pick<Storage, 'get'>,
  operationId: string,
  attemptTokenDigest: string,
  update: AttemptDispositionUpdate,
): Promise<BatchOperation | undefined> {
  const key = taskAttemptKey(operationId, attemptTokenDigest);
  const existing = decodeTaskAttemptRecord(await storage.get(key));
  if (existing === null) return undefined;

  const nextRecord: TaskAttemptRecord = {
    ...existing,
    disposition: update.disposition ?? existing.disposition,
    dispositionAt: update.dispositionAt ?? existing.dispositionAt,
    ...((update.dispositionReason ?? existing.dispositionReason) !== undefined
      ? { dispositionReason: update.dispositionReason ?? existing.dispositionReason }
      : {}),
    ...((update.lastHeartbeatAt ?? existing.lastHeartbeatAt) !== undefined
      ? { lastHeartbeatAt: update.lastHeartbeatAt ?? existing.lastHeartbeatAt }
      : {}),
  };
  return { type: 'put', key, value: encodeTaskAttemptRecord(nextRecord) };
}

/**
 * The current ledger record's lease-holder identity, when it has one —
 * `leased`, `completing`, and `cancelling` are the only states carrying an
 * `attemptToken` an attempt-record update could target. Shared narrowing for
 * every `buildAdditionalWrites` callback in this module.
 */
function attemptTokenOfCurrentHolder(current: RemoteTaskRecord | null): string | undefined {
  if (current === null) return undefined;
  if (
    current.state === 'leased' ||
    current.state === 'completing' ||
    current.state === 'cancelling'
  ) {
    return current.attemptToken;
  }
  return undefined;
}

/**
 * Build the disposition-update write for the ATTEMPT `current` (the
 * pre-transition ledger record) was holding, or `[]` when `current` was not
 * mid-attempt (a queued-origin cancellation, for instance, never had an
 * attempt to update — acceptance criterion 2's "no attempt ever existed"
 * case). Intended as a `commitTaskLedgerTransition` `buildAdditionalWrites`
 * callback for requeue, cancellation, completion, and dead-letter — every
 * transition that resolves or supersedes a specific attempt.
 */
export async function buildCurrentAttemptDispositionWrites(
  storage: Pick<Storage, 'get'>,
  current: RemoteTaskRecord | null,
  update: AttemptDispositionUpdate,
): Promise<BatchOperation[]> {
  const attemptToken = attemptTokenOfCurrentHolder(current);
  if (attemptToken === undefined || current === null) return [];
  const digest = digestAttemptToken(attemptToken);
  const write = await buildAttemptDispositionWrite(storage, current.operationId, digest, update);
  return write === undefined ? [] : [write];
}

/**
 * Same as {@link buildCurrentAttemptDispositionWrites}, but targeting an
 * EXPLICIT `attemptToken` rather than deriving it from `current` — needed by
 * `reassignOrExpireTask` (`task-reconciliation.ts`), whose `record` argument
 * (the expired/forfeited `RemoteTaskLeased`) is a separate value from
 * whatever `commitTaskLedgerTransition` re-reads as `current` on retry.
 * Both name the same attempt in the cases that matter (the transition's own
 * `attemptToken` precondition rejects any mismatch before this would even
 * run), but this avoids relying on that indirection to recover the token.
 */
export async function buildAttemptDispositionWriteForToken(
  storage: Pick<Storage, 'get'>,
  operationId: string,
  attemptToken: string,
  update: AttemptDispositionUpdate,
): Promise<BatchOperation[]> {
  const digest = digestAttemptToken(attemptToken);
  const write = await buildAttemptDispositionWrite(storage, operationId, digest, update);
  return write === undefined ? [] : [write];
}
