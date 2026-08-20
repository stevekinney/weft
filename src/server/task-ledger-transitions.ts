/**
 * Pure conditional-transition precondition functions for the durable remote
 * task ledger (WFT-25) — one function per row of the project brief's
 * "Conditional transition contract" table.
 *
 * These functions are storage-agnostic by design: they take the currently
 * decoded {@link RemoteTaskRecord} (or `null` when no record exists) and
 * proposed inputs, and return either the next record to persist or a
 * rejection reason. They never read or write storage, and they never see raw
 * encoded bytes.
 *
 * That last point is deliberate. `storage.conditionalBatch`'s
 * `ConditionalBatchCondition.expectedValue` is whole-value byte equality —
 * `encode(decode(bytes))` is not guaranteed to reproduce the exact original
 * bytes. The caller that actually commits a transition (the "Queue and Claim
 * Coordinator" work, WFT-22) must keep the raw `Uint8Array` it read from
 * storage and pass those exact bytes as the CAS `expectedValue`, using the
 * `nextRecord` this module returns only for what to write, never for what to
 * compare against.
 *
 * Twelve rows are covered. This module holds rows 1-6 (create through
 * requeue) plus two WFT-24 additions at the end: `Completing --> DeadLettered`
 * (dead-letter creation on exhausted result-persistence retries) and "Clear
 * dead letter" (an operator discarding a dead-lettered diagnostic). Both
 * appear in the state diagram but not the original ten-row
 * transition-contract table — WFT-25 deliberately left them out as WFT-24
 * ("Adoption, retention, and diagnostics") scope; see `commitDeadLetter`'s
 * own doc comment for why they belong beside `commitTerminalResult` rather
 * than in the cancellation file. Rows 7-10 (cancellation and terminal
 * adoption) live in `task-ledger-transitions-cancellation.ts` and are
 * re-exported below — the split exists only to keep both files under this
 * repository's file-size ceiling.
 *
 * @module server/task-ledger-transitions
 */

import type { JSONValue } from '../core/json.ts';
import { calculateBackoff } from '../core/scheduler.ts';
import type { WorkerExecutionIdentity } from '../worker/manifest/types.ts';
import {
  pickAttemptFields,
  pickBase,
  pickLeaseHolderFields,
  type TaskLedgerPreconditionResult,
  type TaskLedgerTransitionResult,
} from './task-ledger-transition-helpers.ts';
import type {
  RemoteTaskBase,
  RemoteTaskCompleting,
  RemoteTaskDeadLettered,
  RemoteTaskLeased,
  RemoteTaskQueued,
  RemoteTaskRecord,
  RemoteTaskTerminal,
  RemoteTaskTerminalRetryExhausted,
} from './task-ledger-types.ts';

export type {
  TaskLedgerPreconditionResult,
  TaskLedgerTransitionResult,
} from './task-ledger-transition-helpers.ts';
export {
  canDeleteRetainedTerminalTask,
  commitCancellation,
  markWorkflowResultAdopted,
  recordCancellationIntent,
  type CommitCancellationInput,
  type DeleteRetainedTerminalTaskInput,
  type MarkWorkflowResultAdoptedInput,
  type RecordCancellationIntentInput,
} from './task-ledger-transitions-cancellation.ts';

// ---------------------------------------------------------------------------
// 1. Create queued — precondition: current task key absent.
// ---------------------------------------------------------------------------

export type CreateQueuedInput = Omit<RemoteTaskBase, 'generation'> &
  Readonly<{ availableAt?: number }>;

export function createQueued(
  current: RemoteTaskRecord | null,
  input: CreateQueuedInput,
  now: number,
): TaskLedgerTransitionResult<RemoteTaskQueued> {
  if (current !== null) {
    return {
      ok: false,
      reason: `operation "${input.operationId}" already has a task record in state "${current.state}"`,
    };
  }
  const nextRecord: RemoteTaskQueued = {
    ...pickBase({ ...input, generation: 0 }),
    state: 'queued',
    attempt: 1,
    availableAt: input.availableAt ?? now,
    firstQueuedAt: now,
    lastQueuedAt: now,
    retryCount: 0,
    requeueCount: 0,
  };
  return { ok: true, nextRecord };
}

