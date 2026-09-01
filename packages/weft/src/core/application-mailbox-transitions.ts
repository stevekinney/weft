/**
 * Pure conditional-transition functions for the durable application command
 * mailbox (WFT-84) — one function per legal edge of the mailbox state machine.
 *
 * These functions are storage-agnostic. They take the currently decoded
 * {@link ApplicationCommandRecord} and proposed inputs and return either the
 * next record to persist or a stable rejection reason. They never read or write
 * storage and never see encoded bytes.
 *
 * That last point matters for correctness, not just tidiness.
 * `storage.conditionalBatch` compares whole values byte-for-byte, and
 * `encode(decode(bytes))` is not guaranteed to reproduce the original bytes. The
 * caller that commits a transition must keep the raw `Uint8Array` it read and
 * pass those exact bytes as the compare-and-swap `expectedValue`, using
 * `next` only for what to write.
 *
 * The legal edges are:
 *
 * ```text
 * (none)  --admit-->                accepted | available
 * accepted --release(now>=due)-->   available
 * accepted --claim(now>=due)-->     claimed
 * available --claim-->              claimed
 * claimed --acknowledge-->          applied
 * claimed --reject(final)-->        rejected
 * claimed --reject(retry)-->        accepted        (backoff, attempts remain)
 * claimed --reject(retry)-->        dead-lettered   (attempts exhausted)
 * claimed --expire-->               accepted | dead-lettered
 * claimed --cancel-->               cancellation-requested
 * cancellation-requested --settle--> cancelled
 * cancellation-requested --expire--> cancelled      (cleanupPending)
 * accepted | available --cancel-->  cancelled
 * any non-terminal --deadline-->    dead-lettered
 * ```
 *
 * @module core/application-mailbox-transitions
 */

import {
  applicationCommandIdentityFields,
  computeRetryBackoffMs,
  nonTerminalCommandRecord,
  rejectedTransition,
  succeededTransition,
  type ApplicationMailboxTransition,
  type ApplicationMailboxTransitionRejection,
} from './application-mailbox-transition-helpers.ts';
import type {
  ApplicationCommandAccepted,
  ApplicationCommandAvailable,
  ApplicationCommandCancelling,
  ApplicationCommandClaimed,
  ApplicationCommandFailure,
  ApplicationCommandLeasedRecord,
  ApplicationCommandRecord,
  ApplicationCommandTerminalRecord,
  ApplicationCommandWaitingRecord,
} from './application-mailbox-types.ts';
import {
  APPLICATION_MAILBOX_RECORD_VERSION,
  isApplicationCommandTerminalState,
} from './application-mailbox-types.ts';
import type { ValidatedCommandInput } from './application-mailbox-validation.ts';
import type { JSONValue } from './json.ts';

export {
  computeRetryBackoffMs,
  isTerminalCommandRecord,
  nonTerminalCommandRecord,
} from './application-mailbox-transition-helpers.ts';
export type {
  ApplicationMailboxTransition,
  ApplicationMailboxTransitionRejection,
} from './application-mailbox-transition-helpers.ts';

/**
 * Build the record for a freshly admitted command.
 *
 * A command with no delay is admitted straight to `available`; one with a delay
 * is admitted `accepted` and released later. Both are durable receipts.
 */
export function createAdmittedCommandRecord(
  input: ValidatedCommandInput,
  context: {
    readonly namespace: string;
    readonly resourceId: string;
    readonly commandId: string;
    readonly sequence: number;
    readonly now: number;
  },
): ApplicationCommandAccepted | ApplicationCommandAvailable {
  const availableAt = context.now + input.availableAfterMs;
  const base = {
    recordVersion: APPLICATION_MAILBOX_RECORD_VERSION,
    namespace: context.namespace,
    resourceId: context.resourceId,
    commandId: context.commandId,
    sequence: context.sequence,
    idempotencyKey: input.idempotencyKey,
    caller: input.caller,
    target: input.target,
    kind: input.kind,
    payload: input.payload,
    payloadDigest: input.payloadDigest,
    payloadMediaType: input.payloadMediaType,
    payloadSchema: input.payloadSchema,
    causation: input.causation,
    acceptedAt: context.now,
    availableAt,
    absoluteDeadlineAt: context.now + input.commandTimeoutMs,
    maxAttempts: input.maxAttempts,
    visibilityTimeoutMs: input.visibilityTimeoutMs,
    generation: 0,
    attempt: 0,
    retryCount: 0,
  } as const;
  return availableAt <= context.now
    ? { ...base, state: 'available' }
    : { ...base, state: 'accepted' };
}

/**
 * Release a delayed command for delivery once its `availableAt` has passed.
 */
