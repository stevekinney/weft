/**
 * Claim, settlement, cancellation, operator, maintenance, wait, and drain
 * result types for the durable application delivery outbox (WFT-85).
 *
 * Split from `application-outbox-contract.ts` only to keep both files under
 * this repository's file-size ceiling; every type here is re-exported from
 * there, so callers still have one import path.
 *
 * @module core/application-outbox-claims
 */

import type {
  ApplicationDeliveryReceipt,
  ApplicationOutboxCapacity,
} from './application-outbox-contract.ts';

// ---------------------------------------------------------------------------
// Claims and settlement
// ---------------------------------------------------------------------------

/**
 * A payload handed to a claimant: digest-verified when inline, unverified when
 * a reference Weft never dereferences.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryClaimedPayload } from '@lostgradient/weft';
 *
 * declare const payload: ApplicationDeliveryClaimedPayload;
 * if (payload.form === 'inline') console.log(payload.verified); // true
 * ```
 */
export type ApplicationDeliveryClaimedPayload =
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
 * An open lease on one delivery.
 *
 * `signal` aborts when cancellation is requested in this process, when the
 * attempt is released or refused, and when the outbox is disposed. It is
 * process-local. The attempt deadline does not arm a timer on it: a host that
 * drives claims itself learns the deadline has passed from `heartbeat()` or
 * `settle()` returning `deadline-exceeded`, and `deliverNext()` stops waiting
 * for the adapter at the deadline and aborts the signal as it releases the
 * attempt.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryClaim } from '@lostgradient/weft';
 *
 * declare const claim: ApplicationDeliveryClaim;
 * console.log(claim.attemptToken, claim.signal.aborted);
 * ```
 */
export type ApplicationDeliveryClaim = Readonly<{
  receipt: ApplicationDeliveryReceipt;
  payload: ApplicationDeliveryClaimedPayload;
  /** Present only to the claimant; never on a receipt. */
  credentialRef?: string | undefined;
  attemptToken: string;
  attempt: number;
  visibilityExpiresAt: number;
  attemptDeadlineAt: number;
  signal: AbortSignal;
}>;

/**
 * The outcome of asking for work. `held` means deliveries exist but none is
 * due yet; `availableAt` is the earliest.
 *
 * @example
 * ```ts
 * import type { ApplicationOutboxClaimResult } from '@lostgradient/weft';
 *
 * declare const result: ApplicationOutboxClaimResult;
 * if (result.status === 'claimed') console.log(result.claim.attemptToken);
 * ```
 */
export type ApplicationOutboxClaimResult =
  | { readonly status: 'claimed'; readonly claim: ApplicationDeliveryClaim }
  | { readonly status: 'empty' }
  | { readonly status: 'held'; readonly availableAt: number };

/**
 * Result of a heartbeat: liveness recorded and visibility extended, clamped to
 * the fixed attempt deadline.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryHeartbeatResult } from '@lostgradient/weft';
 *
 * declare const result: ApplicationDeliveryHeartbeatResult;
 * if (result.status === 'renewed' && result.cancellationRequested) console.log('stop sending');
 * ```
 */
export type ApplicationDeliveryHeartbeatResult =
  | {
      readonly status: 'renewed';
      readonly visibilityExpiresAt: number;
      readonly attemptDeadlineAt: number;
      readonly cancellationRequested: boolean;
      readonly receipt: ApplicationDeliveryReceipt;
    }
  | { readonly status: 'stale'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'deadline-exceeded'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'unknown' };

/**
 * Result of marking an attempt as begun, or of settling it.
 *
 * `deadline-exceeded` is distinct from `stale`: the attempt itself is over and
 * maintenance recovers the delivery, while `stale` means another attempt owns
 * it.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliverySettleResult } from '@lostgradient/weft';
 *
 * declare const result: ApplicationDeliverySettleResult;
 * if (result.status === 'settled') console.log(result.receipt.state);
 * ```
 */
export type ApplicationDeliverySettleResult =
  | { readonly status: 'settled'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'retrying'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'stale'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'deadline-exceeded'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'unknown' };

/**
 * Result of `deliverNext()`: one delivery run through the adapter and settled,
 * or nothing to do.
 *
 * @example
 * ```ts
 * import type { ApplicationOutboxDeliverResult } from '@lostgradient/weft';
 *
 * declare const result: ApplicationOutboxDeliverResult;
 * if (result.status === 'settled') console.log(result.receipt.state);
 * ```
 */