// ---------------------------------------------------------------------------
// 2. Claim queued — precondition: state queued, generation matches, availableAt <= now.
// ---------------------------------------------------------------------------

export type ClaimQueuedInput = Readonly<{
  expectedGeneration: number;
  attemptToken: string;
  workerSessionId: string;
  /** Omitted when the claiming worker has no registered manifest entry for this workflowType/activityName — see `RemoteTaskLeased.executionIdentity`'s doc comment. */
  executionIdentity?: WorkerExecutionIdentity;
  leaseDurationMilliseconds: number;
}>;

export function claimQueued(
  current: RemoteTaskRecord | null,
  input: ClaimQueuedInput,
  now: number,
): TaskLedgerTransitionResult<RemoteTaskLeased> {
  if (current === null || current.state !== 'queued') {
    return { ok: false, reason: 'expected task state "queued"' };
  }
  if (current.generation !== input.expectedGeneration) {
    return { ok: false, reason: 'generation mismatch' };
  }
  if (current.availableAt > now) {
    return { ok: false, reason: 'task is not yet available' };
  }
  const nextRecord: RemoteTaskLeased = {
    ...pickBase(current),
    ...pickAttemptFields(current),
    generation: current.generation + 1,
    state: 'leased',
    attemptToken: input.attemptToken,
    workerSessionId: input.workerSessionId,
    ...(input.executionIdentity !== undefined
      ? { executionIdentity: input.executionIdentity }
      : {}),
    attempt: current.attempt,
    leaseDeadline: now + input.leaseDurationMilliseconds,
    firstQueuedAt: current.firstQueuedAt,
    lastQueuedAt: current.lastQueuedAt,
    startedAt: current.startedAt ?? now,
    lastHeartbeatAt: now,
  };
  return { ok: true, nextRecord };
}

// ---------------------------------------------------------------------------
// 3. Renew attempt lease — precondition: state leased, attempt token and worker session match.
// ---------------------------------------------------------------------------

export type RenewAttemptLeaseInput = Readonly<{
  attemptToken: string;
  workerSessionId: string;
  leaseDurationMilliseconds: number;
}>;

export function renewAttemptLease(
  current: RemoteTaskRecord | null,
  input: RenewAttemptLeaseInput,
  now: number,
): TaskLedgerTransitionResult<RemoteTaskLeased> {
  if (current === null || current.state !== 'leased') {
    return { ok: false, reason: 'expected task state "leased"' };
  }
  if (
    current.attemptToken !== input.attemptToken ||
    current.workerSessionId !== input.workerSessionId
  ) {
    return { ok: false, reason: 'attempt token or worker session mismatch' };
  }
  const nextRecord: RemoteTaskLeased = {
    ...current,
    generation: current.generation + 1,
    leaseDeadline: now + input.leaseDurationMilliseconds,
    lastHeartbeatAt: now,
  };
  return { ok: true, nextRecord };
}

// ---------------------------------------------------------------------------
// 4. Begin completion — precondition: state leased, attempt token matches.
// ---------------------------------------------------------------------------

export type BeginCompletionInput = Readonly<{
  attemptToken: string;
  pendingStatus: 'completed' | 'failed';
  pendingResultDigest: string;
}>;

export function beginCompletion(
  current: RemoteTaskRecord | null,
  input: BeginCompletionInput,
): TaskLedgerTransitionResult<RemoteTaskCompleting> {
  if (current === null || current.state !== 'leased') {
    return { ok: false, reason: 'expected task state "leased"' };
  }
  if (current.attemptToken !== input.attemptToken) {
    return { ok: false, reason: 'attempt token mismatch' };
  }
  const nextRecord: RemoteTaskCompleting = {
    ...pickBase(current),
    ...pickAttemptFields(current),
    ...pickLeaseHolderFields(current),
    generation: current.generation + 1,
    state: 'completing',
    pendingStatus: input.pendingStatus,
    pendingResultDigest: input.pendingResultDigest,
  };
  return { ok: true, nextRecord };
}

