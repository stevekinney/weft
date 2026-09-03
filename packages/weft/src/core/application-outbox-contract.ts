/**
 * The public input, result, option, and adapter types for the durable
 * application delivery outbox (WFT-85).
 *
 * Two rules shape every signature here, as they do the mailbox's. Expected
 * outcomes are discriminated results, never exceptions: an idempotency
 * conflict, a full backlog, a stale attempt token, and an already-terminal
 * delivery are ordinary control flow. Exceptions are reserved for caller
 * mistakes (`ApplicationDeliveryValidationError`) and corrupt persisted state
 * (`PersistedDataCorruptError`). And every read is non-consuming: `receipt`,
 * `list`, `capacity`, and `cleanupState` never claim, start, or advance work.
 *
 * @module core/application-outbox-contract
 */

import type { Storage } from '../storage/interface.ts';
import type { ApplicationDeliveryClaimedPayload } from './application-outbox-claims.ts';
import type {
  ApplicationDeliveryCausation,
  ApplicationDeliveryFailure,
  ApplicationDeliveryPayload,
  ApplicationDeliveryRecord,
  ApplicationDeliveryState,
  ApplicationDeliveryUnknownOutcomePolicy,
} from './application-outbox-types.ts';
import type { ApplicationEventSink } from './application-primitive-commit.ts';
import type { JSONValue } from './json.ts';

/**
 * The transaction-composable append contract the outbox needs from a durable
 * event feed (WFT-83). Structurally identical to the mailbox's; a real
 * `FleetEventFeed` satisfies it as-is.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import type { ApplicationOutboxEventSink } from '@lostgradient/weft';
 * import { createFleetEventFeed } from '@lostgradient/weft/server/handler';
 *
 * const events: ApplicationOutboxEventSink = createFleetEventFeed(new MemoryStorage());
 * void events;
 * ```
 */
export type ApplicationOutboxEventSink = ApplicationEventSink;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * What a transport adapter reports for one send.
 *
 * `acknowledged` means the remote system confirmed the effect; `evidence` is
 * bounded acknowledgement evidence persisted on the terminal receipt.
 * `retryable` means nothing was confirmed and a retry is safe. `rejected`
 * means the remote system refused permanently. `unknown` means the adapter
 * cannot say whether the effect happened — the outbox never retries that
 * without the policy and evidence to do so safely.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryOutcome } from '@lostgradient/weft';
 *
 * const outcome: ApplicationDeliveryOutcome = { status: 'acknowledged', evidence: { id: 'msg-1' } };
 * console.log(outcome.status); // 'acknowledged'
 * ```
 */
export type ApplicationDeliveryOutcome =
  | { readonly status: 'acknowledged'; readonly evidence?: JSONValue | undefined }
  | {
      readonly status: 'retryable';
      readonly message?: string | undefined;
      readonly details?: JSONValue | undefined;
      /** A transport-suggested delay; the outbox uses the larger of this and its own backoff. */
      readonly retryAfterMs?: number | undefined;
    }
  | {
      readonly status: 'rejected';
      readonly message?: string | undefined;
      readonly details?: JSONValue | undefined;
    }
  | { readonly status: 'unknown'; readonly message?: string | undefined };

/**
 * One send request handed to a transport adapter.
 *
 * `attemptToken` is the fence the adapter should present to the remote system
 * where it can (as an idempotency or request id), and `signal` aborts when
 * cancellation is requested in this process, when the runner stops waiting
 * at the attempt deadline and releases the attempt, or when the outbox is
 * disposed. `credentialRef`
 * is the opaque credential reference the delivery was enqueued with; only the
 * adapter ever sees it.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliverySendRequest } from '@lostgradient/weft';
 *
 * declare const request: ApplicationDeliverySendRequest;
 * console.log(request.delivery.destinationRef, request.attemptToken);
 * ```
 */
export type ApplicationDeliverySendRequest = Readonly<{
  delivery: ApplicationDeliveryReceipt;
  payload: ApplicationDeliveryClaimedPayload;
  credentialRef?: string | undefined;
  attemptToken: string;
  signal: AbortSignal;
}>;

/**
 * A caller-supplied transport. Weft ships no connector; the adapter owns the
 * wire, credential resolution, and how the attempt token reaches the remote
 * system.
 *
 * Returning is transport evidence, not settlement: the outbox commits the
 * matching durable disposition, fenced on the attempt, and only that commit
 * moves the record. A thrown error is treated as `unknown`, because the
 * request may already have left the process.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryAdapter } from '@lostgradient/weft';
 *
 * const adapter: ApplicationDeliveryAdapter = {
 *   async send(request) {
 *     void request;
 *     return { status: 'acknowledged' };
 *   },
 * };
 * console.log(typeof adapter.send); // 'function'
 * ```
 */
