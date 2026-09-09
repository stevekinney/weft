/**
 * Durable record types for the application delivery outbox (WFT-85).
 *
 * A delivery is one intent to send one payload to one opaque destination. Its
 * record is the single authority for what has been attempted, what the
 * transport reported, and what disposition the outbox committed on that
 * evidence. Transport completion is never a disposition on its own: a socket
 * or HTTP write finishing is evidence the adapter reports, and only the
 * durable settlement the outbox commits on it moves the record.
 *
 * The shapes mirror the command mailbox's; what differs is the vocabulary:
 * `attempting` is a durable disposition committed before the adapter runs,
 * `unknown-outcome` parks a lost transport result, and there is no
 * per-delivery deadline — each attempt has its own.
 *
 * @module core/application-outbox-types
 */

import type {
  ApplicationCommandCausation,
  ApplicationCommandPayload,
} from './application-mailbox-types.ts';
import type { JSONValue } from './json.ts';

/** The record schema version every outbox record carries. */
export const APPLICATION_OUTBOX_RECORD_VERSION = 1;
/**
 * The payload of a delivery: the same inline-or-reference shape the command
 * mailbox uses, so one content-addressed store can back both primitives.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryPayload } from '@lostgradient/weft';
 *
 * const payload: ApplicationDeliveryPayload = { form: 'inline', value: { event: 'task.completed' } };
 * console.log(payload.form); // 'inline'
 * ```
 */
export type ApplicationDeliveryPayload = ApplicationCommandPayload;

/**
 * Causal metadata carried on a delivery, identical in shape to the mailbox's.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryCausation } from '@lostgradient/weft';
 *
 * const causation: ApplicationDeliveryCausation = { correlationId: 'run-1' };
 * console.log(causation.correlationId); // 'run-1'
 * ```
 */
export type ApplicationDeliveryCausation = ApplicationCommandCausation;

/**
 * Every disposition a delivery record can occupy.
 *
 * ```text
 * queued / retry-scheduled  waiting in the due index
 * claimed                   leased; the adapter has NOT been called
 * attempting                leased; the adapter call durably began
 * cancellation-requested    attempting, with cancellation durably requested
 * acknowledged              terminal: the transport reported acknowledgement
 * rejected                  terminal: the transport reported a permanent refusal
 * cancelled                 terminal: cancelled before any effect was confirmed
 * unknown-outcome           terminal: the transport result was lost; parked
 * dead-lettered             terminal: attempts exhausted, or unknown by policy
 * ```
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryState } from '@lostgradient/weft';
 *
 * const state: ApplicationDeliveryState = 'queued';
 * console.log(state); // 'queued'
 * ```
 */
export type ApplicationDeliveryState =
  | 'queued'
  | 'retry-scheduled'
  | 'claimed'
  | 'attempting'
  | 'cancellation-requested'
  | 'acknowledged'
  | 'rejected'
  | 'cancelled'
  | 'unknown-outcome'
  | 'dead-lettered';

/**
 * The terminal subset of {@link ApplicationDeliveryState}.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryTerminalState } from '@lostgradient/weft';
 *
 * const state: ApplicationDeliveryTerminalState = 'acknowledged';
 * console.log(state); // 'acknowledged'
 * ```
 */
export type ApplicationDeliveryTerminalState =
  'acknowledged' | 'rejected' | 'cancelled' | 'unknown-outcome' | 'dead-lettered';

/** Every terminal state, in a stable order. */
export const APPLICATION_DELIVERY_TERMINAL_STATES: readonly ApplicationDeliveryTerminalState[] = [
  'acknowledged',
  'rejected',
  'cancelled',
  'unknown-outcome',
  'dead-lettered',
];

