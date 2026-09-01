/**
 * The public input, result, and option types for the durable application
 * command mailbox (WFT-84).
 *
 * Two rules shape every signature here. First, expected outcomes are
 * discriminated results, never exceptions: an idempotency conflict, a full
 * backlog, a stale attempt token, and an already-terminal command are all
 * ordinary control flow a caller must branch on. Exceptions are reserved for
 * caller mistakes (`ApplicationCommandValidationError`) and corrupt persisted
 * state (`PersistedDataCorruptError`). Second, every read is non-consuming:
 * `receipt`, `list`, `capacity`, and `observe` never claim, start, or advance
 * work.
 *
 * @module core/application-mailbox-contract
 */

import type { BatchOperation, ConditionalBatchCondition, Storage } from '../storage/interface.ts';
import type {
  ApplicationCommandCausation,
  ApplicationCommandFailure,
  ApplicationCommandPayload,
  ApplicationCommandRecord,
  ApplicationCommandState,
} from './application-mailbox-types.ts';
import type { JSONValue } from './json.ts';

// ---------------------------------------------------------------------------
// Event sink
// ---------------------------------------------------------------------------

/**
 * The transaction-composable append contract the mailbox needs from a durable
 * event feed (WFT-83).
 *
 * Declared structurally rather than imported from `server/fleet-event-feed.ts`
 * so `src/core` keeps no runtime dependency on `src/server`. A real
 * `FleetEventFeed` satisfies it as-is — pass one straight in.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import type { ApplicationMailboxEventSink } from '@lostgradient/weft';
 * import { createFleetEventFeed } from '@lostgradient/weft/server/handler';
 *
 * const events: ApplicationMailboxEventSink = createFleetEventFeed(new MemoryStorage());
 * void events;
 * ```
 */