export type ApplicationDeliveryAdapter = {
  send(request: ApplicationDeliverySendRequest): Promise<ApplicationDeliveryOutcome>;
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Construction options for one `(namespace, ownerId)` outbox.
 *
 * @example
 * ```ts
 * import { MemoryStorage, type ApplicationOutboxOptions } from '@lostgradient/weft';
 *
 * const options: ApplicationOutboxOptions = {
 *   storage: new MemoryStorage(),
 *   namespace: 'bureau',
 *   ownerId: 'agent-7',
 * };
 * console.log(options.namespace); // 'bureau'
 * ```
 */
export type ApplicationOutboxOptions = {
  /** Durable backend. Must report `conditionalBatch` support and snapshot scans. */
  readonly storage: Storage;
  /** Opaque application namespace. Weft never interprets it. */
  readonly namespace: string;
  /** Opaque owner identifier. One outbox per owner. */
  readonly ownerId: string;
  /**
   * The transport `deliverNext()` and `drain()` run. Optional: a host that
   * drives claims itself through `claim()`, `beginAttempt()`, and the settle
   * methods needs none.
   */
  readonly adapter?: ApplicationDeliveryAdapter | undefined;
  /** Optional durable event feed; every transition commits atomically with its event. */
  readonly events?: ApplicationOutboxEventSink | undefined;
  /** Maximum open (non-terminal) deliveries. Enqueue past it is rejected before any write. Default 1000. */
  readonly maxBacklog?: number | undefined;
  /** Default lease renewal window in milliseconds. Default 30000. */
  readonly visibilityTimeoutMs?: number | undefined;
  /** Default ceiling on one attempt in milliseconds from its claim. Default 300000. */
  readonly attemptTimeoutMs?: number | undefined;
  /** Default maximum claims per delivery before dead-lettering. Default 3. */
  readonly maxAttempts?: number | undefined;
  /** Retry backoff base in milliseconds. Default 1000. */
  readonly retryBackoffMs?: number | undefined;
  /** Ceiling on retry backoff in milliseconds. Default 60000. */
  readonly maxRetryBackoffMs?: number | undefined;
  /** How long a terminal receipt is retained before a maintenance sweep may delete it. Default 86400000. */
  readonly terminalRetentionMs?: number | undefined;
  /** Maximum bytes an inline payload may encode to. Default 262144. */
  readonly maxInlinePayloadBytes?: number | undefined;
  /** How many delivery records one maintenance scan page reads. Default 500. */
  readonly maintenanceBatchSize?: number | undefined;
  /** Default disposition for a lost transport result. Default `'park'`. */
  readonly unknownOutcomePolicy?: ApplicationDeliveryUnknownOutcomePolicy | undefined;
  /**
   * Whether the outbox runs its own maintenance interval. Default `'manual'`:
   * the host calls `runMaintenance()` and nothing runs on a hidden timer. With
   * `'automatic'` one interval runs a maintenance pass every
   * `maintenanceIntervalMs`; `dispose()` clears it. Delivery is never driven
   * by the interval — `deliverNext()` and `drain()` remain the host's call.
   */
  readonly backgroundTasks?: 'automatic' | 'manual' | undefined;
  /** Interval between automatic maintenance passes in milliseconds. Default 1000. */
  readonly maintenanceIntervalMs?: number | undefined;
  /** Where an automatic maintenance pass reports a failure. Default `console.error`. */
  readonly onMaintenanceError?: ((error: unknown) => void) | undefined;
  /** Injected clock. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Injected identifier source, for deterministic tests. Defaults to `crypto.randomUUID`. */
  readonly generateId?: (() => string) | undefined;
};

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * A delivery offered to the outbox.
 *
 * `deliveryId` is minted by the outbox; `idempotencyKey` is the caller's retry
 * handle and binds to `(destinationRef, kind, payloadDigest)`.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryInput } from '@lostgradient/weft';
 *
 * const input: ApplicationDeliveryInput = {
 *   destinationRef: 'webhook:orders',
 *   kind: 'order.shipped',
 *   payload: { form: 'inline', value: { orderId: 42 } },
 *   idempotencyKey: 'order-42-shipped',
 * };
 * console.log(input.kind); // 'order.shipped'
 * ```
 */
export type ApplicationDeliveryInput = {
  /** Opaque destination reference. Part of the idempotency binding. */
  readonly destinationRef: string;
  /** Opaque credential reference. Never part of any binding, receipt, or event. */
  readonly credentialRef?: string | undefined;
  /** Opaque delivery kind. Part of the idempotency binding. */
  readonly kind: string;
  readonly payload: ApplicationDeliveryPayload;
  readonly idempotencyKey?: string | undefined;
  readonly payloadMediaType?: string | undefined;
  readonly payloadSchema?: string | undefined;
  readonly causation?: ApplicationDeliveryCausation | undefined;
  /** Stable external idempotency evidence. Required for `retry-with-idempotency`. */
  readonly externalIdempotencyKey?: string | undefined;
  readonly unknownOutcomePolicy?: ApplicationDeliveryUnknownOutcomePolicy | undefined;
  /** Delay before the delivery is due. Default 0. */
  readonly availableAfterMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly visibilityTimeoutMs?: number | undefined;
  readonly attemptTimeoutMs?: number | undefined;
};

/**
 * The outcome of offering a delivery.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryAdmission } from '@lostgradient/weft';
 *
 * declare const admission: ApplicationDeliveryAdmission;
 * if (admission.status === 'enqueued') console.log(admission.receipt.deliveryId);
 * ```
 */