// ---------------------------------------------------------------------------
// 5. Commit terminal result — precondition: state completing, attempt token and result digest match.
// ---------------------------------------------------------------------------

export type CommitTerminalResultInput = Readonly<{
  attemptToken: string;
  resultDigest: string;
  error?: string;
}>;

export function commitTerminalResult(
  current: RemoteTaskRecord | null,
  input: CommitTerminalResultInput,
  now: number,
): TaskLedgerTransitionResult<RemoteTaskTerminal> {
  if (current === null || current.state !== 'completing') {
    return { ok: false, reason: 'expected task state "completing"' };
  }
  if (
    current.attemptToken !== input.attemptToken ||
    current.pendingResultDigest !== input.resultDigest
  ) {
    return { ok: false, reason: 'attempt token or result digest mismatch' };
  }
  const nextRecord: RemoteTaskTerminal = {
    ...pickBase(current),
    generation: current.generation + 1,
    state: 'terminal',
    disposition: 'resolved',
    attempt: current.attempt,
    attemptToken: current.attemptToken,
    status: current.pendingStatus,
    ...(input.error !== undefined ? { error: input.error } : {}),
    resultDigest: current.pendingResultDigest,
    terminalAt: now,
    adopted: false,
    retentionGeneration: 0,
  };
  return { ok: true, nextRecord };
}

// ---------------------------------------------------------------------------
// 6. Requeue expired attempt — precondition: state leased, attempt token matches,
//    lease deadline is not later than now.
// ---------------------------------------------------------------------------

export type RequeueExpiredAttemptInput = Readonly<{
  attemptToken: string;
  requeueReason: string;
  /**
   * Skip the lease-deadline precondition. Worker disconnect forfeits the
   * lease immediately rather than waiting for it to expire — the brief's
   * "Disconnect races heartbeat -> One attempt-token transition wins" licenses
   * a requeue here as long as the attempt token still matches, independent of
   * whether the deadline has actually passed. Visibility-timeout-origin
   * requeues never set this, since expiry genuinely requires the deadline
   * precondition.
   */
  skipDeadlineCheck?: boolean;
}>;

export function requeueExpiredAttempt(
  current: RemoteTaskRecord | null,
  input: RequeueExpiredAttemptInput,
  now: number,
): TaskLedgerTransitionResult<RemoteTaskQueued | RemoteTaskTerminalRetryExhausted> {
  if (current === null || current.state !== 'leased') {
    return { ok: false, reason: 'expected task state "leased"' };
  }
  if (current.attemptToken !== input.attemptToken) {
    return { ok: false, reason: 'attempt token mismatch' };
  }
  if (input.skipDeadlineCheck !== true && current.leaseDeadline > now) {
    return { ok: false, reason: 'lease has not expired' };
  }

  const nextAttempt = current.attempt + 1;
  const policy = current.retryPolicy;
  if (policy !== undefined && nextAttempt > policy.maxAttempts) {
    const exhaustedRecord: RemoteTaskTerminalRetryExhausted = {
      ...pickBase(current),
      generation: current.generation + 1,
      state: 'terminal',
      disposition: 'retryExhausted',
      attempt: current.attempt,
      attemptToken: current.attemptToken,
      error: `Activity "${current.activityName}" exhausted all ${String(policy.maxAttempts)} retry attempts`,
      resultDigest: `retry-exhausted:${current.operationId}:${current.attemptToken}`,
      terminalAt: now,
      adopted: false,
      retentionGeneration: 0,
    };
    return { ok: true, nextRecord: exhaustedRecord };
  }

  // calculateBackoff is 1-indexed against the attempt it delays *into* minus
  // one — matching reassignOrExpireTask's `calculateBackoff((nextAttempt) - 1,
  // policy)` in task-reconciliation.ts and the inline retry path's
  // `calculateBackoff(attempt - 1, retryPolicy)` in run-operation.ts.
  const availableAt = policy === undefined ? now : now + calculateBackoff(nextAttempt - 1, policy);
  const queuedRecord: RemoteTaskQueued = {
    ...pickBase(current),
    generation: current.generation + 1,
    state: 'queued',
    attempt: nextAttempt,
    availableAt,
    firstQueuedAt: current.firstQueuedAt,
    lastQueuedAt: now,
    lastDispatchedAt: current.lastQueuedAt,
    startedAt: current.startedAt,
    retryCount: Math.max(current.retryCount, nextAttempt - 1),
    requeueCount: current.requeueCount + 1,
    lastRequeueReason: input.requeueReason,
  };
  return { ok: true, nextRecord: queuedRecord };
}

