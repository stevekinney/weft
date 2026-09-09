/**
 * Pure conditional-transition functions for the durable application delivery
 * outbox (WFT-85) — one function per legal edge of the outbox state machine.
 *
 * These functions are storage-agnostic. They take the currently decoded
 * {@link ApplicationDeliveryRecord} and proposed inputs and return either the
 * next record to persist or a stable rejection reason. They never read or write
 * storage and never see encoded bytes; the caller that commits a transition
 * keeps the raw bytes it read as the compare-and-swap `expectedValue`.
 *
 * The legal edges are:
 *
 * ```text
 * (none)  --enqueue-->                       queued
 * queued | retry-scheduled --claim(due)-->   claimed
 * claimed --begin-->                         attempting
 * claimed | attempting | cancel-req --heartbeat--> (same state, visibility extended)
 * attempting --settle(acknowledged)-->       acknowledged
 * attempting --settle(rejected)-->           rejected
 * attempting --settle(retryable)-->          retry-scheduled | dead-lettered
 * attempting --settle(unknown)-->            unknown-outcome | dead-lettered | retry-scheduled
 * cancellation-requested --settle(ack)-->    acknowledged      (the effect happened)
 * cancellation-requested --settle(other)-->  cancelled | unknown-outcome | dead-lettered
 * queued | retry-scheduled | claimed --cancel--> cancelled
 * attempting --cancel-->                     cancellation-requested
 * claimed --expire-->                        retry-scheduled | dead-lettered   (recovery)
 * attempting | cancel-req --expire-->        unknown-outcome | dead-lettered | retry-scheduled
 * unknown-outcome | dead-lettered | rejected --retry--> queued          (operator)
 * unknown-outcome --deadLetter-->            dead-lettered                     (operator)
 * ```
 *
 * @module core/application-outbox-transitions
 */

import { requireDerivedInstant } from './application-outbox-guards.ts';
import {
  applicationDeliveryIdentityFields,
  nonTerminalDeliveryRecord,
  rejectedTransition,
  rescheduleOrDeadLetter,
  succeededTransition,
  type ApplicationOutboxTransition,
  type ApplicationOutboxTransitionRejection,
  type RetryPolicy,
} from './application-outbox-transition-helpers.ts';
import type {
  ApplicationDeliveryAttempting,
  ApplicationDeliveryCancelling,
  ApplicationDeliveryClaimed,
  ApplicationDeliveryLeasedRecord,
  ApplicationDeliveryQueued,
  ApplicationDeliveryRecord,
  ApplicationDeliveryRetryScheduled,
  ApplicationDeliveryTerminalRecord,
} from './application-outbox-types.ts';
import {
  APPLICATION_OUTBOX_RECORD_VERSION,
  isApplicationDeliveryLeased,
  isApplicationDeliveryTerminalState,
} from './application-outbox-types.ts';
import type { ValidatedDeliveryInput, ValidatedOutcome } from './application-outbox-validation.ts';
import type { JSONValue } from './json.ts';

export {
  isTerminalDeliveryRecord,
  nonTerminalDeliveryRecord,
} from './application-outbox-transition-helpers.ts';
export type {
  ApplicationOutboxTransition,
  ApplicationOutboxTransitionRejection,
} from './application-outbox-transition-helpers.ts';

/** Build the record for a freshly enqueued delivery. */
export function createEnqueuedDeliveryRecord(
  input: ValidatedDeliveryInput,
  context: {
    readonly namespace: string;
    readonly ownerId: string;
    readonly deliveryId: string;
    readonly sequence: number;
    readonly now: number;
  },
): ApplicationDeliveryQueued {
  return {
    recordVersion: APPLICATION_OUTBOX_RECORD_VERSION,
    namespace: context.namespace,
    ownerId: context.ownerId,
    deliveryId: context.deliveryId,
    sequence: context.sequence,
    idempotencyKey: input.idempotencyKey,
    destinationRef: input.destinationRef,
    credentialRef: input.credentialRef,
    kind: input.kind,
    payload: input.payload,
    payloadDigest: input.payloadDigest,
    payloadMediaType: input.payloadMediaType,
    payloadSchema: input.payloadSchema,
    causation: input.causation,
    externalIdempotencyKey: input.externalIdempotencyKey,
    unknownOutcomePolicy: input.unknownOutcomePolicy,
    enqueuedAt: context.now,
    availableAt: requireDerivedInstant(context.now + input.availableAfterMs, 'availableAt'),
    maxAttempts: input.maxAttempts,
    visibilityTimeoutMs: input.visibilityTimeoutMs,
    attemptTimeoutMs: input.attemptTimeoutMs,
    generation: 0,
    attempt: 0,
    retryCount: 0,
    state: 'queued',
  };
}