export type ApplicationMailboxEventSink = {
  append(
    event: {
      readonly kind: string;
      readonly emittedAtMs: number;
      readonly payload: unknown;
      readonly workflowId?: string | undefined;
    },
    options?: {
      readonly conditions?: readonly ConditionalBatchCondition[] | undefined;
      readonly operations?: readonly BatchOperation[] | undefined;
    },
  ): Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Construction options for one `(namespace, resourceId)` mailbox.
 *
 * @example
 * ```ts
 * import { MemoryStorage, type ApplicationMailboxOptions } from '@lostgradient/weft';
 *
 * const options: ApplicationMailboxOptions = {
 *   storage: new MemoryStorage(),
 *   namespace: 'bureau',
 *   resourceId: 'agent-7',
 *   maxBacklog: 512,
 * };
 * console.log(options.namespace); // 'bureau'
 * ```
 */
export type ApplicationMailboxOptions = {
  /** Durable backend. Must report `conditionalBatch` support. */
  readonly storage: Storage;
  /** Opaque application namespace. Weft never interprets it. */
  readonly namespace: string;
  /** Opaque resource identifier. One mailbox, one FIFO order. */
  readonly resourceId: string;
  /**
   * Optional durable event feed. When supplied, every state transition and its
   * fleet event commit in one conditional batch, so no restart can expose one
   * side without the other.
   */
  readonly events?: ApplicationMailboxEventSink | undefined;
  /** Maximum open (non-terminal) commands. Admission past it is rejected before any write. Default 1000. */
  readonly maxBacklog?: number | undefined;
  /** Default claim lease duration in milliseconds. Default 30000. */
  readonly visibilityTimeoutMs?: number | undefined;
  /** Default absolute per-command deadline in milliseconds from admission. Default 3600000. */
  readonly commandTimeoutMs?: number | undefined;
  /** Default maximum claims per command before dead-lettering. Default 3. */
  readonly maxAttempts?: number | undefined;
  /** Retry backoff base in milliseconds. Default 1000. */
  readonly retryBackoffMs?: number | undefined;
  /** Ceiling on retry backoff in milliseconds. Default 60000. */
  readonly maxRetryBackoffMs?: number | undefined;
  /** How long a terminal receipt is retained before a maintenance sweep may delete it. Default 86400000. */
  readonly terminalRetentionMs?: number | undefined;
  /** Maximum bytes an inline payload may encode to. Default 262144. */
  readonly maxInlinePayloadBytes?: number | undefined;
  /** Injected clock. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Injected identifier source, for deterministic tests. Defaults to `crypto.randomUUID`. */
  readonly generateId?: (() => string) | undefined;
};

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/**
 * A command offered to the mailbox.
 *
 * `commandId` is minted by the mailbox, not supplied here: `idempotencyKey` is
 * the caller's only retry handle, and it binds to
 * `(caller, target, kind, payloadDigest)`.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandInput } from '@lostgradient/weft';
 *
 * const command: ApplicationCommandInput = {
 *   caller: 'user:42',
 *   target: 'agent:7',
 *   kind: 'steer',
 *   payload: { form: 'inline', value: { text: 'stop' } },
 *   idempotencyKey: 'steer-1',
 * };
 * console.log(command.kind); // 'steer'
 * ```
 */
export type ApplicationCommandInput = {
  /** Opaque caller identity. Part of the idempotency binding. */
  readonly caller: string;
  /** Opaque target within the resource. Part of the idempotency binding. */
  readonly target: string;
  /** Opaque command kind. Part of the idempotency binding. */
  readonly kind: string;
  readonly payload: ApplicationCommandPayload;
  /** Retry handle. Absent means every admission creates a new command. */
  readonly idempotencyKey?: string | undefined;
  readonly payloadMediaType?: string | undefined;
  readonly payloadSchema?: string | undefined;
  readonly causation?: ApplicationCommandCausation | undefined;
  /** Delay before the command is released for delivery. Default 0. */
  readonly availableAfterMs?: number | undefined;
  /** Per-command overrides of the mailbox defaults. */
  readonly maxAttempts?: number | undefined;
  readonly visibilityTimeoutMs?: number | undefined;
  readonly commandTimeoutMs?: number | undefined;
};

/**
 * The outcome of offering a command.
 *
 * `admitted` and `duplicate` both carry the authoritative receipt — a duplicate
 * returns the original, never a second command. `conflict` means the
 * idempotency key is already bound to a different
 * `(caller, target, kind, payloadDigest)`; the original command is untouched.
 * `rejected` means the backlog is full and nothing was persisted.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandAdmission } from '@lostgradient/weft';
 *
 * declare const admission: ApplicationCommandAdmission;
 * if (admission.status === 'admitted') console.log(admission.receipt.commandId);
 * ```
 */
export type ApplicationCommandAdmission =
  | { readonly status: 'admitted'; readonly receipt: ApplicationCommandReceipt }
  | { readonly status: 'duplicate'; readonly receipt: ApplicationCommandReceipt }
  | {
      readonly status: 'conflict';
      readonly receipt: ApplicationCommandReceipt;
      readonly reason: 'idempotency-identity-mismatch';
    }
  | {
      readonly status: 'rejected';
      readonly reason: 'backlog-full';
      readonly capacity: ApplicationMailboxCapacity;
    };

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * An immutable point-in-time view of a command. Safe to share across observers:
 * reading one never claims, starts, or advances work.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandReceipt } from '@lostgradient/weft';
 *
 * declare const receipt: ApplicationCommandReceipt;
 * console.log(receipt.state, receipt.attempt);
 * ```
 */
export type ApplicationCommandReceipt = Readonly<{
  commandId: string;
  namespace: string;
  resourceId: string;
  sequence: number;
  state: ApplicationCommandState;
  caller: string;
  target: string;
  kind: string;
  payloadDigest: string;
  payloadForm: ApplicationCommandPayload['form'];
  payloadMediaType?: string | undefined;
  payloadSchema?: string | undefined;
  idempotencyKey?: string | undefined;
  causation?: ApplicationCommandCausation | undefined;
  acceptedAt: number;
  availableAt: number;
  absoluteDeadlineAt: number;
  attempt: number;
  retryCount: number;
  maxAttempts: number;
  generation: number;
  /**
   * Lease liveness, present only while an attempt holds the command.
   *
   * The attempt token itself is deliberately NOT here. It is a fencing
   * credential, and a receipt is readable by any observer — publishing it would
   * let a bystander settle work it never claimed.
   */
  claimedAt?: number | undefined;
  visibilityExpiresAt?: number | undefined;
  lastActivityAt?: number | undefined;
  progress?: JSONValue | undefined;
  cancellationRequestedAt?: number | undefined;
  cancellationReason?: string | undefined;
  terminalAt?: number | undefined;
  outcome?: JSONValue | undefined;
  failure?: ApplicationCommandFailure | undefined;
  /** True when the command terminalized while an attempt still held it and never settled. */
  cleanupPending?: boolean | undefined;
}>;

/** Bounded backlog accounting. Deliberately low-cardinality: no per-command detail.
 *
 * @example
 * ```ts
 * import type { ApplicationMailboxCapacity } from '@lostgradient/weft';
 *
 * declare const capacity: ApplicationMailboxCapacity;
 * console.log(capacity.open, capacity.remaining, capacity.limit);
 * ```
 */
export type ApplicationMailboxCapacity = Readonly<{
  /** Commands admitted and not yet terminal. */
  open: number;
  /** Configured ceiling on `open`. */
  limit: number;
  /** `limit - open`, floored at zero. */
  remaining: number;
  /** Lifetime admissions. */
  admitted: number;
}>;

/** Bounded listing options. `limit` is clamped to 1000.
 *
 * @example
 * ```ts
 * import type { ApplicationMailboxListOptions } from '@lostgradient/weft';
 *
 * const options: ApplicationMailboxListOptions = { limit: 50, states: ['available'] };
 * console.log(options.limit); // 50
 * ```
 */
export type ApplicationMailboxListOptions = {
  readonly limit?: number | undefined;
  readonly states?: readonly ApplicationCommandState[] | undefined;
};

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * A payload handed to a claimant.
 *
 * For an inline payload the mailbox recomputes the digest at claim time and
 * fails closed on a mismatch, so `verified` is `true`. For a reference payload
 * Weft holds only the locator and the caller-supplied digest and never
 * dereferences either, so `verified` is `false` and verification is the
 * consumer's job.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandClaimedPayload } from '@lostgradient/weft';
 *
 * declare const payload: ApplicationCommandClaimedPayload;
 * if (payload.form === 'inline') console.log(payload.verified); // true
 * ```
 */
