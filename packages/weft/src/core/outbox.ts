/**
 * The durable application delivery outbox (WFT-85).
 *
 * An outbox is a storage-backed, at-least-once delivery queue scoped to one
 * opaque `(namespace, ownerId)` pair. Enqueue returns a durable receipt before
 * any transport attempt begins; attempts are fenced so two workers can never
 * both hold a valid claim; the send is durably marked `attempting` before the
 * transport is called, so a lost result is never mistaken for a safe retry;
 * cancellation is durable before it reaches anyone; and every transition
 * commits atomically with its fleet event when an event sink is configured.
 *
 * What it does not do: manufacture exactly-once external effects. A transport
 * write completing is evidence the adapter reports; only the durable
 * disposition the outbox commits on it moves a delivery. An unknown outcome is
 * retried only when the delivery carries external idempotency evidence and its
 * policy allows it; otherwise it is parked or dead-lettered, never duplicated.
 *
 * @module core/outbox
 */

import type { Storage } from '../storage/interface.ts';
import {
  attemptControllerRegistry,
  releaseAttemptControllerRegistry,
} from './application-primitive-attempt-registry.ts';
import type { JSONValue } from './json.ts';
import type {
  ApplicationDeliveryAdmission,
  ApplicationDeliveryCancellationResult,
  ApplicationDeliveryCleanupResult,
  ApplicationDeliveryHeartbeatResult,
  ApplicationDeliveryInput,
  ApplicationDeliveryOperatorResult,
  ApplicationDeliveryOutcome,
  ApplicationDeliveryReceipt,
  ApplicationDeliverySettleResult,
  OutboxCapacity,
  OutboxClaimResult,
  OutboxDeliverResult,
  OutboxDrainReport,
  OutboxListOptions,
  OutboxMaintenanceReport,
  OutboxOptions,
  OutboxWaitOptions,
} from './outbox-contract.ts';
import { claimNextDelivery } from './outbox-delivery.ts';
import { drainOutbox } from './outbox-drain.ts';
import { capacityOf, enqueueDelivery } from './outbox-enqueue.ts';
import {
  ApplicationDeliveryValidationError,
  requireClockInstant,
  requireMaintenanceInstant,
  validateCancellationReason,
  validateDeliveryIdentifier,
  validateDurableJSONValue,
} from './outbox-guards.ts';
import {
  OUTBOX_PRIMITIVE,
  toApplicationDeliveryReceipt,
  type OutboxRuntime,
} from './outbox-internals.ts';
import { listDeliveries } from './outbox-listing.ts';
import { runOutboxMaintenance } from './outbox-maintenance.ts';
import { deadLetterDelivery, retryDelivery } from './outbox-operations.ts';
import { deliverNext } from './outbox-runner.ts';
import {
  beginAttempt,
  heartbeatAttempt,
  readCleanupState,
  requestCancellation,
  settleAttempt,
} from './outbox-settlement.ts';
import { createOutboxKeys, loadDelivery, loadOutboxHeader } from './outbox-storage.ts';
import { resolveOutboxPolicy, validateOutcome } from './outbox-validation.ts';
import { waitForCleanup, waitForDueWork } from './outbox-waits.ts';

/**
 * Reject storage the outbox cannot be correct on. Every transition is a
 * compare-and-swap; the due index is read as a sorted scan whose earliest
 * genuine entry decides whether anything is due, which a best-effort scan can
 * miss; and maintenance and cleanup reconcile this process's live attempt
 * controllers against the record they read, releasing every attempt but the
 * one it names, so a read that lags another handle's commit could name a
 * stale attempt and abort a newer, current one underneath its transport.
 */
function requireOutboxStorage(storage: OutboxOptions['storage']): void {
  const capabilities = storage.capabilities();
  if (!capabilities.conditionalBatch) {
    throw new ApplicationDeliveryValidationError(
      'Application outboxes require storage with conditional batch support: every transition is a compare-and-swap.',
    );
  }
  if (capabilities.scanConsistency !== 'snapshot') {
    throw new ApplicationDeliveryValidationError(
      'Application outboxes require storage with snapshot scan consistency: claims read the earliest due entry, and a best-effort scan can miss one.',
    );
  }
  if (capabilities.readAfterWrite !== 'linearizable') {
    throw new ApplicationDeliveryValidationError(
      'Application outboxes require storage with linearizable read-after-write: maintenance reconciles live attempts against what it reads, and a stale read could abort a current one.',
    );
  }
}