/**
 * Lease a waiting delivery to one attempt.
 *
 * The attempt deadline is fixed here, at `now + attemptTimeoutMs`, and nothing
 * later moves it. Visibility starts at the lesser of the renewal window and
 * that deadline.
 */
export function claimWaitingDelivery(
  record: ApplicationDeliveryRecord,
  options: { readonly now: number; readonly attemptToken: string },
): ApplicationOutboxTransition<ApplicationDeliveryClaimed> {
  const live = nonTerminalDeliveryRecord(record);
  if (live === null) return rejectedTransition('already-terminal');
  if (live.state !== 'queued' && live.state !== 'retry-scheduled') {
    return rejectedTransition('not-waiting');
  }
  if (options.now < live.availableAt) return rejectedTransition('not-due');
  const attemptDeadlineAt = requireDerivedInstant(
    options.now + live.attemptTimeoutMs,
    'attemptDeadlineAt',
  );
  return succeededTransition({
    ...applicationDeliveryIdentityFields(live),
    state: 'claimed',
    attempt: live.attempt + 1,
    firstClaimedAt: live.firstClaimedAt ?? options.now,
    attemptToken: options.attemptToken,
    claimedAt: options.now,
    attemptDeadlineAt,
    visibilityExpiresAt: Math.min(options.now + live.visibilityTimeoutMs, attemptDeadlineAt),
    lastActivityAt: options.now,
  });
}

/**
 * Narrow a record to the lease held by one specific attempt, or say why it is
 * not that. The attempt deadline outranks the lease: past it no settlement
 * from this attempt may write a result, and recovery decides the disposition.
 */
function checkCurrentAttempt(
  record: ApplicationDeliveryRecord,
  attemptToken: string,
  now: number,
):
  | { readonly ok: true; readonly leased: ApplicationDeliveryLeasedRecord }
  | { readonly ok: false; readonly reason: ApplicationOutboxTransitionRejection } {
  if (isApplicationDeliveryTerminalState(record.state)) {
    return { ok: false, reason: 'already-terminal' };
  }
  if (!isApplicationDeliveryLeased(record)) return { ok: false, reason: 'not-leased' };
  if (record.attemptToken !== attemptToken) return { ok: false, reason: 'stale-attempt' };
  if (now >= record.attemptDeadlineAt) return { ok: false, reason: 'deadline-exceeded' };
  return { ok: true, leased: record };
}

/**
 * Durably mark that the current attempt is about to call the transport.
 *
 * This is the edge that makes recovery honest: a lease that expires in
 * `claimed` provably sent nothing and is safe to retry, while one that expires
 * in `attempting` may have, and follows the unknown-outcome policy.
 */
export function beginDeliveryAttempt(
  record: ApplicationDeliveryRecord,
  options: { readonly attemptToken: string; readonly now: number },
): ApplicationOutboxTransition<ApplicationDeliveryAttempting> {
  const checked = checkCurrentAttempt(record, options.attemptToken, options.now);
  if (!checked.ok) return rejectedTransition(checked.reason);
  const { leased } = checked;
  // A repeated begin on a record already attempting is idempotent; one after
  // cancellation was requested is refused, so a claimant in another process
  // that retries its begin cannot take the answer as leave to send.
  if (leased.state === 'cancellation-requested') {
    return rejectedTransition('cancellation-requested');
  }
  if (leased.state !== 'claimed') return rejectedTransition('not-applicable');
  return succeededTransition({
    ...leased,
    generation: leased.generation + 1,
    state: 'attempting',
    attemptStartedAt: options.now,
    lastActivityAt: options.now,
    visibilityExpiresAt: Math.min(
      options.now + leased.visibilityTimeoutMs,
      leased.attemptDeadlineAt,
    ),
  });
}

/**
 * Record liveness for the current attempt and extend its visibility, clamped
 * to the fixed attempt deadline. `transportActivity` is evidence of transport
 * progress — bytes written, a request id — and is never fencing.
 */