export type ApplicationDeliveryAdmission =
  | { readonly status: 'enqueued'; readonly receipt: ApplicationDeliveryReceipt }
  | { readonly status: 'duplicate'; readonly receipt: ApplicationDeliveryReceipt }
  | {
      readonly status: 'conflict';
      readonly receipt: ApplicationDeliveryReceipt;
      readonly reason: 'idempotency-identity-mismatch';
    }
  | {
      readonly status: 'rejected';
      readonly reason: 'backlog-full';
      readonly capacity: ApplicationOutboxCapacity;
    };

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * An immutable point-in-time view of a delivery. Safe to share across
 * observers: reading one never claims, starts, or advances work.
 *
 * The attempt token and the credential reference are deliberately absent. The
 * token is a fencing credential and the reference is a secret locator; a
 * receipt is readable by any observer.
 *
 * @example
 * ```ts
 * import type { ApplicationDeliveryReceipt } from '@lostgradient/weft';
 *
 * declare const receipt: ApplicationDeliveryReceipt;
 * console.log(receipt.state, receipt.attempt);
 * ```
 */
export type ApplicationDeliveryReceipt = Readonly<{
  deliveryId: string;
  namespace: string;
  ownerId: string;
  sequence: number;
  state: ApplicationDeliveryState;
  destinationRef: string;
  kind: string;
  payloadDigest: string;
  payloadForm: ApplicationDeliveryPayload['form'];
  payloadMediaType?: string | undefined;
  payloadSchema?: string | undefined;
  idempotencyKey?: string | undefined;
  externalIdempotencyKey?: string | undefined;
  unknownOutcomePolicy: ApplicationDeliveryUnknownOutcomePolicy;
  causation?: ApplicationDeliveryCausation | undefined;
  enqueuedAt: number;
  availableAt: number;
  attempt: number;
  retryCount: number;
  maxAttempts: number;
  generation: number;
  claimedAt?: number | undefined;
  visibilityExpiresAt?: number | undefined;
  attemptDeadlineAt?: number | undefined;
  lastActivityAt?: number | undefined;
  transportActivity?: JSONValue | undefined;
  attemptStartedAt?: number | undefined;
  lastFailure?: ApplicationDeliveryFailure | undefined;
  cancellationRequestedAt?: number | undefined;
  cancellationReason?: string | undefined;
  terminalAt?: number | undefined;
  evidence?: JSONValue | undefined;
  failure?: ApplicationDeliveryFailure | undefined;
  /** True when the delivery terminalized while an attempt still held it and never settled. */
  cleanupPending?: boolean | undefined;
}>;

/** Bounded backlog accounting. Counts only.
 *
 * @example
 * ```ts
 * import type { ApplicationOutboxCapacity } from '@lostgradient/weft';
 *
 * declare const capacity: ApplicationOutboxCapacity;
 * console.log(capacity.open, capacity.remaining, capacity.limit);
 * ```
 */
export type ApplicationOutboxCapacity = Readonly<{
  open: number;
  limit: number;
  remaining: number;
  enqueued: number;
}>;

/** Bounded listing options. `limit` is clamped to 1000.
 *
 * @example
 * ```ts
 * import type { ApplicationOutboxListOptions } from '@lostgradient/weft';
 *
 * const options: ApplicationOutboxListOptions = { limit: 50, states: ['unknown-outcome'] };
 * console.log(options.limit); // 50
 * ```
 */
export type ApplicationOutboxListOptions = {
  readonly limit?: number | undefined;
  readonly states?: readonly ApplicationDeliveryState[] | undefined;
};

export type {
  ApplicationDeliveryCancellationResult,
  ApplicationDeliveryClaim,
  ApplicationDeliveryClaimedPayload,
  ApplicationDeliveryCleanupResult,
  ApplicationDeliveryHeartbeatResult,
  ApplicationDeliveryOperatorResult,
  ApplicationDeliverySettleResult,
  ApplicationOutboxClaimResult,
  ApplicationOutboxDeliverResult,
  ApplicationOutboxDrainReport,
  ApplicationOutboxMaintenanceReport,
  ApplicationOutboxWaitOptions,
} from './application-outbox-claims.ts';

/** Internal helper alias: the decoded record plus the exact bytes it was read as. */
export type LoadedDeliveryRecord = {
  readonly record: ApplicationDeliveryRecord;
  readonly bytes: Uint8Array;
};
