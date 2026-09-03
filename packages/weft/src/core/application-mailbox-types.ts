/**
 * Record and public contract types for the durable application command mailbox
 * (WFT-84).
 *
 * A mailbox is scoped by an opaque `(namespace, resourceId)` pair. Weft never
 * interprets either component: they are application identity, not workflow
 * identity, and nothing here is a remote-worker protocol record. The remote task
 * ledger's transition vocabulary (`server/task-ledger-types.ts`) is deliberately
 * mirrored where it fits — `generation`, attempt fencing, whole-record CAS — but
 * the two record families stay independent so a worker protocol change cannot
 * reshape an application receipt.
 *
 * This module defines shapes only. It reads no storage and performs no
 * transitions; `application-mailbox-transitions.ts` owns the legality rules and
 * `application-mailbox.ts` owns the commits.
 *
 * @module core/application-mailbox-types
 */

import type { JSONValue } from './json.ts';

/** Current persisted record version for every mailbox record. */
export const APPLICATION_MAILBOX_RECORD_VERSION = 1;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * A command payload carried inline in the durable record.
 *
 * `value` is encoded with Weft's structured-clone codec, so `Uint8Array`,
 * `Map`, `Set`, and `Date` round-trip verbatim. Opaque multimodal and
 * managed-asset references survive as whatever value the application put in —
 * nothing is coerced to text.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandInlinePayload } from '@lostgradient/weft';
 *
 * const payload: ApplicationCommandInlinePayload = {
 *   form: 'inline',
 *   value: { prompt: 'summarize', attachment: new Uint8Array([1, 2, 3]) },
 * };
 * console.log(payload.form); // 'inline'
 * ```
 */
export type ApplicationCommandInlinePayload = Readonly<{
  form: 'inline';
  value: unknown;
}>;

/**
 * A command payload held outside the mailbox behind a content-addressed
 * reference the application resolves itself.
 *
 * Weft stores the locator and the caller-supplied `digest` verbatim and never
 * dereferences either, so it cannot verify that remote content still matches.
 * `digest` is required precisely because the mailbox has no other way to bind
 * idempotency to payload identity for this form.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandReferencePayload } from '@lostgradient/weft';
 *
 * const payload: ApplicationCommandReferencePayload = {
 *   form: 'reference',
 *   reference: 's3://assets/9f2c',
 *   digest: 'a'.repeat(64),
 * };
 * console.log(payload.reference); // 's3://assets/9f2c'
 * ```
 */
export type ApplicationCommandReferencePayload = Readonly<{
  form: 'reference';
  reference: string;
  digest: string;
  byteLength?: number | undefined;
}>;

/**
 * Either payload form a command may carry.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandPayload } from '@lostgradient/weft';
 *
 * const payload: ApplicationCommandPayload = { form: 'inline', value: { ok: true } };
 * console.log(payload.form === 'inline'); // true
 * ```
 */
export type ApplicationCommandPayload =
  ApplicationCommandInlinePayload | ApplicationCommandReferencePayload;

/**
 * Bounded causal metadata linking a command to whatever produced it.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandCausation } from '@lostgradient/weft';
 *
 * const causation: ApplicationCommandCausation = { correlationId: 'conv-7' };
 * console.log(causation.correlationId); // 'conv-7'
 * ```
 */
export type ApplicationCommandCausation = Readonly<{
  correlationId?: string | undefined;
  causationId?: string | undefined;
  traceparent?: string | undefined;
}>;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Every disposition a command record can occupy.
 *
 * `accepted` means admitted and durable but not yet released for delivery —
 * either an initial delay or a retry backoff. `available` means released and
 * claimable. The four terminal states never transition again.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandState } from '@lostgradient/weft';
 *
 * const state: ApplicationCommandState = 'available';
 * console.log(state); // 'available'
 * ```
 */
export type ApplicationCommandState =
  | 'accepted'
  | 'available'
  | 'claimed'
  | 'cancellation-requested'
  | 'applied'
  | 'rejected'
  | 'cancelled'
  | 'dead-lettered';

/** The four dispositions from which no further transition is legal. */
export const APPLICATION_COMMAND_TERMINAL_STATES = [
  'applied',
  'rejected',
  'cancelled',
  'dead-lettered',
] as const;

/**
 * A terminal command disposition.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandTerminalState } from '@lostgradient/weft';
 *
 * const state: ApplicationCommandTerminalState = 'applied';
 * console.log(state); // 'applied'
 * ```
 */
export type ApplicationCommandTerminalState = (typeof APPLICATION_COMMAND_TERMINAL_STATES)[number];

/**
 * Why a command reached a non-success terminal state. Stable, low-cardinality,
 * and safe to branch on.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandFailureReason } from '@lostgradient/weft';
 *
 * const reason: ApplicationCommandFailureReason = 'deadline-exceeded';
 * console.log(reason); // 'deadline-exceeded'
 * ```
 */
export type ApplicationCommandFailureReason =
  'application' | 'attempts-exhausted' | 'deadline-exceeded' | 'cancelled';