export function heartbeatDeliveryAttempt(
  record: ApplicationDeliveryRecord,
  options: {
    readonly attemptToken: string;
    readonly now: number;
    readonly transportActivity?: JSONValue | undefined;
  },
): ApplicationOutboxTransition<ApplicationDeliveryLeasedRecord> {
  const checked = checkCurrentAttempt(record, options.attemptToken, options.now);
  if (!checked.ok) return rejectedTransition(checked.reason);
  const { leased } = checked;
  return succeededTransition({
    ...leased,
    generation: leased.generation + 1,
    lastActivityAt: options.now,
    visibilityExpiresAt: Math.min(
      options.now + leased.visibilityTimeoutMs,
      leased.attemptDeadlineAt,
    ),
    transportActivity:
      options.transportActivity === undefined
        ? leased.transportActivity
        : options.transportActivity,
  });
}

/** The cancellation fields a settlement carries forward from a cancelling record. */
function cancellationFields(leased: ApplicationDeliveryLeasedRecord) {
  return leased.state === 'cancellation-requested'
    ? {
        cancellationRequestedAt: leased.cancellationRequestedAt,
        cancellationReason: leased.cancellationReason,
      }
    : {};
}

/**
 * Apply the unknown-outcome policy to a leased delivery whose transport result
 * is lost. Shared by settlement (adapter reported `unknown`) and recovery (the
 * lease expired in `attempting`).
 *
 * A delivery whose cancellation was requested is never retried: `park` and
 * `retry-with-idempotency` both park it, because a retry would send work the
 * caller asked to stop. `abandonedAttemptToken` is set by recovery only.
 */
export function applyUnknownOutcomePolicy(
  leased: ApplicationDeliveryLeasedRecord,
  options: {
    readonly now: number;
    readonly failure: { readonly reason: 'unknown-outcome'; readonly message?: string | undefined };
    readonly abandonedAttemptToken?: string | undefined;
  } & RetryPolicy,
): ApplicationDeliveryRetryScheduled | ApplicationDeliveryTerminalRecord {
  const cancelling = leased.state === 'cancellation-requested';
  const abandoned =
    options.abandonedAttemptToken === undefined
      ? {}
      : { cleanupPending: true, abandonedAttemptToken: options.abandonedAttemptToken };
  if (leased.unknownOutcomePolicy === 'dead-letter') {
    return {
      ...applicationDeliveryIdentityFields(leased),
      state: 'dead-lettered',
      terminalAt: options.now,
      failure: options.failure,
      ...cancellationFields(leased),
      ...abandoned,
    };
  }
  if (leased.unknownOutcomePolicy === 'retry-with-idempotency' && !cancelling) {
    const next = rescheduleOrDeadLetter(leased, { ...options, failure: options.failure });
    return next.state === 'dead-lettered' ? { ...next, ...abandoned } : next;
  }
  return {
    ...applicationDeliveryIdentityFields(leased),
    state: 'unknown-outcome',
    terminalAt: options.now,
    failure: options.failure,
    ...cancellationFields(leased),
    ...abandoned,
  };
}

/**
 * Settle the current attempt on what the transport reported.
 *
 * Only an `attempting` (or cancellation-requested) delivery can settle: a
 * `claimed` one never called the transport, so it has no outcome to record.
 * An acknowledgement always wins, even after cancellation was requested — the
 * effect happened and the receipt must say so. Any other outcome on a
 * cancelling delivery honours the cancellation: `cancelled` when nothing was
 * confirmed, the unknown-outcome policy when the result was lost.
 */
export function settleDeliveryAttempt(
  record: ApplicationDeliveryRecord,
  options: {
    readonly attemptToken: string;
    readonly now: number;
    readonly outcome: ValidatedOutcome;
  } & RetryPolicy,
): ApplicationOutboxTransition<
  ApplicationDeliveryRetryScheduled | ApplicationDeliveryTerminalRecord
