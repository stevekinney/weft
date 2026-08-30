/**
 * Cancellation and terminal-adoption transitions for the durable remote task
 * ledger (WFT-25) — rows 7-10 of the project brief's "Conditional transition
 * contract" table. Split out of `task-ledger-transitions.ts` purely to keep
 * both files under this repository's file-size ceiling; re-exported from
 * `task-ledger-transitions.ts` so callers have one import surface. See that
 * module's doc comment for the shared design notes (pure, storage-agnostic,
 * `expectedValue` bytes are the caller's responsibility).
 *
 * @module server/task-ledger-transitions-cancellation
 */

import {
  pickAttemptFields,
  pickBase,
  pickLeaseHolderFields,
  type TaskLedgerPreconditionResult,
  type TaskLedgerTransitionResult,
} from './task-ledger-transition-helpers.ts';
import type {
  RemoteTaskCancelling,
  RemoteTaskRecord,
  RemoteTaskTerminal,
  RemoteTaskTerminalCancelled,
} from './task-ledger-types.ts';

// ---------------------------------------------------------------------------
// 7. Record cancellation intent — precondition: state queued or leased,
//    generation and current attempt match.
// ---------------------------------------------------------------------------

export type RecordCancellationIntentInput = Readonly<{
  expectedGeneration: number;
  expectedAttempt: number;
  cancellationReason: string;
}>;

export function recordCancellationIntent(
  current: RemoteTaskRecord | null,
  input: RecordCancellationIntentInput,
  now: number,
): TaskLedgerTransitionResult<RemoteTaskCancelling | RemoteTaskTerminalCancelled> {
  if (current === null || (current.state !== 'queued' && current.state !== 'leased')) {
    return { ok: false, reason: 'expected task state "queued" or "leased"' };
  }
  if (
    current.generation !== input.expectedGeneration ||
    current.attempt !== input.expectedAttempt
  ) {
    return { ok: false, reason: 'generation or attempt mismatch' };
  }

  if (current.state === 'queued') {
    // No attempt ever existed for a queued-origin cancellation — the state
    // diagram routes `Queued --> Cancelled` directly, bypassing `Cancelling`.
    const cancelledRecord: RemoteTaskTerminalCancelled = {
      ...pickBase(current),
      generation: current.generation + 1,
      state: 'terminal',
      disposition: 'cancelled',
      attempt: current.attempt,
      cancellationReason: input.cancellationReason,
      resultDigest: `cancelled:${current.operationId}:${String(current.generation)}`,
      terminalAt: now,
      adopted: false,
      retentionGeneration: 0,
    };
    return { ok: true, nextRecord: cancelledRecord };
  }

  const cancellingRecord: RemoteTaskCancelling = {
    ...pickBase(current),
    ...pickAttemptFields(current),
    ...pickLeaseHolderFields(current),
    generation: current.generation + 1,
    state: 'cancelling',
    cancellationReason: input.cancellationReason,
    cancellationRequestedAt: now,
  };
  return { ok: true, nextRecord: cancellingRecord };
}

// ---------------------------------------------------------------------------
// 8. Commit cancellation — precondition: state cancelling, attempt token matches.
//    (`Cancelling` always has an attempt — see `RemoteTaskCancelling`'s doc comment.)
// ---------------------------------------------------------------------------

export type CommitCancellationInput = Readonly<{ attemptToken: string }>;

export function commitCancellation(
  current: RemoteTaskRecord | null,
  input: CommitCancellationInput,
  now: number,
): TaskLedgerTransitionResult<RemoteTaskTerminalCancelled> {
  if (current === null || current.state !== 'cancelling') {
    return { ok: false, reason: 'expected task state "cancelling"' };
  }
  if (current.attemptToken !== input.attemptToken) {
    return { ok: false, reason: 'attempt token mismatch' };
  }
  const nextRecord: RemoteTaskTerminalCancelled = {
    ...pickBase(current),
    generation: current.generation + 1,
    state: 'terminal',
    disposition: 'cancelled',
    attempt: current.attempt,
    attemptToken: current.attemptToken,
    cancellationReason: current.cancellationReason,
    resultDigest: `cancelled:${current.operationId}:${current.attemptToken}`,
    terminalAt: now,
    adopted: false,
    retentionGeneration: 0,
  };
  return { ok: true, nextRecord };
}

// ---------------------------------------------------------------------------
// 9. Mark workflow result adopted — precondition: terminal state and expected
//    terminal digest match.
// ---------------------------------------------------------------------------

export type MarkWorkflowResultAdoptedInput = Readonly<{ expectedResultDigest: string }>;

export function markWorkflowResultAdopted(
  current: RemoteTaskRecord | null,
  input: MarkWorkflowResultAdoptedInput,
  now: number,
): TaskLedgerTransitionResult<RemoteTaskTerminal> {
  if (current === null || current.state !== 'terminal') {
    return { ok: false, reason: 'expected task state "terminal"' };
  }
  if (current.resultDigest !== input.expectedResultDigest) {
    return { ok: false, reason: 'result digest mismatch' };
  }
  const nextRecord: RemoteTaskTerminal = {
    ...current,
    generation: current.generation + 1,
    adopted: true,
    adoptedAt: now,
  };
  return { ok: true, nextRecord };
}

// ---------------------------------------------------------------------------
// 10. Delete retained terminal task — precondition: terminal state is adopted
//     and retention generation matches. Deletion has no next record, so this
//     is a precondition check only; the caller issues the delete.
// ---------------------------------------------------------------------------

export type DeleteRetainedTerminalTaskInput = Readonly<{ expectedRetentionGeneration: number }>;

export function canDeleteRetainedTerminalTask(
  current: RemoteTaskRecord | null,
  input: DeleteRetainedTerminalTaskInput,
): TaskLedgerPreconditionResult {
  if (current === null || current.state !== 'terminal') {
    return { ok: false, reason: 'expected task state "terminal"' };
  }
  if (!current.adopted) {
    return { ok: false, reason: 'terminal task is not yet adopted' };
  }
  if (current.retentionGeneration !== input.expectedRetentionGeneration) {
    return { ok: false, reason: 'retention generation mismatch' };
  }
  return { ok: true };
}