/**
 * What the outbox does when a transport result is lost — an adapter that
 * reported `unknown`, threw, or whose attempt lease expired after the send
 * durably began.
 *
 * `park` leaves the delivery in `unknown-outcome` for an operator to `retry()`
 * or `deadLetter()`. `dead-letter` terminalizes it at once. `retry-with-
 * idempotency` schedules another attempt, and is accepted at enqueue only when
 * the delivery carries an `externalIdempotencyKey`: without stable external
 * idempotency evidence a retry could duplicate an effect that already happened.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryUnknownOutcomePolicy } from '@lostgradient/weft';
 *
 * const policy: ApplicationDeliveryUnknownOutcomePolicy = 'park';
 * console.log(policy); // 'park'
 * ```
 */
export type ApplicationDeliveryUnknownOutcomePolicy =
  'park' | 'dead-letter' | 'retry-with-idempotency';

/**
 * Why a delivery failed, rescheduled, or parked. Every reason names one
 * outbox-owned mechanism except `application`, which the transport supplied.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryFailure } from '@lostgradient/weft';
 *
 * const failure: ApplicationDeliveryFailure = { reason: 'retryable', message: '503' };
 * console.log(failure.reason); // 'retryable'
 * ```
 */
export type ApplicationDeliveryFailure = Readonly<{
  reason: 'application' | 'retryable' | 'attempts-exhausted' | 'unknown-outcome' | 'cancelled';
  message?: string | undefined;
  details?: JSONValue | undefined;
}>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Fields every delivery record carries in every state: the identity and policy
 * fixed at enqueue. Only `maxAttempts` is ever rewritten, by an operator
 * `retry()` granting one more attempt. `credentialRef` is persisted because
 * every attempt needs it and is projected into no receipt, event, or diagnostic.
 */
export type ApplicationDeliveryBase = Readonly<{
  recordVersion: typeof APPLICATION_OUTBOX_RECORD_VERSION;
  namespace: string;
  ownerId: string;
  deliveryId: string;
  /** Enqueue order within the outbox. Listing order only; never a delivery order. */
  sequence: number;
  idempotencyKey?: string | undefined;
  destinationRef: string;
  credentialRef?: string | undefined;
  kind: string;
  payload: ApplicationDeliveryPayload;
  payloadDigest: string;
  payloadMediaType?: string | undefined;
  payloadSchema?: string | undefined;
  causation?: ApplicationDeliveryCausation | undefined;
  /** Stable external idempotency evidence the transport can present on a retry. */
  externalIdempotencyKey?: string | undefined;
  unknownOutcomePolicy: ApplicationDeliveryUnknownOutcomePolicy;
  enqueuedAt: number;
  maxAttempts: number;
  /** Lease renewal window in milliseconds. Heartbeat extends visibility by this much. */
  visibilityTimeoutMs: number;
  /** Ceiling on one attempt in milliseconds from its claim. Heartbeat cannot move it. */
  attemptTimeoutMs: number;
  /** Monotonic transition counter. Diagnostic provenance; whole-record byte equality is the real fence. */
  generation: number;
}>;

/** Attempt provenance preserved across claim, expiry, retry, and recovery. */
export type ApplicationDeliveryAttemptFields = Readonly<{
  /** Number of claims issued so far. `0` until the first claim. */
  attempt: number;
  /** Number of reschedules caused by retryable outcomes, unknown outcomes, or lease expiry. */
  retryCount: number;
  /** First time any attempt claimed this delivery. Absent until the first claim. */
  firstClaimedAt?: number | undefined;
}>;

/** A delivery waiting for its first attempt.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryQueued } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryQueued;
 * console.log(record.state, record.availableAt); // 'queued', when it is due
 * ```
 */
export type ApplicationDeliveryQueued = ApplicationDeliveryBase &
  ApplicationDeliveryAttemptFields &
  Readonly<{
    state: 'queued';
    availableAt: number;
  }>;

/** A delivery waiting for a further attempt after a retryable, unknown, or expired one.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryRetryScheduled } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryRetryScheduled;
 * console.log(record.lastFailure?.reason);
 * ```
 */
export type ApplicationDeliveryRetryScheduled = ApplicationDeliveryBase &
  ApplicationDeliveryAttemptFields &
  Readonly<{
    state: 'retry-scheduled';
    availableAt: number;
    /** Why the previous attempt did not acknowledge. */
    lastFailure: ApplicationDeliveryFailure;
  }>;