/**
 * Bounded terminal evidence retained on a failed, cancelled, or dead-lettered
 * receipt.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandFailure } from '@lostgradient/weft';
 *
 * const failure: ApplicationCommandFailure = { reason: 'application', message: 'unsupported kind' };
 * console.log(failure.reason); // 'application'
 * ```
 */
export type ApplicationCommandFailure = Readonly<{
  reason: ApplicationCommandFailureReason;
  message?: string | undefined;
  details?: JSONValue | undefined;
}>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Fields every command record carries in every state — the identity and policy
 * fixed at admission that no transition may rewrite.
 *
 * `sequence` is the mailbox-scoped FIFO position assigned at admission. It is
 * never reassigned, so a redelivered command re-enters the delivery index at
 * the position it was first admitted to.
 *
 * `absoluteDeadlineAt` is the wall-clock ceiling for the whole command across
 * every attempt. Claim renewal clamps to it and can never move it.
 */
export type ApplicationCommandBase = Readonly<{
  recordVersion: typeof APPLICATION_MAILBOX_RECORD_VERSION;
  namespace: string;
  resourceId: string;
  commandId: string;
  sequence: number;
  idempotencyKey?: string | undefined;
  caller: string;
  target: string;
  kind: string;
  payload: ApplicationCommandPayload;
  payloadDigest: string;
  payloadMediaType?: string | undefined;
  payloadSchema?: string | undefined;
  causation?: ApplicationCommandCausation | undefined;
  acceptedAt: number;
  absoluteDeadlineAt: number;
  maxAttempts: number;
  visibilityTimeoutMs: number;
  /** Monotonic transition counter. Diagnostic provenance; whole-record byte equality is the real fence. */
  generation: number;
}>;

/** Attempt provenance preserved across claim, expiry, retry, and recovery. */
export type ApplicationCommandAttemptFields = Readonly<{
  /** Number of claims issued so far. `0` until the first claim. */
  attempt: number;
  /** Number of redeliveries caused by rejection-with-retry or visibility expiry. */
  retryCount: number;
  /** First time any attempt claimed this command. Absent until the first claim. */
  firstClaimedAt?: number | undefined;
}>;

/** A command admitted but not yet released for delivery (initial delay or retry backoff).
 *
 * @example
 * ```ts
 * import type { ApplicationCommandAccepted } from '@lostgradient/weft';
 *
 * declare const record: ApplicationCommandAccepted;
 * console.log(record.state, record.availableAt); // 'accepted', when it is released
 * ```
 */
export type ApplicationCommandAccepted = ApplicationCommandBase &
  ApplicationCommandAttemptFields &
  Readonly<{
    state: 'accepted';
    availableAt: number;
  }>;

/** A command released for delivery and waiting at its FIFO position.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandAvailable } from '@lostgradient/weft';
 *
 * declare const record: ApplicationCommandAvailable;
 * console.log(record.state); // 'available'
 * ```
 */
export type ApplicationCommandAvailable = ApplicationCommandBase &
  ApplicationCommandAttemptFields &
  Readonly<{
    state: 'available';
    availableAt: number;
  }>;

/** Lease fields held while one attempt owns a command. */
export type ApplicationCommandLeaseFields = Readonly<{
  /** Opaque per-attempt fencing token. Every mutation from a claimant must present it. */
  attemptToken: string;
  claimedAt: number;
  /** When an unrenewed claim becomes reclaimable. Never later than `absoluteDeadlineAt`. */
  visibilityExpiresAt: number;
  /** Latest liveness evidence from the claimant. Distinct from semantic progress. */
  lastActivityAt: number;
  /** Optional bounded, caller-supplied progress marker. Never used for fencing. */
  progress?: JSONValue | undefined;
}>;

/** A command leased by a live attempt.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandClaimed } from '@lostgradient/weft';
 *
 * declare const record: ApplicationCommandClaimed;
 * console.log(record.attemptToken, record.visibilityExpiresAt);
 * ```
 */
export type ApplicationCommandClaimed = ApplicationCommandBase &
  ApplicationCommandAttemptFields &
  ApplicationCommandLeaseFields &
  Readonly<{
    state: 'claimed';
    availableAt: number;
  }>;

/**
 * A claimed command whose cancellation is durably requested and whose claimant
 * has not yet settled. The lease stays intact so the current attempt — and only
 * the current attempt — can finish cleanup.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandCancelling } from '@lostgradient/weft';
 *
 * declare const record: ApplicationCommandCancelling;
 * console.log(record.cancellationRequestedAt);
 * ```
 */
export type ApplicationCommandCancelling = ApplicationCommandBase &
  ApplicationCommandAttemptFields &
  ApplicationCommandLeaseFields &
  Readonly<{
    state: 'cancellation-requested';
    availableAt: number;
    cancellationRequestedAt: number;
    cancellationReason?: string | undefined;
  }>;

