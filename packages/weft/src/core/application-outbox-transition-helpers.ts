/**
 * The primitives every application-outbox transition shares (WFT-85): the
 * rejection vocabulary, the transition result shape, non-terminal narrowing,
 * identity-field carry-over, and retry scheduling.
 *
 * Extracted so `application-outbox-transitions.ts` and
 * `application-outbox-transitions-recovery.ts` can both use them without
 * importing each other.
 *
 * @module core/application-outbox-transition-helpers
 */

import { computeRetryBackoffMs } from './application-mailbox-transition-helpers.ts';
import { requireDerivedInstant } from './application-outbox-guards.ts';
import type {
  ApplicationDeliveryFailure,
  ApplicationDeliveryLeasedRecord,
  ApplicationDeliveryRecord,
  ApplicationDeliveryRetryScheduled,
  ApplicationDeliveryTerminalRecord,
  ApplicationDeliveryWaitingRecord,
} from './application-outbox-types.ts';
import {
  APPLICATION_OUTBOX_RECORD_VERSION,
  isApplicationDeliveryTerminalState,
} from './application-outbox-types.ts';

export { computeRetryBackoffMs };

/**
 * Why a proposed transition is illegal. Stable and low-cardinality, so callers
 * can map each reason onto a discriminated result without string matching.
 */
export type ApplicationOutboxTransitionRejection =
  | 'stale-attempt'
  | 'not-leased'
  | 'not-waiting'
  | 'not-due'
  | 'not-attempting'
  | 'deadline-exceeded'
  | 'already-terminal'
  | 'not-applicable';

/** The outcome of a proposed transition: the record to persist, or why the edge is illegal. */
export type ApplicationOutboxTransition<TNext> =
  | { readonly ok: true; readonly next: TNext }
  | { readonly ok: false; readonly reason: ApplicationOutboxTransitionRejection };

export function rejectedTransition<TNext>(
  reason: ApplicationOutboxTransitionRejection,
): ApplicationOutboxTransition<TNext> {
  return { ok: false, reason };
}

export function succeededTransition<TNext>(next: TNext): ApplicationOutboxTransition<TNext> {
  return { ok: true, next };
}

/** Narrow a record to a terminal disposition. */
export function isTerminalDeliveryRecord(
  record: ApplicationDeliveryRecord,
): record is ApplicationDeliveryTerminalRecord {
  return isApplicationDeliveryTerminalState(record.state);
}

/** Narrow a record to the five non-terminal states, or `null`. */
export function nonTerminalDeliveryRecord(
  record: ApplicationDeliveryRecord,
): ApplicationDeliveryWaitingRecord | ApplicationDeliveryLeasedRecord | null {
  return isTerminalDeliveryRecord(record) ? null : record;
}

/** Strip the state-specific fields so a transition rebuilds a record from identity alone. */
export function applicationDeliveryIdentityFields(record: ApplicationDeliveryRecord) {
  return {
    recordVersion: APPLICATION_OUTBOX_RECORD_VERSION,
    namespace: record.namespace,
    ownerId: record.ownerId,
    deliveryId: record.deliveryId,
    sequence: record.sequence,
    idempotencyKey: record.idempotencyKey,
    destinationRef: record.destinationRef,
    credentialRef: record.credentialRef,
    kind: record.kind,
    payload: record.payload,
    payloadDigest: record.payloadDigest,
    payloadMediaType: record.payloadMediaType,
    payloadSchema: record.payloadSchema,
    causation: record.causation,
    externalIdempotencyKey: record.externalIdempotencyKey,
    unknownOutcomePolicy: record.unknownOutcomePolicy,
    enqueuedAt: record.enqueuedAt,
    maxAttempts: record.maxAttempts,
    visibilityTimeoutMs: record.visibilityTimeoutMs,
    attemptTimeoutMs: record.attemptTimeoutMs,
    generation: record.generation + 1,
    attempt: record.attempt,
    retryCount: record.retryCount,
    firstClaimedAt: record.firstClaimedAt,
    availableAt: record.availableAt,
  } as const;
}

/** Backoff policy shared by every reschedule. */
export type RetryPolicy = {
  readonly retryBackoffMs: number;
  readonly maxRetryBackoffMs: number;
};

/**
 * Reschedule a leased delivery for another attempt, or dead-letter it when the
 * attempt budget is spent.
 *
 * The delay is the outbox's own backoff or the transport's suggestion,
 * whichever is longer: a transport asking for more time is honoured, one
 * asking for less is not allowed to defeat the configured backoff.
 */
export function rescheduleOrDeadLetter(
  leased: ApplicationDeliveryLeasedRecord,
  options: {
    readonly now: number;
    readonly failure: ApplicationDeliveryFailure;
    readonly retryAfterMs?: number | undefined;
  } & RetryPolicy,
): ApplicationDeliveryRetryScheduled | ApplicationDeliveryTerminalRecord {
  if (leased.attempt >= leased.maxAttempts) {
    return {
      ...applicationDeliveryIdentityFields(leased),
      state: 'dead-lettered',
      terminalAt: options.now,
      failure: { ...options.failure, reason: 'attempts-exhausted' },
    };
  }
  const backoff = computeRetryBackoffMs(
    leased.attempt,
    options.retryBackoffMs,
    options.maxRetryBackoffMs,
  );
  return {
    ...applicationDeliveryIdentityFields(leased),
    state: 'retry-scheduled',
    retryCount: leased.retryCount + 1,
    availableAt: requireDerivedInstant(
      options.now + Math.max(backoff, options.retryAfterMs ?? 0),
      'availableAt',
    ),
    lastFailure: options.failure,
  };
}