/** Lease fields held while one attempt owns a delivery. */
export type ApplicationDeliveryLeaseFields = Readonly<{
  /** Opaque per-attempt fencing token. Every mutation from a claimant must present it. */
  attemptToken: string;
  claimedAt: number;
  /** When an unrenewed claim becomes reclaimable. Never later than `attemptDeadlineAt`. */
  visibilityExpiresAt: number;
  /** The ceiling on this attempt. Fixed at claim; heartbeat clamps to it and never moves it. */
  attemptDeadlineAt: number;
  /** Latest liveness evidence from the claimant. Distinct from acknowledgement. */
  lastActivityAt: number;
  /** Optional bounded transport activity evidence (bytes written, a request id). Never used for fencing. */
  transportActivity?: JSONValue | undefined;
}>;

/** A delivery leased to an attempt that has not yet durably begun its send.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryClaimed } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryClaimed;
 * console.log(record.attemptToken, record.attemptDeadlineAt);
 * ```
 */
export type ApplicationDeliveryClaimed = ApplicationDeliveryBase &
  ApplicationDeliveryAttemptFields &
  ApplicationDeliveryLeaseFields &
  Readonly<{
    state: 'claimed';
    availableAt: number;
  }>;

/**
 * A delivery whose attempt durably began its send. From here on a lost result
 * is an unknown outcome, never a safe retry.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryAttempting } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryAttempting;
 * console.log(record.attemptStartedAt);
 * ```
 */
export type ApplicationDeliveryAttempting = ApplicationDeliveryBase &
  ApplicationDeliveryAttemptFields &
  ApplicationDeliveryLeaseFields &
  Readonly<{
    state: 'attempting';
    availableAt: number;
    attemptStartedAt: number;
  }>;

/**
 * An attempting delivery whose cancellation is durably requested and whose
 * claimant has not yet settled; only the current attempt can report what the
 * transport did.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryCancelling } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryCancelling;
 * console.log(record.cancellationRequestedAt);
 * ```
 */
export type ApplicationDeliveryCancelling = ApplicationDeliveryBase &
  ApplicationDeliveryAttemptFields &
  ApplicationDeliveryLeaseFields &
  Readonly<{
    state: 'cancellation-requested';
    availableAt: number;
    attemptStartedAt: number;
    cancellationRequestedAt: number;
    cancellationReason?: string | undefined;
  }>;

/**
 * A delivery in a terminal disposition. `cleanupPending` is `true` when an
 * attempt still held it and never settled; `abandonedAttemptToken` names that
 * attempt. The outbox records that it stopped waiting, never that the transport
 * stopped.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryTerminalRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryTerminalRecord;
 * console.log(record.state, record.terminalAt);
 * ```
 */
export type ApplicationDeliveryTerminalRecord = ApplicationDeliveryBase &
  ApplicationDeliveryAttemptFields &
  Readonly<{
    state: ApplicationDeliveryTerminalState;
    availableAt: number;
    terminalAt: number;
    /** Bounded acknowledgement evidence the transport returned. */
    evidence?: JSONValue | undefined;
    failure?: ApplicationDeliveryFailure | undefined;
    cancellationRequestedAt?: number | undefined;
    cancellationReason?: string | undefined;
    cleanupPending?: boolean | undefined;
    abandonedAttemptToken?: string | undefined;
  }>;

/**
 * The canonical durable record for one delivery, in whichever state it
 * currently occupies.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryRecord;
 * console.log(record.deliveryId, record.state);
 * ```
 */
export type ApplicationDeliveryRecord =
  | ApplicationDeliveryQueued
  | ApplicationDeliveryRetryScheduled
  | ApplicationDeliveryClaimed
  | ApplicationDeliveryAttempting
  | ApplicationDeliveryCancelling
  | ApplicationDeliveryTerminalRecord;

/**
 * Any record still holding a lease.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryLeasedRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryLeasedRecord;
 * console.log(record.attemptToken, record.attemptDeadlineAt);
 * ```
 */