/**
 * A command in a terminal disposition.
 *
 * `cleanupPending` is `true` when the command reached this disposition while an
 * attempt still held it and that attempt never settled: a cancellation whose
 * claimant never finished cleanup (`cancelled`), a final attempt whose lease
 * expired (`dead-lettered`, `attempts-exhausted`), or a claimed command that
 * crossed its absolute deadline (`dead-lettered`, `deadline-exceeded`).
 * `abandonedAttemptToken` names that attempt. The mailbox records that it
 * stopped waiting, never that the handler stopped.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandTerminalRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationCommandTerminalRecord;
 * console.log(record.state, record.terminalAt);
 * ```
 */
export type ApplicationCommandTerminalRecord = ApplicationCommandBase &
  ApplicationCommandAttemptFields &
  Readonly<{
    state: ApplicationCommandTerminalState;
    availableAt: number;
    terminalAt: number;
    outcome?: JSONValue | undefined;
    failure?: ApplicationCommandFailure | undefined;
    cancellationRequestedAt?: number | undefined;
    cancellationReason?: string | undefined;
    cleanupPending?: boolean | undefined;
    /** Attempt token of the lease that was still open when the command terminalized. */
    abandonedAttemptToken?: string | undefined;
  }>;

/**
 * The canonical durable record for one command, in whichever state it currently
 * occupies.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationCommandRecord;
 * console.log(record.commandId, record.state);
 * ```
 */
export type ApplicationCommandRecord =
  | ApplicationCommandAccepted
  | ApplicationCommandAvailable
  | ApplicationCommandClaimed
  | ApplicationCommandCancelling
  | ApplicationCommandTerminalRecord;

/** Any record still holding a lease.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandLeasedRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationCommandLeasedRecord;
 * console.log(record.attemptToken);
 * ```
 */
export type ApplicationCommandLeasedRecord =
  ApplicationCommandClaimed | ApplicationCommandCancelling;

/** Any record waiting in the delivery index.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandWaitingRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationCommandWaitingRecord;
 * console.log(record.availableAt);
 * ```
 */
export type ApplicationCommandWaitingRecord =
  ApplicationCommandAccepted | ApplicationCommandAvailable;

/**
 * The per-mailbox header holding the FIFO sequence allocator and the
 * open-backlog counter admission backpressure reads.
 *
 * @example
 * ```ts
 * import type { ApplicationMailboxRecord } from '@lostgradient/weft';
 *
 * declare const header: ApplicationMailboxRecord;
 * console.log(header.nextSequence, header.openCount);
 * ```
 */
export type ApplicationMailboxRecord = Readonly<{
  recordVersion: typeof APPLICATION_MAILBOX_RECORD_VERSION;
  namespace: string;
  resourceId: string;
  /** Sequence assigned to the next admitted command. */
  nextSequence: number;
  /** Commands admitted and not yet terminal. */
  openCount: number;
  /** Lifetime admissions. Never decremented; diagnostic provenance only. */
  admittedCount: number;
}>;

/** The idempotency index record binding a retry identity to one admitted command. */
export type ApplicationCommandIdempotencyRecord = Readonly<{
  recordVersion: typeof APPLICATION_MAILBOX_RECORD_VERSION;
  commandId: string;
  /** The digest of `(caller, target, kind, payloadDigest)` this key is bound to. */
  identityDigest: string;
}>;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const TERMINAL_STATE_SET: ReadonlySet<string> = new Set(APPLICATION_COMMAND_TERMINAL_STATES);

/**
 * Whether a command state is terminal.
 *
 * @example
 * ```ts
 * import { isApplicationCommandTerminalState } from '@lostgradient/weft';
 *
 * console.log(isApplicationCommandTerminalState('applied')); // true
 * console.log(isApplicationCommandTerminalState('claimed')); // false
 * ```
 */
export function isApplicationCommandTerminalState(
  state: string,
): state is ApplicationCommandTerminalState {
  return TERMINAL_STATE_SET.has(state);
}

/**
 * Whether a record still holds an attempt lease.
 *
 * @example
 * ```ts
 * import { isApplicationCommandLeased, type ApplicationCommandRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationCommandRecord;
 * if (isApplicationCommandLeased(record)) console.log(record.attemptToken);
 * ```
 */
export function isApplicationCommandLeased(
  record: ApplicationCommandRecord,
): record is ApplicationCommandLeasedRecord {
  return record.state === 'claimed' || record.state === 'cancellation-requested';
}

/**
 * Whether a record is waiting in the delivery index.
 *
 * @example
 * ```ts
 * import { isApplicationCommandWaiting, type ApplicationCommandRecord } from '@lostgradient/weft';
 *
 * declare const record: ApplicationCommandRecord;
 * if (isApplicationCommandWaiting(record)) console.log(record.availableAt);
 * ```
 */
export function isApplicationCommandWaiting(
  record: ApplicationCommandRecord,
): record is ApplicationCommandWaitingRecord {
  return record.state === 'accepted' || record.state === 'available';
}