export function releaseWaitingCommand(
  record: ApplicationCommandRecord,
  now: number,
): ApplicationMailboxTransition<ApplicationCommandAvailable> {
  const live = nonTerminalCommandRecord(record);
  if (live === null) return rejectedTransition('already-terminal');
  if (live.state !== 'accepted') return rejectedTransition('not-waiting');
  if (now < live.availableAt) return rejectedTransition('not-due');
  return succeededTransition({ ...applicationCommandIdentityFields(live), state: 'available' });
}

/**
 * Lease a waiting command to one attempt.
 *
 * The lease never outlives the absolute command deadline: `visibilityExpiresAt`
 * is clamped to it, so an attempt cannot hold work past the ceiling admission
 * set.
 */
export function claimWaitingCommand(
  record: ApplicationCommandRecord,
  options: { readonly now: number; readonly attemptToken: string },
): ApplicationMailboxTransition<ApplicationCommandClaimed> {
  const live = nonTerminalCommandRecord(record);
  if (live === null) return rejectedTransition('already-terminal');
  if (live.state !== 'accepted' && live.state !== 'available')
    return rejectedTransition('not-waiting');
  if (options.now < live.availableAt) return rejectedTransition('not-due');
  // The absolute deadline outranks availability. Leasing a command past it would
  // hand a consumer work it is no longer allowed to apply, and the consumer
  // would only discover that when it tried to settle — after the side effect.
  if (options.now >= live.absoluteDeadlineAt) return rejectedTransition('deadline-exceeded');
  return succeededTransition({
    ...applicationCommandIdentityFields(live),
    state: 'claimed',
    attempt: live.attempt + 1,
    firstClaimedAt: live.firstClaimedAt ?? options.now,
    attemptToken: options.attemptToken,
    claimedAt: options.now,
    visibilityExpiresAt: Math.min(options.now + live.visibilityTimeoutMs, live.absoluteDeadlineAt),
    lastActivityAt: options.now,
  });
}

/**
 * Narrow a record to the lease held by one specific attempt, or say why it is
 * not that. Returning the narrowed record (rather than a boolean) is what lets
 * every settle transition below stay cast-free.
 */
function checkCurrentAttempt(
  record: ApplicationCommandRecord,
  attemptToken: string,
  now: number,
):
  | { readonly ok: true; readonly leased: ApplicationCommandLeasedRecord }
  | { readonly ok: false; readonly reason: ApplicationMailboxTransitionRejection } {
  if (isApplicationCommandTerminalState(record.state)) {
    return { ok: false, reason: 'already-terminal' };
  }
  if (record.state !== 'claimed' && record.state !== 'cancellation-requested') {
    return { ok: false, reason: 'not-leased' };
  }
  if (record.attemptToken !== attemptToken) return { ok: false, reason: 'stale-attempt' };
  // The absolute deadline outranks the lease. Past it the command is dead even
  // though the record still says `claimed`, so no settlement from this attempt
  // may write a result — maintenance dead-letters it instead. Reported
  // separately from `stale-attempt` because the caller needs to know the
  // command is over, not that someone else took it.
  if (now >= record.absoluteDeadlineAt) return { ok: false, reason: 'deadline-exceeded' };
  return { ok: true, leased: record };
}

/**
 * Extend a lease and record liveness for the current attempt.
 *
 * Renewal is attempt-fenced and clamped: it can never move
 * `absoluteDeadlineAt`, so an indefinitely renewing claimant still hits the
 * command ceiling. `lastActivityAt` is transport liveness and stays separate
 * from `progress`, which is caller-supplied semantic progress and is never used
 * for fencing.
 */
export function renewCommandLease(
  record: ApplicationCommandRecord,
  options: {
    readonly attemptToken: string;
    readonly now: number;
    readonly progress?: JSONValue | undefined;
  },
): ApplicationMailboxTransition<ApplicationCommandLeasedRecord> {
  const checked = checkCurrentAttempt(record, options.attemptToken, options.now);
  if (!checked.ok) return rejectedTransition(checked.reason);
  const { leased } = checked;
  const renewed = {
    ...leased,
    generation: leased.generation + 1,
    lastActivityAt: options.now,
    visibilityExpiresAt: Math.min(
      options.now + leased.visibilityTimeoutMs,
      leased.absoluteDeadlineAt,
    ),
    progress: options.progress ?? leased.progress,
  };
  return succeededTransition(renewed);
}

/**
 * Settle a claimed command successfully.
 *
 * A command whose cancellation was already requested settles as `cancelled`
 * rather than `applied`: the claimant finished cleanup, so cleanup is settled,
 * but the durable cancellation request is not overwritten by a success.
 *
 * The caller's `outcome` is still retained on that `cancelled` receipt. A
 * claimant that completed the work before it observed the cancellation really
 * did produce a result, and discarding it would lose evidence a reader may need
 * to decide whether the effect already happened.
 */
