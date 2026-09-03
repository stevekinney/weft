/**
 * The time-driven recovery transition for the application delivery outbox
 * (WFT-85): what happens to a lease nobody renewed.
 *
 * The state the lease expired in decides everything. A `claimed` lease never
 * called the transport, so the delivery is safe to reschedule (or dead-letter
 * when its attempt budget is spent). An `attempting` or cancellation-requested
 * lease may have sent, so its outcome is unknown and the delivery's own
 * unknown-outcome policy decides — never a blind retry.
 *
 * @module core/application-outbox-transitions-recovery
 */

import {
  nonTerminalDeliveryRecord,
  rejectedTransition,
  rescheduleOrDeadLetter,
  succeededTransition,
  type ApplicationOutboxTransition,
  type RetryPolicy,
} from './application-outbox-transition-helpers.ts';
import { applyUnknownOutcomePolicy } from './application-outbox-transitions.ts';
import type {
  ApplicationDeliveryRecord,
  ApplicationDeliveryRetryScheduled,
  ApplicationDeliveryTerminalRecord,
} from './application-outbox-types.ts';

/**
 * Whether a leased record's lease has lapsed: its visibility expired or its
 * attempt deadline passed, whichever came first.
 */
export function isDeliveryLeaseExpired(record: ApplicationDeliveryRecord, now: number): boolean {
  if (
    record.state !== 'claimed' &&
    record.state !== 'attempting' &&
    record.state !== 'cancellation-requested'
  ) {
    return false;
  }
  return now >= record.visibilityExpiresAt || now >= record.attemptDeadlineAt;
}

/**
 * Recover a delivery whose lease lapsed.
 *
 * `cleanupPending: true` and `abandonedAttemptToken` are written whenever the
 * lease is abandoned rather than settled by its holder, in every disposition:
 * the outbox stopped waiting for that attempt, which is not a claim that the
 * attempt stopped.
 */
export function recoverExpiredDelivery(
  record: ApplicationDeliveryRecord,
  options: { readonly now: number } & RetryPolicy,
): ApplicationOutboxTransition<
  ApplicationDeliveryRetryScheduled | ApplicationDeliveryTerminalRecord
> {
  const live = nonTerminalDeliveryRecord(record);
  if (live === null) return rejectedTransition('already-terminal');
  if (live.state === 'queued' || live.state === 'retry-scheduled') {
    return rejectedTransition('not-leased');
  }
  if (!isDeliveryLeaseExpired(live, options.now)) return rejectedTransition('not-due');
  if (live.state === 'claimed') {
    const next = rescheduleOrDeadLetter(live, {
      ...options,
      failure: { reason: 'retryable', message: 'The attempt lease expired before the send began.' },
    });
    if (next.state === 'retry-scheduled') return succeededTransition(next);
    return succeededTransition({
      ...next,
      cleanupPending: true,
      abandonedAttemptToken: live.attemptToken,
    });
  }
  return succeededTransition(
    applyUnknownOutcomePolicy(live, {
      ...options,
      failure: {
        reason: 'unknown-outcome',
        message: 'The attempt lease expired after the send began; the transport result is unknown.',
      },
      abandonedAttemptToken: live.attemptToken,
    }),
  );
}
