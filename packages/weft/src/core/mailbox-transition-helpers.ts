/**
 * The primitives every mailbox transition shares (WFT-84):
 * the rejection vocabulary, the transition result shape, non-terminal
 * narrowing, identity-field carry-over, and retry backoff.
 *
 * Extracted so `mailbox-transitions.ts` and
 * `mailbox-transitions-recovery.ts` can both use them without
 * importing each other — a runtime cycle this repository forbids outright.
 *
 * @module core/mailbox-transition-helpers
 */

import { computeRetryBackoffMs } from './application-primitive-timing.ts';
import type {
  ApplicationCommandAccepted,
  ApplicationCommandAvailable,
  ApplicationCommandCancelling,
  ApplicationCommandClaimed,
  ApplicationCommandRecord,
  ApplicationCommandTerminalRecord,
} from './mailbox-types.ts';
import { MAILBOX_RECORD_VERSION, isApplicationCommandTerminalState } from './mailbox-types.ts';

export { computeRetryBackoffMs };

/**
 * Why a proposed transition is illegal. Stable and low-cardinality, so callers
 * can map each reason onto a discriminated result without string matching.
 */
export type MailboxTransitionRejection =
  | 'stale-attempt'
  | 'not-leased'
  | 'not-waiting'
  | 'not-due'
  | 'deadline-exceeded'
  | 'already-terminal';

/**
 * The outcome of a proposed transition: the record to persist, or why the edge
 * is illegal.
 */
export type MailboxTransition<TNext> =
  | { readonly ok: true; readonly next: TNext }
  | { readonly ok: false; readonly reason: MailboxTransitionRejection };

export function rejectedTransition<TNext>(
  reason: MailboxTransitionRejection,
): MailboxTransition<TNext> {
  return { ok: false, reason };
}

export function succeededTransition<TNext>(next: TNext): MailboxTransition<TNext> {
  return { ok: true, next };
}

/**
 * Narrow a record to the four non-terminal states.
 *
 * `isApplicationCommandTerminalState` narrows the `state` string but not the
 * record it came from, so every transition below needs this to stay cast-free.
 */
export function isTerminalCommandRecord(
  record: ApplicationCommandRecord,
): record is ApplicationCommandTerminalRecord {
  return isApplicationCommandTerminalState(record.state);
}

export function nonTerminalCommandRecord(
  record: ApplicationCommandRecord,
):
  | ApplicationCommandAccepted
  | ApplicationCommandAvailable
  | ApplicationCommandClaimed
  | ApplicationCommandCancelling
  | null {
  return isTerminalCommandRecord(record) ? null : record;
}

/** Strip the state-specific fields so a transition rebuilds a record from identity alone. */
export function applicationCommandIdentityFields(record: ApplicationCommandRecord) {
  return {
    recordVersion: MAILBOX_RECORD_VERSION,
    namespace: record.namespace,
    resourceId: record.resourceId,
    commandId: record.commandId,
    sequence: record.sequence,
    idempotencyKey: record.idempotencyKey,
    caller: record.caller,
    target: record.target,
    kind: record.kind,
    payload: record.payload,
    payloadDigest: record.payloadDigest,
    payloadMediaType: record.payloadMediaType,
    payloadSchema: record.payloadSchema,
    causation: record.causation,
    acceptedAt: record.acceptedAt,
    absoluteDeadlineAt: record.absoluteDeadlineAt,
    maxAttempts: record.maxAttempts,
    visibilityTimeoutMs: record.visibilityTimeoutMs,
    generation: record.generation + 1,
    attempt: record.attempt,
    retryCount: record.retryCount,
    firstClaimedAt: record.firstClaimedAt,
    availableAt: record.availableAt,
  } as const;
}