> {
  const checked = checkCurrentAttempt(record, options.attemptToken, options.now);
  if (!checked.ok) return rejectedTransition(checked.reason);
  const { leased } = checked;
  if (leased.state === 'claimed') return rejectedTransition('not-attempting');
  const { outcome } = options;
  if (outcome.status === 'acknowledged') {
    return succeededTransition({
      ...applicationDeliveryIdentityFields(leased),
      state: 'acknowledged',
      terminalAt: options.now,
      evidence: outcome.evidence,
      ...cancellationFields(leased),
    });
  }
  if (outcome.status === 'unknown') {
    return succeededTransition(
      applyUnknownOutcomePolicy(leased, {
        now: options.now,
        retryBackoffMs: options.retryBackoffMs,
        maxRetryBackoffMs: options.maxRetryBackoffMs,
        failure: { reason: 'unknown-outcome', message: outcome.failure.message },
      }),
    );
  }
  if (leased.state === 'cancellation-requested') {
    return succeededTransition({
      ...applicationDeliveryIdentityFields(leased),
      state: 'cancelled',
      terminalAt: options.now,
      failure: { reason: 'cancelled' },
      ...cancellationFields(leased),
      cleanupPending: false,
    });
  }
  if (outcome.status === 'rejected') {
    return succeededTransition({
      ...applicationDeliveryIdentityFields(leased),
      state: 'rejected',
      terminalAt: options.now,
      failure: outcome.failure,
    });
  }
  return succeededTransition(
    rescheduleOrDeadLetter(leased, {
      ...options,
      failure: outcome.failure,
      retryAfterMs: outcome.retryAfterMs,
    }),
  );
}

/**
 * Record a durable cancellation request.
 *
 * A waiting or merely claimed delivery cancels at once: nothing has been sent.
 * (The claimant's `attempting` commit then loses its compare-and-swap and it
 * re-reads a terminal record.) An attempting delivery keeps its lease and moves
 * to `cancellation-requested`, so only the current attempt can settle it.
 * Requesting cancellation twice rejects with `not-leased` against a record
 * already in `cancellation-requested`, which the caller reports as the same
 * outcome.
 */
export function requestDeliveryCancellation(
  record: ApplicationDeliveryRecord,
  options: { readonly now: number; readonly reason?: string | undefined },
): ApplicationOutboxTransition<ApplicationDeliveryCancelling | ApplicationDeliveryTerminalRecord> {
  const live = nonTerminalDeliveryRecord(record);
  if (live === null) return rejectedTransition('already-terminal');
  if (live.state === 'cancellation-requested') return rejectedTransition('not-leased');
  if (live.state === 'attempting') {
    return succeededTransition({
      ...live,
      generation: live.generation + 1,
      state: 'cancellation-requested',
      cancellationRequestedAt: options.now,
      cancellationReason: options.reason,
    });
  }
  return succeededTransition({
    ...applicationDeliveryIdentityFields(live),
    state: 'cancelled',
    terminalAt: options.now,
    failure: { reason: 'cancelled' },
    cancellationRequestedAt: options.now,
    cancellationReason: options.reason,
    cleanupPending: false,
  });
}

/**
 * Operator retry: return a parked, dead-lettered, or rejected delivery to the
 * due index with exactly one more attempt to spend.
 *
 * `maxAttempts` is raised to `attempt + 1` when the budget is spent, so the
 * retried delivery can be claimed once; a second operator retry grants one
 * more. The record's provenance (`attempt`, `retryCount`) is preserved.
 */
export function retryDeliveryByOperator(
  record: ApplicationDeliveryRecord,
  options: { readonly now: number },
): ApplicationOutboxTransition<ApplicationDeliveryQueued> {
  if (
    record.state !== 'unknown-outcome' &&
    record.state !== 'dead-lettered' &&
    record.state !== 'rejected'
  ) {
    return rejectedTransition('not-applicable');
  }
  return succeededTransition({
    ...applicationDeliveryIdentityFields(record),
    state: 'queued',
    maxAttempts: Math.max(record.maxAttempts, record.attempt + 1),
    availableAt: options.now,
  });
}

/** Operator dead-letter: close a parked `unknown-outcome` delivery for good. */
export function deadLetterDeliveryByOperator(
  record: ApplicationDeliveryRecord,
  options: { readonly now: number; readonly reason?: string | undefined },
): ApplicationOutboxTransition<ApplicationDeliveryTerminalRecord> {
  if (record.state !== 'unknown-outcome') return rejectedTransition('not-applicable');
  return succeededTransition({
    ...applicationDeliveryIdentityFields(record),
    state: 'dead-lettered',
    terminalAt: options.now,
    failure: {
      reason: 'unknown-outcome',
      message: options.reason ?? record.failure?.message,
      details: record.failure?.details,
    },
    cancellationRequestedAt: record.cancellationRequestedAt,
    cancellationReason: record.cancellationReason,
    cleanupPending: record.cleanupPending,
    abandonedAttemptToken: record.abandonedAttemptToken,
  });
}
