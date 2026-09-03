/**
 * Claim, settlement, cancellation, and maintenance result types for the durable
 * application command mailbox (WFT-84).
 *
 * Split from `application-mailbox-contract.ts` only to keep both files under
 * this repository's file-size ceiling; every type here is re-exported from
 * there, so callers still have one import path.
 *
 * The same two rules shape these signatures. Expected outcomes are
 * discriminated results rather than exceptions — a stale attempt token, an
 * already-terminal command, and an unknown command id are all ordinary control
 * flow. And no read here consumes delivery: a snapshot never claims or starts
 * work.
 *
 * @module core/application-mailbox-claims
 */

import type { ApplicationCommandReceipt } from './application-mailbox-contract.ts';

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
 * A `pending` status means the mailbox stopped waiting — never that the handler
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

/**
 * Options for the abortable wait for new available work.
 *
 * `timeoutMs` defaults to `0`: with no options the wait checks once and returns
 * immediately instead of blocking.
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
  /** How long to keep polling. Default `0` — one check, no wait. */
  readonly timeoutMs?: number | undefined;
  /** Gap between durable polls. Default 50. */
  readonly pollIntervalMs?: number | undefined;
};
