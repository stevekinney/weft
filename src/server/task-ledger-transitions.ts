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
 * Only ten rows are covered — `Completing --> DeadLettered` (dead-letter
 * creation on exhausted result-persistence retries) appears in the state
 * diagram but not in the transition-contract table, and dead-letter content
 * is explicitly WFT-24 ("Adoption, retention, and diagnostics") scope.
 *
 * This module holds rows 1-6 (create through requeue). Rows 7-10
 * (cancellation and terminal adoption) live in
 * `task-ledger-transitions-cancellation.ts` and are re-exported below — the
 * split exists only to keep both files under this repository's file-size
 * ceiling.
 *
 * @module server/task-ledger-transitions
 */

import { calculateBackoff } from '../core/scheduler.ts';
import type { WorkerExecutionIdentity } from '../worker/manifest/types.ts';
import {
  pickAttemptFields,
  pickBase,
  pickLeaseHolderFields,
  type TaskLedgerTransitionResult,
} from './task-ledger-transition-helpers.ts';
import type {
  RemoteTaskBase,
  RemoteTaskCompleting,
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
  executionIdentity: WorkerExecutionIdentity;
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
    executionIdentity: input.executionIdentity,
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
  if (current.leaseDeadline > now) {
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