// ---------------------------------------------------------------------------
// 11. Commit dead letter — precondition: state completing, attempt token and
//     pending result digest match. (WFT-24.)
// ---------------------------------------------------------------------------

/**
 * Terminal-adjacent, not terminal: a `deadLettered` record is not a
 * `RemoteTaskTerminal` disposition. `commitTaskLedgerCompletion`
 * (`server/runtime/task-ledger-completion.ts`) reaches this only after
 * `beginCompletion` already landed the record durably in `completing` (or
 * found it already there) and the *second* write — `commitTerminalResult` —
 * exhausted its own CAS retry budget. That is a genuine, sustained storage
 * write failure on this operation specifically, not a benign lost race
 * against a legitimate concurrent writer: `commitTerminalResult`'s own
 * precondition (state `completing`, matching attempt token and result
 * digest) already guards against clobbering a result some other writer
 * legitimately resolved out from under this one, so a caller reaching this
 * transition has already confirmed, moments earlier, that nothing else
 * should have been able to land instead.
 *
 * Preconditions mirror `commitTerminalResult`'s exactly (state, attempt
 * token, result digest) rather than trusting the caller's exhausted-retry
 * report at face value — a fresh read here could observe that some other
 * writer *did* land a terminal result in the interim (e.g. the worker's own
 * retried submission, resumed through `commitTaskLedgerCompletion`'s
 * `resuming` branch, racing ahead of the exhausted attempt), in which case
 * this correctly rejects rather than dead-lettering an already-resolved
 * task.
 */
export type CommitDeadLetterInput = Readonly<{
  attemptToken: string;
  resultDigest: string;
  value?: JSONValue;
  error?: string;
  persistenceFailureReason: string;
}>;

export function commitDeadLetter(
  current: RemoteTaskRecord | null,
  input: CommitDeadLetterInput,
  now: number,
): TaskLedgerTransitionResult<RemoteTaskDeadLettered> {
  if (current === null || current.state !== 'completing') {
    return { ok: false, reason: 'expected task state "completing"' };
  }
  if (
    current.attemptToken !== input.attemptToken ||
    current.pendingResultDigest !== input.resultDigest
  ) {
    return { ok: false, reason: 'attempt token or result digest mismatch' };
  }
  const nextRecord: RemoteTaskDeadLettered = {
    ...pickBase(current),
    ...pickAttemptFields(current),
    generation: current.generation + 1,
    state: 'deadLettered',
    attemptToken: current.attemptToken,
    attempt: current.attempt,
    pendingStatus: current.pendingStatus,
    pendingResultDigest: current.pendingResultDigest,
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    deadLetteredAt: now,
    persistenceFailureReason: input.persistenceFailureReason,
  };
  return { ok: true, nextRecord };
}

// ---------------------------------------------------------------------------
// 12. Clear dead letter — precondition: state deadLettered. (WFT-24.)
// ---------------------------------------------------------------------------

/**
 * Precondition for `weft.tasks.diagnostics.deadletters.clear`
 * (`server/operations/get-task-diagnostics.ts`): an operator has seen the
 * dead-lettered diagnostic and is discarding it, freeing the operationId
 * for reuse (a later `createQueued` for the same operationId is otherwise
 * rejected — its own precondition requires the current key be absent).
 * Precondition-only, like `canDeleteRetainedTerminalTask` — the caller
 * issues the delete.
 */
export function canClearDeadLetteredTask(
  current: RemoteTaskRecord | null,
): TaskLedgerPreconditionResult {
  if (current === null || current.state !== 'deadLettered') {
    return { ok: false, reason: 'expected task state "deadLettered"' };
  }
  return { ok: true };
}
