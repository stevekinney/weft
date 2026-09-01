/**
 * The primitives every application-mailbox transition shares (WFT-84):
 * the rejection vocabulary, the transition result shape, non-terminal
 * narrowing, identity-field carry-over, and retry backoff.
 *
 * Extracted so `application-mailbox-transitions.ts` and
 * `application-mailbox-transitions-recovery.ts` can both use them without
 * importing each other — a runtime cycle this repository forbids outright.
 *
 * @module core/application-mailbox-transition-helpers
 */

import type {
  ApplicationCommandAccepted,
  ApplicationCommandAvailable,
  ApplicationCommandCancelling,
  ApplicationCommandClaimed,
  ApplicationCommandRecord,
  ApplicationCommandTerminalRecord,
} from './application-mailbox-types.ts';
import {
  APPLICATION_MAILBOX_RECORD_VERSION,
  isApplicationCommandTerminalState,
} from './application-mailbox-types.ts';

/**
 * Why a proposed transition is illegal. Stable and low-cardinality, so callers
 * can map each reason onto a discriminated result without string matching.
 */
export type ApplicationMailboxTransitionRejection =
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
export type ApplicationMailboxTransition<TNext> =
  | { readonly ok: true; readonly next: TNext }
  | { readonly ok: false; readonly reason: ApplicationMailboxTransitionRejection };

export function rejectedTransition<TNext>(
  reason: ApplicationMailboxTransitionRejection,
): ApplicationMailboxTransition<TNext> {
  return { ok: false, reason };
}

export function succeededTransition<TNext>(next: TNext): ApplicationMailboxTransition<TNext> {
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
    recordVersion: APPLICATION_MAILBOX_RECORD_VERSION,
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

/** Deterministic exponential backoff. No jitter, so redelivery timing is testable. */
export function computeRetryBackoffMs(attempt: number, baseMs: number, maximumMs: number): number {
  const raw = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(Number.isFinite(raw) ? raw : maximumMs, maximumMs);
}