export type ApplicationCommandClaimedPayload =
  | {
      readonly form: 'inline';
      readonly value: unknown;
      readonly digest: string;
      readonly verified: true;
    }
  | {
      readonly form: 'reference';
      readonly reference: string;
      readonly digest: string;
      readonly byteLength?: number | undefined;
      readonly verified: false;
    };

/**
 * An open lease on one command.
 *
 * `signal` aborts when cancellation is requested in this process, when the
 * lease is released, or when the mailbox is disposed. It is process-local: a
 * claimant in another process learns about cancellation from
 * `renew()`'s `cancellationRequested` flag instead.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandClaim } from '@lostgradient/weft';
 *
 * declare const claim: ApplicationCommandClaim;
 * console.log(claim.attemptToken, claim.signal.aborted);
 * ```
 */
export type ApplicationCommandClaim = Readonly<{
  receipt: ApplicationCommandReceipt;
  payload: ApplicationCommandClaimedPayload;
  /** Opaque fencing token. Every later mutation from this attempt must present it. */
  attemptToken: string;
  attempt: number;
  visibilityExpiresAt: number;
  absoluteDeadlineAt: number;
  /** Attempt-scoped abort signal for an in-process claimant. */
  signal: AbortSignal;
}>;

/**
 * The outcome of asking for work.
 *
 * `held` means the FIFO head exists but is not due yet. This mailbox preserves
 * strict FIFO order, so a later command never overtakes a delayed head.
 *
 * @example
 * ```ts
 * import type { ApplicationMailboxClaimResult } from '@lostgradient/weft';
 *
 * declare const result: ApplicationMailboxClaimResult;
 * if (result.status === 'claimed') console.log(result.claim.attemptToken);
 * ```
 */
export type ApplicationMailboxClaimResult =
  | { readonly status: 'claimed'; readonly claim: ApplicationCommandClaim }
  | { readonly status: 'empty' }
  | { readonly status: 'held'; readonly availableAt: number };

/** Result of renewing a lease and reporting liveness.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandRenewalResult } from '@lostgradient/weft';
 *
 * declare const result: ApplicationCommandRenewalResult;
 * if (result.status === 'renewed' && result.cancellationRequested) console.log('wind down');
 * ```
 */
export type ApplicationCommandRenewalResult =
  | {
      readonly status: 'renewed';
      readonly visibilityExpiresAt: number;
      /** True once cancellation is durably requested — the cross-process cancellation channel. */
      readonly cancellationRequested: boolean;
      readonly receipt: ApplicationCommandReceipt;
    }
  | { readonly status: 'stale'; readonly receipt: ApplicationCommandReceipt }
  | {
      /** The absolute command deadline passed; no attempt may extend or settle it. */
      readonly status: 'deadline-exceeded';
      readonly receipt: ApplicationCommandReceipt;
    }
  | { readonly status: 'unknown' };