export type ApplicationOutboxDeliverResult =
  | { readonly status: 'settled'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'empty' }
  | { readonly status: 'held'; readonly availableAt: number };

// ---------------------------------------------------------------------------
// Cancellation and operator transitions
// ---------------------------------------------------------------------------

/**
 * The outcome of requesting cancellation.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryCancellationResult } from '@lostgradient/weft';
 *
 * declare const result: ApplicationDeliveryCancellationResult;
 * if (result.status === 'requested') console.log(result.cleanupPending); // true
 * ```
 */
export type ApplicationDeliveryCancellationResult =
  | { readonly status: 'cancelled'; readonly receipt: ApplicationDeliveryReceipt }
  | {
      readonly status: 'requested';
      readonly receipt: ApplicationDeliveryReceipt;
      readonly cleanupPending: true;
    }
  | { readonly status: 'already-terminal'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'unknown' };

/**
 * The bounded outcome of waiting for a cancelled delivery's attempt to settle.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryCleanupResult } from '@lostgradient/weft';
 *
 * declare const cleanup: ApplicationDeliveryCleanupResult;
 * console.log(cleanup.status === 'pending'); // the outbox stopped waiting
 * ```
 */
export type ApplicationDeliveryCleanupResult =
  | { readonly status: 'settled'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'pending'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'unknown' };

/**
 * The outcome of an operator `retry()` or `deadLetter()`.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryOperatorResult } from '@lostgradient/weft';
 *
 * declare const result: ApplicationDeliveryOperatorResult;
 * if (result.status === 'applied') console.log(result.receipt.state);
 * ```
 */
export type ApplicationDeliveryOperatorResult =
  | { readonly status: 'applied'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'not-applicable'; readonly receipt: ApplicationDeliveryReceipt }
  | {
      /** Reopening would exceed `maxBacklog`; nothing was written. */
      readonly status: 'rejected';
      readonly reason: 'backlog-full';
      readonly capacity: ApplicationOutboxCapacity;
    }
  | { readonly status: 'unknown' };

// ---------------------------------------------------------------------------
// Maintenance, waits, drain
// ---------------------------------------------------------------------------

/**
 * What one maintenance pass did. Counts only.
 *
 * @example
 * ```ts
 * import type { ApplicationOutboxMaintenanceReport } from '@lostgradient/weft';
 *
 * declare const report: ApplicationOutboxMaintenanceReport;
 * console.log(report.rescheduled, report.parked, report.retired);
 * ```
 */
export type ApplicationOutboxMaintenanceReport = Readonly<{
  /** Expired `claimed` leases returned to the due index. */
  rescheduled: number;
  /** Expired `attempting` leases parked as `unknown-outcome`. */
  parked: number;
  /** Deliveries terminalized as `dead-lettered`. */
  deadLettered: number;
  /** Terminal receipts deleted by the retention sweep. */
  retired: number;
}>;

/** Options for the abortable wait for due work. `timeoutMs` defaults to `0`.
 *
 * @example
 * ```ts
 * import type { ApplicationOutboxWaitOptions } from '@lostgradient/weft';
 *
 * const options: ApplicationOutboxWaitOptions = { timeoutMs: 5_000 };
 * console.log(options.timeoutMs); // 5000
 * ```
 */
export type ApplicationOutboxWaitOptions = {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
};

/**
 * What a bounded drain did. `pending` is what remained open when the drain
 * stopped; every other count is a durable disposition the drain committed.
 *
 * @example
 * ```ts
 * import type { ApplicationOutboxDrainReport } from '@lostgradient/weft';
 *
 * declare const report: ApplicationOutboxDrainReport;
 * console.log(report.acknowledged, report.pending);
 * ```
 */
export type ApplicationOutboxDrainReport = Readonly<{
  acknowledged: number;
  rejected: number;
  retryScheduled: number;
  deadLettered: number;
  cancelled: number;
  unknown: number;
  /** Deliveries still open when the drain stopped. */
  pending: number;
  /** Whether the drain stopped because nothing was left to do, rather than budget or abort. */
  drained: boolean;
}>;