export function acknowledgeCommand(
  record: ApplicationCommandRecord,
  options: {
    readonly attemptToken: string;
    readonly now: number;
    readonly outcome?: JSONValue | undefined;
  },
): ApplicationMailboxTransition<ApplicationCommandTerminalRecord> {
  const checked = checkCurrentAttempt(record, options.attemptToken, options.now);
  if (!checked.ok) return rejectedTransition(checked.reason);
  const { leased } = checked;
  const cancelling = leased.state === 'cancellation-requested';
  return succeededTransition({
    ...applicationCommandIdentityFields(leased),
    state: cancelling ? 'cancelled' : 'applied',
    terminalAt: options.now,
    outcome: options.outcome,
    failure: cancelling ? { reason: 'cancelled' } : undefined,
    cancellationRequestedAt: cancelling ? leased.cancellationRequestedAt : undefined,
    cancellationReason: cancelling ? leased.cancellationReason : undefined,
    cleanupPending: cancelling ? false : undefined,
  });
}

/**
 * Settle a claimed command as failed, optionally scheduling a retry.
 *
 * A retry that still has attempts left returns the command to `accepted` at its
 * original FIFO position with a backoff; one that does not is dead-lettered
 * with `attempts-exhausted`. A cancellation-requested command always settles as
 * `cancelled` — a failed cleanup is still cleanup.
 */
export function rejectCommand(
  record: ApplicationCommandRecord,
  options: {
    readonly attemptToken: string;
    readonly now: number;
    readonly retry: boolean;
    readonly failure: ApplicationCommandFailure;
    readonly retryBackoffMs: number;
    readonly maxRetryBackoffMs: number;
  },
): ApplicationMailboxTransition<ApplicationCommandAccepted | ApplicationCommandTerminalRecord> {
  const checked = checkCurrentAttempt(record, options.attemptToken, options.now);
  if (!checked.ok) return rejectedTransition(checked.reason);
  const { leased } = checked;
  if (leased.state === 'cancellation-requested') {
    return succeededTransition({
      ...applicationCommandIdentityFields(leased),
      state: 'cancelled',
      terminalAt: options.now,
      failure: { reason: 'cancelled' },
      cancellationRequestedAt: leased.cancellationRequestedAt,
      cancellationReason: leased.cancellationReason,
      cleanupPending: false,
    });
  }
  if (!options.retry) {
    return succeededTransition({
      ...applicationCommandIdentityFields(leased),
      state: 'rejected',
      terminalAt: options.now,
      failure: options.failure,
    });
  }
  if (leased.attempt >= leased.maxAttempts) {
    return succeededTransition({
      ...applicationCommandIdentityFields(leased),
      state: 'dead-lettered',
      terminalAt: options.now,
      failure: { ...options.failure, reason: 'attempts-exhausted' },
    });
  }
  return succeededTransition({
    ...applicationCommandIdentityFields(leased),
    state: 'accepted',
    retryCount: leased.retryCount + 1,
    availableAt:
      options.now +
      computeRetryBackoffMs(leased.attempt, options.retryBackoffMs, options.maxRetryBackoffMs),
  });
}

/**
 * Record a durable cancellation request.
 *
 * An unclaimed command cancels immediately with nothing to clean up. A claimed
 * one keeps its lease and moves to `cancellation-requested`, so only the
 * current attempt can settle it. Requesting cancellation twice is idempotent:
 * the second request rejects with `not-leased` against a record already in
 * `cancellation-requested`, which the caller reports as the same outcome.
 */
export function requestCommandCancellation(
  record: ApplicationCommandRecord,
  options: { readonly now: number; readonly reason?: string | undefined },
): ApplicationMailboxTransition<ApplicationCommandCancelling | ApplicationCommandTerminalRecord> {
  const live = nonTerminalCommandRecord(record);
  if (live === null) return rejectedTransition('already-terminal');
  if (live.state === 'cancellation-requested') return rejectedTransition('not-leased');
  if (live.state === 'claimed') {
    return succeededTransition({
      ...live,
      generation: live.generation + 1,
      state: 'cancellation-requested',
      cancellationRequestedAt: options.now,
      cancellationReason: options.reason,
    });
  }
  return succeededTransition({
    ...applicationCommandIdentityFields(live),
    state: 'cancelled',
    terminalAt: options.now,
    failure: { reason: 'cancelled' },
    cancellationRequestedAt: options.now,
    cancellationReason: options.reason,
    cleanupPending: false,
  });
}

/**
 * Whether a waiting or leased record is past its absolute command deadline and
 * must be terminalized before anything else can happen to it.
 */
export function isCommandPastDeadline(record: ApplicationCommandRecord, now: number): boolean {
  return !isApplicationCommandTerminalState(record.state) && now >= record.absoluteDeadlineAt;
}

/** Narrowing helper for callers that already proved a record is waiting. */
export function asWaitingRecord(
  record: ApplicationCommandRecord,
): ApplicationCommandWaitingRecord | null {
  return record.state === 'accepted' || record.state === 'available' ? record : null;
}
