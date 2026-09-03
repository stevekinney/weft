/**
 * The time-driven recovery transitions for the application command mailbox
 * (WFT-84): reclaiming an expired lease and terminalizing a command past its
 * absolute deadline.
 *
 * Split out of `application-mailbox-transitions.ts` only to keep both files
 * under this repository's file-size ceiling; `recoverExpiredCommand` is
 * re-exported from there so callers still have one import.
 *
 * @module core/application-mailbox-transitions-recovery
 */

import {
  applicationCommandIdentityFields,
  computeRetryBackoffMs,
  nonTerminalCommandRecord,
  rejectedTransition,
  succeededTransition,
  type ApplicationMailboxTransition,
} from './application-mailbox-transition-helpers.ts';
import type {
  ApplicationCommandAccepted,
  ApplicationCommandAvailable,
  ApplicationCommandCancelling,
  ApplicationCommandClaimed,
  ApplicationCommandRecord,
  ApplicationCommandTerminalRecord,
} from './application-mailbox-types.ts';
import { requireDerivedInstant } from './application-mailbox-validation.ts';

/**
 * Recover a command whose lease expired or whose absolute deadline passed.
 *
 * A claimed command returns to `accepted` at its original FIFO position while
 * attempts remain, and is dead-lettered once they are gone. A
 * cancellation-requested command becomes `cancelled` with `cleanupPending:
 * true` — the mailbox stopped waiting for the claimant, which is not the same
 * as the claimant having stopped. Any non-terminal command past its absolute
 * deadline is dead-lettered regardless of remaining attempts.
 */
export function recoverExpiredCommand(
  record: ApplicationCommandRecord,
  options: {
    readonly now: number;
    readonly retryBackoffMs: number;
    readonly maxRetryBackoffMs: number;
  },
): ApplicationMailboxTransition<ApplicationCommandAccepted | ApplicationCommandTerminalRecord> {
  const live = nonTerminalCommandRecord(record);
  if (live === null) return rejectedTransition('already-terminal');
  if (options.now >= live.absoluteDeadlineAt) {
    return succeededTransition(deadlineExceededRecord(live, options.now));
  }
  if (live.state === 'accepted' || live.state === 'available')
    return rejectedTransition('not-leased');
  if (options.now < live.visibilityExpiresAt) return rejectedTransition('not-due');
  if (live.state === 'cancellation-requested') {
    return succeededTransition({
      ...applicationCommandIdentityFields(live),
      state: 'cancelled',
      terminalAt: options.now,
      failure: { reason: 'cancelled' },
      cancellationRequestedAt: live.cancellationRequestedAt,
      cancellationReason: live.cancellationReason,
      cleanupPending: true,
      abandonedAttemptToken: live.attemptToken,
    });
  }
  if (live.attempt >= live.maxAttempts) {
    return succeededTransition({
      ...applicationCommandIdentityFields(live),
      state: 'dead-lettered',
      terminalAt: options.now,
      failure: { reason: 'attempts-exhausted' },
      // The lease expired, which is not evidence the claimant stopped: it may
      // still be executing. Record that cleanup is outstanding, as the deadline
      // and cancellation-expiry paths do, so `cleanupState()` does not report
      // `settled` for work that may still be running.
      cleanupPending: true,
      abandonedAttemptToken: live.attemptToken,
    });
  }
  return succeededTransition({
    ...applicationCommandIdentityFields(live),
    state: 'accepted',
    retryCount: live.retryCount + 1,
    availableAt: requireDerivedInstant(
      options.now +
        computeRetryBackoffMs(live.attempt, options.retryBackoffMs, options.maxRetryBackoffMs),
      'availableAt',
    ),
  });
}

/**
 * Terminalize any non-terminal record whose absolute command deadline passed.
 *
 * A record that still held a lease records `cleanupPending: true` and the
 * abandoned attempt token: the mailbox stopped waiting for that claimant, which
 * is not a claim that the claimant stopped.
 */
function deadlineExceededRecord(
  record:
    | ApplicationCommandAccepted
    | ApplicationCommandAvailable
    | ApplicationCommandClaimed
    | ApplicationCommandCancelling,
  now: number,
): ApplicationCommandTerminalRecord {
  const terminal = {
    ...applicationCommandIdentityFields(record),
    state: 'dead-lettered',
    terminalAt: now,
    failure: { reason: 'deadline-exceeded' },
  } as const;
  if (record.state === 'cancellation-requested') {
    return {
      ...terminal,
      cancellationRequestedAt: record.cancellationRequestedAt,
      cancellationReason: record.cancellationReason,
      cleanupPending: true,
      abandonedAttemptToken: record.attemptToken,
    };
  }
  if (record.state === 'claimed') {
    return { ...terminal, cleanupPending: true, abandonedAttemptToken: record.attemptToken };
  }
  return terminal;
}