export type ApplicationDeliveryLeasedRecord =
  ApplicationDeliveryClaimed | ApplicationDeliveryAttempting | ApplicationDeliveryCancelling;

/**
 * Any record waiting in the due index.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryWaitingRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryWaitingRecord;
 * console.log(record.availableAt);
 * ```
 */
export type ApplicationDeliveryWaitingRecord =
  ApplicationDeliveryQueued | ApplicationDeliveryRetryScheduled;

/**
 * The per-outbox header holding the listing sequence allocator and the
 * open-backlog counter enqueue backpressure reads.
 *
 * @example
 * ```ts
 * import type { ApplicationOutboxRecord } from '@lostgradient/weft';
 *
 * declare const header: ApplicationOutboxRecord;
 * console.log(header.nextSequence, header.openCount);
 * ```
 */
export type ApplicationOutboxRecord = Readonly<{
  recordVersion: typeof APPLICATION_OUTBOX_RECORD_VERSION;
  namespace: string;
  ownerId: string;
  nextSequence: number;
  /** Deliveries enqueued and not yet terminal. */
  openCount: number;
  /** Lifetime enqueues. Never decremented; diagnostic provenance only. */
  enqueuedCount: number;
}>;

/** The idempotency index record binding a retry identity to one enqueued delivery. */
export type ApplicationDeliveryIdempotencyRecord = Readonly<{
  recordVersion: typeof APPLICATION_OUTBOX_RECORD_VERSION;
  deliveryId: string;
  /** The digest of `(destinationRef, kind, payloadDigest)` this key is bound to. */
  identityDigest: string;
}>;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const TERMINAL_STATE_SET: ReadonlySet<string> = new Set(APPLICATION_DELIVERY_TERMINAL_STATES);

/**
 * Whether a delivery state is terminal.
 *
 * @example
 * ```ts
 * import { isApplicationDeliveryTerminalState } from '@lostgradient/weft';
 *
 * console.log(isApplicationDeliveryTerminalState('acknowledged')); // true
 * console.log(isApplicationDeliveryTerminalState('attempting')); // false
 * ```
 */
export function isApplicationDeliveryTerminalState(
  state: string,
): state is ApplicationDeliveryTerminalState {
  return TERMINAL_STATE_SET.has(state);
}

/**
 * Whether a record still holds an attempt lease.
 *
 * @example
 * ```ts
 * import { isApplicationDeliveryLeased, type ApplicationDeliveryRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryRecord;
 * if (isApplicationDeliveryLeased(record)) console.log(record.attemptToken);
 * ```
 */
export function isApplicationDeliveryLeased(
  record: ApplicationDeliveryRecord,
): record is ApplicationDeliveryLeasedRecord {
  return (
    record.state === 'claimed' ||
    record.state === 'attempting' ||
    record.state === 'cancellation-requested'
  );
}

/**
 * Whether a record is waiting in the due index.
 *
 * @example
 * ```ts
 * import { isApplicationDeliveryWaiting, type ApplicationDeliveryRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryRecord;
 * if (isApplicationDeliveryWaiting(record)) console.log(record.availableAt);
 * ```
 */
export function isApplicationDeliveryWaiting(
  record: ApplicationDeliveryRecord,
): record is ApplicationDeliveryWaitingRecord {
  return record.state === 'queued' || record.state === 'retry-scheduled';
}

/**
 * Whether a record's attempt durably began its send, so a lost result is an
 * unknown outcome rather than a safe retry.
 *
 * @example
 * ```ts
 * import { isApplicationDeliveryAttempting, type ApplicationDeliveryRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationDeliveryRecord;
 * if (isApplicationDeliveryAttempting(record)) console.log(record.attemptStartedAt);
 * ```
 */
export function isApplicationDeliveryAttempting(
  record: ApplicationDeliveryRecord,
): record is ApplicationDeliveryAttempting | ApplicationDeliveryCancelling {
  return record.state === 'attempting' || record.state === 'cancellation-requested';
}