/**
 * A durable, at-least-once application delivery outbox.
 *
 * @example
 * ```ts
 * import { Outbox, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * using outbox = new Outbox({
 *   storage,
 *   namespace: 'bureau',
 *   ownerId: 'agent-7',
 *   adapter: { async send() { return { status: 'acknowledged' }; } },
 * });
 *
 * const admission = await outbox.enqueue({
 *   destinationRef: 'webhook:orders',
 *   kind: 'order.shipped',
 *   payload: { form: 'inline', value: { orderId: 42 } },
 *   idempotencyKey: 'order-42-shipped',
 * });
 * console.log(admission.status); // 'enqueued'
 *
 * const delivered = await outbox.deliverNext();
 * console.log(delivered.status === 'settled' && delivered.receipt.state); // 'acknowledged'
 * ```
 */
export class Outbox {
  readonly #runtime: OutboxRuntime;
  readonly #disposal = new AbortController();
  /** Attempt tokens this handle claimed, so disposal aborts only its own work. */
  readonly #ownAttempts = new Set<string>();
  #maintenanceCursor: string | undefined;
  #maintenanceTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: OutboxOptions) {
    const policy = resolveOutboxPolicy(options);
    requireOutboxStorage(options.storage);
    if (options.adapter !== undefined && typeof options.adapter.send !== 'function') {
      throw new ApplicationDeliveryValidationError('adapter must expose a send() function.');
    }
    if (
      options.onMaintenanceError !== undefined &&
      typeof options.onMaintenanceError !== 'function'
    ) {
      throw new ApplicationDeliveryValidationError('onMaintenanceError must be a function.');
    }
    this.#runtime = {
      storage: options.storage,
      events: options.events,
      adapter: options.adapter,
      policy,
      keys: createOutboxKeys(policy.namespace, policy.ownerId),
      now: () => requireClockInstant((options.now ?? Date.now)()),
      generateId: options.generateId ?? (() => crypto.randomUUID()),
      disposal: this.#disposal.signal,
      attemptControllers: attemptControllerRegistry(
        options.storage,
        OUTBOX_PRIMITIVE,
        policy.namespace,
        policy.ownerId,
      ),
      adoptAttempt: (attemptToken) => {
        if (this.#disposed) return null;
        this.#ownAttempts.add(attemptToken);
        return () => {
          this.#ownAttempts.delete(attemptToken);
        };
      },
      readMaintenanceCursor: () => this.#maintenanceCursor,
      writeMaintenanceCursor: (cursor) => {
        this.#maintenanceCursor = cursor;
      },
    };
    if (policy.backgroundTasks === 'automatic') {
      this.#scheduleMaintenance(options.onMaintenanceError ?? defaultMaintenanceErrorSink);
    }
  }

  /**
   * One self-rescheduling maintenance timer, never an overlapping interval: the
   * next pass is armed only after the current one settles, and `dispose()`
   * clears whichever timer is pending.
   */
  #scheduleMaintenance(onError: (error: unknown) => void): void {
    const tick = async (): Promise<void> => {
      this.#maintenanceTimer = null;
      if (this.#disposed) return;
      try {
        await runOutboxMaintenance(this.#runtime, this.#runtime.now());
      } catch (error) {
        // A pass cut short by disposal is not a failure worth reporting, and
        // `onError` itself may throw; a background pass must never become an
        // unhandled rejection.
        if (this.#disposed) return;
        try {
          onError(error);
        } catch {
          // Deliberately swallowed: there is nowhere left to report to.
        }
      }
      if (!this.#disposed) arm();
    };
    const arm = (): void => {
      this.#maintenanceTimer = setTimeout(() => {
        void tick();
      }, this.#runtime.policy.maintenanceIntervalMs);
      this.#maintenanceTimer.unref?.();
    };
    arm();
  }

  /** The opaque application namespace this outbox is scoped to. */
  get namespace(): string {
    return this.#runtime.policy.namespace;
  }

  /** The opaque owner identifier this outbox is scoped to. */
  get ownerId(): string {
    return this.#runtime.policy.ownerId;
  }

  /** The durable backend every transition compares and swaps against. */
  get storage(): Storage {
    return this.#runtime.storage;
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new ApplicationDeliveryValidationError('This application outbox has been disposed.');
    }
  }

  /**
   * Offer a delivery. An exact retry of the same idempotency identity returns
   * the original receipt; a reused key with a different destination, kind, or
   * payload returns a conflict; a full backlog is rejected before any write.
   */
  async enqueue(delivery: ApplicationDeliveryInput): Promise<ApplicationDeliveryAdmission> {
    this.#assertLive();
    return enqueueDelivery(this.#runtime, delivery);
  }

  /** Read one delivery's immutable receipt, or `null` when it is unknown or retired. */
  async receipt(deliveryId: string): Promise<ApplicationDeliveryReceipt | null> {
    this.#assertLive();
    const loaded = await loadDelivery(
      this.#runtime.storage,
      this.#runtime.keys,
      validateDeliveryIdentifier(deliveryId),
    );
    return loaded === null ? null : toApplicationDeliveryReceipt(loaded.record);
  }

  /** List receipts in enqueue order, bounded and non-consuming. */
  async list(options?: OutboxListOptions): Promise<ApplicationDeliveryReceipt[]> {
    this.#assertLive();
    return listDeliveries(this.#runtime, options);
  }

  /** Current backlog accounting. Counts only. */
  async capacity(): Promise<OutboxCapacity> {
    this.#assertLive();
    const header = await loadOutboxHeader(
      this.#runtime.storage,
      this.#runtime.keys,
      this.#runtime.policy.namespace,
      this.#runtime.policy.ownerId,
    );
    return capacityOf(this.#runtime, header.record.openCount, header.record.enqueuedCount);
  }

  /**
   * Lease the earliest due delivery to one attempt, for a host that drives the
   * transport itself. Call `beginAttempt()` before sending and `settle()`
   * after; heartbeat in between.
   */
  async claim(options?: { readonly signal?: AbortSignal | undefined }): Promise<OutboxClaimResult> {
    this.#assertLive();
    return claimNextDelivery(this.#runtime, options);
  }

  /** Durably mark the current attempt as about to call the transport. */
  async beginAttempt(options: {
    readonly deliveryId: string;
    readonly attemptToken: string;
  }): Promise<ApplicationDeliverySettleResult> {
    this.#assertLive();
    return beginAttempt(this.#runtime, {
      deliveryId: validateDeliveryIdentifier(options.deliveryId),
      attemptToken: options.attemptToken,
    });
  }

  /** Record liveness and extend visibility, clamped to the fixed attempt deadline. */
  async heartbeat(options: {
    readonly deliveryId: string;
    readonly attemptToken: string;
    readonly transportActivity?: JSONValue | undefined;
  }): Promise<ApplicationDeliveryHeartbeatResult> {
    this.#assertLive();
    return heartbeatAttempt(this.#runtime, {
      deliveryId: validateDeliveryIdentifier(options.deliveryId),
      attemptToken: options.attemptToken,
      transportActivity: validateDurableJSONValue(options.transportActivity, 'transportActivity'),
    });
  }

  /**
   * Settle the current attempt on what the transport reported. A malformed
   * outcome is treated as `unknown`, never as a retry.
   */
  async settle(options: {
    readonly deliveryId: string;
    readonly attemptToken: string;
    readonly outcome: ApplicationDeliveryOutcome;
  }): Promise<ApplicationDeliverySettleResult> {
    this.#assertLive();
    return settleAttempt(this.#runtime, {
      deliveryId: validateDeliveryIdentifier(options.deliveryId),
      attemptToken: options.attemptToken,
      outcome: validateOutcome(options.outcome),
    });
  }

  /** Claim, begin, send through the configured adapter, and settle one delivery. */
  async deliverNext(options?: {
    readonly signal?: AbortSignal | undefined;
  }): Promise<OutboxDeliverResult> {
    this.#assertLive();
    return deliverNext(this.#runtime, options);
  }

  /**
   * Deliver everything due within a bounded budget, running maintenance
   * between rounds. Reports counts only; `pending` is what the durable header
   * still holds open when the drain stops.
   */
  async drain(options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly pollIntervalMs?: number | undefined;
  }): Promise<OutboxDrainReport> {
    this.#assertLive();
    return drainOutbox(this.#runtime, options);
  }

  /** Durably request cancellation and abort an in-process attempt. */
  async requestCancellation(options: {
    readonly deliveryId: string;
    readonly reason?: string | undefined;
  }): Promise<ApplicationDeliveryCancellationResult> {
    this.#assertLive();
    return requestCancellation(this.#runtime, {
      deliveryId: validateDeliveryIdentifier(options.deliveryId),
      reason: validateCancellationReason(options.reason),
    });
  }

  /** Read whether a cancelled delivery's attempt has finished. Non-consuming. */
  async cleanupState(deliveryId: string): Promise<ApplicationDeliveryCleanupResult> {
    this.#assertLive();
    return readCleanupState(this.#runtime, validateDeliveryIdentifier(deliveryId));
  }

  /** Wait, bounded, for a cancelled delivery's attempt to settle. */
  async awaitCleanup(options: {
    readonly deliveryId: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly pollIntervalMs?: number | undefined;
  }): Promise<ApplicationDeliveryCleanupResult> {
    this.#assertLive();
    return waitForCleanup(this.#runtime, {
      ...options,
      deliveryId: validateDeliveryIdentifier(options.deliveryId),
    });
  }

  /** Return a parked, dead-lettered, or rejected delivery to the queue with at least one more attempt: an unspent budget is kept, a spent one is raised by one. */
  async retry(options: {
    readonly deliveryId: string;
  }): Promise<ApplicationDeliveryOperatorResult> {
    this.#assertLive();
    return retryDelivery(this.#runtime, validateDeliveryIdentifier(options.deliveryId));
  }

  /** Close a parked `unknown-outcome` delivery as dead-lettered. */
  async deadLetter(options: {
    readonly deliveryId: string;
    readonly reason?: string | undefined;
  }): Promise<ApplicationDeliveryOperatorResult> {
    this.#assertLive();
    return deadLetterDelivery(
      this.#runtime,
      validateDeliveryIdentifier(options.deliveryId),
      validateCancellationReason(options.reason),
    );
  }

  /**
   * Wait, bounded and abortably, until a delivery is due. `timeoutMs` defaults
   * to `0`: one check, no wait.
   */
  async waitForDue(options?: OutboxWaitOptions): Promise<boolean> {
    this.#assertLive();
    return waitForDueWork(this.#runtime, options);
  }

  /**
   * Run one bounded maintenance pass: recover lapsed leases and retire
   * terminal receipts past retention. Under `backgroundTasks: 'manual'` this is
   * the only thing that advances time-driven recovery.
   */
  async runMaintenance(now = this.#runtime.now()): Promise<OutboxMaintenanceReport> {
    this.#assertLive();
    return runOutboxMaintenance(this.#runtime, requireMaintenanceInstant(now));
  }

  /**
   * Release every process-local resource: the maintenance timer, in-flight
   * waits, and every attempt-scoped signal this handle holds. Disposal never
   * deletes durable work; a claim this process held stays leased until it
   * lapses and maintenance recovers it.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#maintenanceTimer !== null) {
      clearTimeout(this.#maintenanceTimer);
      this.#maintenanceTimer = null;
    }
    for (const attemptToken of this.#ownAttempts) {
      const registration = this.#runtime.attemptControllers.get(attemptToken);
      if (registration === undefined) continue;
      this.#runtime.attemptControllers.delete(attemptToken);
      if (!registration.controller.signal.aborted) {
        registration.controller.abort(
          new Error('The application outbox was disposed while this attempt was open.'),
        );
      }
    }
    this.#ownAttempts.clear();
    this.#disposal.abort(new Error('The application outbox was disposed.'));
    releaseAttemptControllerRegistry(
      this.#runtime.storage,
      OUTBOX_PRIMITIVE,
      this.#runtime.policy.namespace,
      this.#runtime.policy.ownerId,
    );
  }

  /** `using`-compatible disposal. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

function defaultMaintenanceErrorSink(error: unknown): void {
  console.error('Application outbox maintenance failed:', error);
}