/**
 * Result of settling a claimed command.
 *
 * `deadline-exceeded` is reported separately from `stale` on purpose: `stale`
 * means another attempt owns the command and this one should stop, while
 * `deadline-exceeded` means the command itself is over and no attempt will
 * settle it. Maintenance dead-letters the record.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandSettleResult } from '@lostgradient/weft';
 *
 * declare const result: ApplicationCommandSettleResult;
 * if (result.status === 'settled') console.log(result.receipt.state);
 * ```
 */
export type ApplicationCommandSettleResult =
  | { readonly status: 'settled'; readonly receipt: ApplicationCommandReceipt }
  | { readonly status: 'retrying'; readonly receipt: ApplicationCommandReceipt }
  | { readonly status: 'stale'; readonly receipt: ApplicationCommandReceipt }
  | { readonly status: 'deadline-exceeded'; readonly receipt: ApplicationCommandReceipt }
  | { readonly status: 'unknown' };

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * The outcome of requesting cancellation.
 *
 * The four dispositions are distinct on purpose: an unclaimed command cancels
 * immediately with nothing to clean up, a claimed one records the request and
 * leaves the lease alone, an already-terminal one is reported as such without
 * being rewritten, and an unknown command id is never confused with any of
 * those.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandCancellationResult } from '@lostgradient/weft';
 *
 * declare const result: ApplicationCommandCancellationResult;
 * if (result.status === 'requested') console.log(result.cleanupPending); // true
 * ```
 */
export type ApplicationCommandCancellationResult =
  | { readonly status: 'cancelled'; readonly receipt: ApplicationCommandReceipt }
  | {
      readonly status: 'requested';
      readonly receipt: ApplicationCommandReceipt;
      /** Always true: an attempt still holds the command and has not settled. */
      readonly cleanupPending: true;
    }
  | { readonly status: 'already-terminal'; readonly receipt: ApplicationCommandReceipt }
  | { readonly status: 'unknown' };

/**
 * The bounded outcome of waiting for a cancelled command's claimant to finish.
 *
 * `settled: false` means the mailbox stopped waiting — never that the handler
 * stopped.
 *
 * @example
 * ```ts
 * import type { ApplicationCommandCleanupResult } from '@lostgradient/weft';
 *
 * declare const cleanup: ApplicationCommandCleanupResult;
 * console.log(cleanup.status === 'pending'); // the mailbox stopped waiting
 * ```
 */
export type ApplicationCommandCleanupResult =
  | { readonly status: 'settled'; readonly receipt: ApplicationCommandReceipt }
  | { readonly status: 'pending'; readonly receipt: ApplicationCommandReceipt }
  | { readonly status: 'unknown' };

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * What one maintenance pass did. Counts only — deliberately low-cardinality.
 *
 * @example
 * ```ts
 * import type { ApplicationMailboxMaintenanceReport } from '@lostgradient/weft';
 *
 * declare const report: ApplicationMailboxMaintenanceReport;
 * console.log(report.released, report.reclaimed, report.deadLettered);
 * ```
 */
export type ApplicationMailboxMaintenanceReport = Readonly<{
  /** `accepted` records whose `availableAt` passed and are now `available`. */
  released: number;
  /** Expired leases returned to the delivery index at their original FIFO position. */
  reclaimed: number;
  /** Commands terminalized for exhausted attempts or a passed absolute deadline. */
  deadLettered: number;
  /** Cancelled commands whose abandoned lease expired. */
  cancelled: number;
  /** Terminal receipts deleted by the retention sweep. */
  retired: number;
}>;

/** Options for the abortable wait for new available work.
 *
 * @example
 * ```ts
 * import type { ApplicationMailboxWaitOptions } from '@lostgradient/weft';
 *
 * const options: ApplicationMailboxWaitOptions = { timeoutMs: 5_000, pollIntervalMs: 50 };
 * console.log(options.timeoutMs); // 5000
 * ```
 */
export type ApplicationMailboxWaitOptions = {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
};

/** Internal helper alias: the decoded record plus the exact bytes it was read as. */
export type LoadedCommandRecord = {
  readonly record: ApplicationCommandRecord;
  readonly bytes: Uint8Array;
};
