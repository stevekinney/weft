/**
 * The durable application command mailbox (WFT-84).
 *
 * A mailbox is a storage-backed, strictly FIFO command queue scoped to one
 * opaque `(namespace, resourceId)` pair. Admission returns a durable receipt
 * that survives process restart; delivery is attempt-fenced so two consumers
 * can never both hold a valid claim; cancellation is durable before it reaches
 * anyone; and every state transition commits atomically with its fleet event
 * when an event sink is configured.
 *
 * What it is not: a message broker. There are no topics, no consumer groups, no
 * cross-mailbox ordering, and no cross-region replication. Ordering is defined
 * within one mailbox and nowhere else.
 *
 * @module core/application-mailbox
 */

import type { Storage } from '../storage/interface.ts';
import {
  decodeApplicationCommandRecord,
  encodeApplicationCommandIdempotencyRecord,
} from './application-mailbox-codec.ts';
import type {
  ApplicationCommandAdmission,
  ApplicationCommandCancellationResult,
  ApplicationCommandCleanupResult,
  ApplicationCommandInput,
  ApplicationCommandReceipt,
  ApplicationCommandRenewalResult,
  ApplicationCommandSettleResult,
  ApplicationMailboxCapacity,
  ApplicationMailboxClaimResult,
  ApplicationMailboxListOptions,
  ApplicationMailboxMaintenanceReport,
  ApplicationMailboxOptions,
  ApplicationMailboxWaitOptions,
} from './application-mailbox-contract.ts';
import { claimNextCommand } from './application-mailbox-delivery.ts';
import {
  ApplicationMailboxContentionError,
  describeCommandTransition,
  MAX_MAILBOX_TRANSITION_ATTEMPTS,
  toApplicationCommandReceipt,
  type MailboxRuntime,
} from './application-mailbox-internals.ts';
import { runMailboxMaintenance } from './application-mailbox-maintenance.ts';
import {
  acknowledgeClaim,
  readCleanupState,
  rejectClaim,
  renewClaim,
  requestCancellation,
} from './application-mailbox-settlement.ts';
import {
  commitMailboxTransition,
  createMailboxKeys,
  headerOperation,
  loadCommand,
  loadIdempotencyBinding,
  loadMailboxHeader,
  planCommandTransition,
} from './application-mailbox-storage.ts';
import { createAdmittedCommandRecord } from './application-mailbox-transitions.ts';
import {
  APPLICATION_MAILBOX_RECORD_VERSION,
  type ApplicationCommandFailure,
} from './application-mailbox-types.ts';
import {
  ApplicationCommandValidationError,
  clampListLimit,
  resolveMailboxPolicy,
  validateCommandInput,
} from './application-mailbox-validation.ts';
import { waitForAvailableWork, waitForCleanup } from './application-mailbox-waits.ts';
import { computeIdentityDigest } from './application-payload-digest.ts';
import type { JSONValue } from './json.ts';

/**
 * A durable, strictly FIFO application command mailbox.
 *
 * @example
 * ```ts
 * import { ApplicationMailbox, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * using mailbox = new ApplicationMailbox({ storage, namespace: 'bureau', resourceId: 'agent-7' });
 *
 * const admission = await mailbox.admit({
 *   caller: 'user:42',
 *   target: 'agent:7',
 *   kind: 'steer',
 *   payload: { form: 'inline', value: { text: 'stop' } },
 *   idempotencyKey: 'steer-1',
 * });
 * console.log(admission.status); // 'admitted'
 *
 * const claimed = await mailbox.claim();
 * console.log(claimed.status); // 'claimed'
 * ```
 */
export class ApplicationMailbox {
  readonly #runtime: MailboxRuntime;
  readonly #disposal = new AbortController();
  #disposed = false;

  constructor(options: ApplicationMailboxOptions) {
    const policy = resolveMailboxPolicy(options);
    if (!options.storage.capabilities().conditionalBatch) {
      throw new ApplicationCommandValidationError(
        'Application mailboxes require storage with conditional batch support: every transition is a compare-and-swap.',
      );
    }
    this.#runtime = {
      storage: options.storage,
      events: options.events,
      policy,
      keys: createMailboxKeys(policy.namespace, policy.resourceId),
      now: options.now ?? Date.now,
      generateId: options.generateId ?? (() => crypto.randomUUID()),
      attemptControllers: new Map(),
    };
  }

  /** The opaque application namespace this mailbox is scoped to. */
  get namespace(): string {
    return this.#runtime.policy.namespace;
  }

  /** The opaque resource identifier this mailbox is scoped to. */
  get resourceId(): string {
    return this.#runtime.policy.resourceId;
  }

  /** The durable backend every transition compares and swaps against. */
  get storage(): Storage {
    return this.#runtime.storage;
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new ApplicationCommandValidationError('This application mailbox has been disposed.');
    }
  }

  /**
   * Offer a command to the mailbox.
   *
   * An exact retry of the same idempotency identity returns the original
   * receipt without creating a second command. Reusing the key with a different
   * caller, target, kind, or payload digest returns a conflict and leaves the
   * original command untouched. A full backlog is rejected before anything is
   * persisted.
   */
  async admit(command: ApplicationCommandInput): Promise<ApplicationCommandAdmission> {
    this.#assertLive();
    const runtime = this.#runtime;
    const input = await validateCommandInput(command, runtime.policy);
    const identityDigest = await computeIdentityDigest([
      input.caller,
      input.target,
      input.kind,
      input.payloadDigest,
    ]);
    for (let attempt = 1; attempt <= MAX_MAILBOX_TRANSITION_ATTEMPTS; attempt += 1) {
      // The bytes this admission expects to find under the idempotency key:
      // `null` when the key is unused, or the stale binding's exact bytes when
      // retention retired the command it named. Requiring absence in the latter
      // case would make the key permanently unusable — the compare-and-swap
      // could never succeed against a binding nothing will ever delete.
      let expectedBinding: Uint8Array | null = null;
      if (input.idempotencyKey !== undefined) {
        const resolved = await this.#resolveIdempotency(input.idempotencyKey, identityDigest);
        if (resolved.admission !== null) return resolved.admission;
        expectedBinding = resolved.staleBindingBytes;
      }
      const header = await loadMailboxHeader(
        runtime.storage,
        runtime.keys,
        runtime.policy.namespace,
        runtime.policy.resourceId,
      );
      if (header.record.openCount >= runtime.policy.maxBacklog) {
        return {
          status: 'rejected',
          reason: 'backlog-full',
          capacity: this.#capacityOf(header.record.openCount, header.record.admittedCount),
        };
      }
      const now = runtime.now();
      const record = createAdmittedCommandRecord(input, {
        namespace: runtime.policy.namespace,
        resourceId: runtime.policy.resourceId,
        commandId: runtime.generateId(),
        sequence: header.record.nextSequence,
        now,
      });
      const committed = await commitMailboxTransition(
        runtime.storage,
        runtime.events,
        planCommandTransition(runtime.keys, {
          previous: null,
          expectedBytes: null,
          next: record,
          event: describeCommandTransition(null, record),
          now,
          extraConditions: [
            { key: runtime.keys.header, expectedValue: header.bytes },
            ...(input.idempotencyKey === undefined
              ? []
              : [
                  {
                    key: runtime.keys.idempotency(input.idempotencyKey),
                    expectedValue: expectedBinding,
                  },
                ]),
          ],
          extraOperations: [
            headerOperation(runtime.keys, {
              ...header.record,
              nextSequence: header.record.nextSequence + 1,
              openCount: header.record.openCount + 1,
              admittedCount: header.record.admittedCount + 1,
            }),
            ...(input.idempotencyKey === undefined
              ? []
              : [
                  {
                    type: 'put' as const,
                    key: runtime.keys.idempotency(input.idempotencyKey),
                    value: encodeApplicationCommandIdempotencyRecord({
                      recordVersion: APPLICATION_MAILBOX_RECORD_VERSION,
                      commandId: record.commandId,
                      identityDigest,
                    }),
                  },
                ]),
          ],
        }),
      );
      if (!committed) continue;
      return { status: 'admitted', receipt: toApplicationCommandReceipt(record) };
    }
    throw new ApplicationMailboxContentionError('admit', null);
  }

  /**
   * Resolve an idempotency key against durable state.
   *
   * Returns the admission to hand straight back when the key already names a
   * live command, or the exact bytes a stale binding holds so the caller can
   * overwrite it under a compare-and-swap.
   */
  async #resolveIdempotency(
    idempotencyKey: string,
    identityDigest: string,
  ): Promise<{
    admission: ApplicationCommandAdmission | null;
    staleBindingBytes: Uint8Array | null;
  }> {
    const binding = await loadIdempotencyBinding(
      this.#runtime.storage,
      this.#runtime.keys,
      idempotencyKey,
    );
    if (binding === null) return { admission: null, staleBindingBytes: null };
    const loaded = await loadCommand(
      this.#runtime.storage,
      this.#runtime.keys,
      binding.record.commandId,
    );
    // A binding whose command was retired by retention is spent, not a
    // conflict: the receipt it points at no longer exists, so a retry is
    // admitted afresh over the stale binding rather than answered with a
    // receipt this mailbox cannot produce.
    if (loaded === null) return { admission: null, staleBindingBytes: binding.bytes };
    const receipt = toApplicationCommandReceipt(loaded.record);
    if (binding.record.identityDigest !== identityDigest) {
      return {
        admission: { status: 'conflict', receipt, reason: 'idempotency-identity-mismatch' },
        staleBindingBytes: null,
      };
    }
    return { admission: { status: 'duplicate', receipt }, staleBindingBytes: null };
  }

  /** Read one command's immutable receipt, or `null` when it is unknown or retired. */
  async receipt(commandId: string): Promise<ApplicationCommandReceipt | null> {
    this.#assertLive();
    const loaded = await loadCommand(this.#runtime.storage, this.#runtime.keys, commandId);
    return loaded === null ? null : toApplicationCommandReceipt(loaded.record);
  }

  /**
   * List receipts in this mailbox, bounded and non-consuming.
   *
   * Listing never claims, starts, or advances work, so any number of observers
   * can call it concurrently without interfering with delivery.
   */
  async list(options?: ApplicationMailboxListOptions): Promise<ApplicationCommandReceipt[]> {
    this.#assertLive();
    const limit = clampListLimit(options?.limit);
    const states = options?.states === undefined ? null : new Set<string>(options.states);
    const receipts: ApplicationCommandReceipt[] = [];
    for await (const [key, value] of this.#runtime.storage.scan(this.#runtime.keys.commandPrefix)) {
      const record = decodeApplicationCommandRecord(value, key);
      if (states !== null && !states.has(record.state)) continue;
      receipts.push(toApplicationCommandReceipt(record));
    }
    // Command records are keyed by minted id, so scan order is arbitrary. Sort
    // to FIFO order BEFORE applying `limit`, or "the first N" would mean "N
    // arbitrary records". The scan itself is bounded by the backlog ceiling plus
    // whatever terminal receipts retention has not yet retired.
    return receipts.toSorted((left, right) => left.sequence - right.sequence).slice(0, limit);
  }

  #capacityOf(open: number, admitted: number): ApplicationMailboxCapacity {
    const limit = this.#runtime.policy.maxBacklog;
    return Object.freeze({ open, limit, remaining: Math.max(0, limit - open), admitted });
  }

  /** Current backlog accounting. Deliberately low-cardinality: counts only. */
  async capacity(): Promise<ApplicationMailboxCapacity> {
    this.#assertLive();
    const header = await loadMailboxHeader(
      this.#runtime.storage,
      this.#runtime.keys,
      this.#runtime.policy.namespace,
      this.#runtime.policy.resourceId,
    );
    return this.#capacityOf(header.record.openCount, header.record.admittedCount);
  }

  /**
   * Lease the FIFO head of this mailbox to one attempt.
   *
   * Strict FIFO is the contract: when the head is not due yet, `claim()` reports
   * `held` rather than skipping ahead to a later command. The returned claim
   * carries an attempt-scoped `AbortSignal` that fires on cancellation, lease
   * release, or mailbox disposal.
   */
  async claim(options?: {
    readonly signal?: AbortSignal | undefined;
  }): Promise<ApplicationMailboxClaimResult> {
    this.#assertLive();
    return claimNextCommand(this.#runtime, options);
  }

  /** Extend a lease and report liveness for the current attempt. */
  async renew(options: {
    readonly commandId: string;
    readonly attemptToken: string;
    readonly progress?: JSONValue | undefined;
  }): Promise<ApplicationCommandRenewalResult> {
    this.#assertLive();
    return renewClaim(this.#runtime, { ...options, now: this.#runtime.now() });
  }

  /** Settle a claimed command successfully. */
  async acknowledge(options: {
    readonly commandId: string;
    readonly attemptToken: string;
    readonly outcome?: JSONValue | undefined;
  }): Promise<ApplicationCommandSettleResult> {
    this.#assertLive();
    return acknowledgeClaim(this.#runtime, { ...options, now: this.#runtime.now() });
  }

  /** Settle a claimed command as failed, optionally scheduling a retry. */
  async reject(options: {
    readonly commandId: string;
    readonly attemptToken: string;
    readonly failure: ApplicationCommandFailure;
    readonly retry?: boolean | undefined;
  }): Promise<ApplicationCommandSettleResult> {
    this.#assertLive();
    return rejectClaim(this.#runtime, {
      commandId: options.commandId,
      attemptToken: options.attemptToken,
      failure: options.failure,
      retry: options.retry ?? false,
      now: this.#runtime.now(),
    });
  }

  /** Durably request cancellation and abort an in-process claimant. */
  async requestCancellation(options: {
    readonly commandId: string;
    readonly reason?: string | undefined;
  }): Promise<ApplicationCommandCancellationResult> {
    this.#assertLive();
    return requestCancellation(this.#runtime, { ...options, now: this.#runtime.now() });
  }

  /**
   * Read whether a cancelled command's claimant has finished. Non-consuming and
   * safe to call from any number of observers.
   */
  async cleanupState(commandId: string): Promise<ApplicationCommandCleanupResult> {
    this.#assertLive();
    return readCleanupState(this.#runtime, commandId);
  }

  /**
   * Wait, bounded, for a cancelled command's claimant to settle.
   *
   * A `pending` result means this mailbox stopped waiting — never that the
   * handler stopped.
   */
  async awaitCleanup(options: {
    readonly commandId: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly pollIntervalMs?: number | undefined;
  }): Promise<ApplicationCommandCleanupResult> {
    this.#assertLive();
    return waitForCleanup(this.#runtime, this.#disposal.signal, options);
  }

  /**
   * Wait, bounded and abortably, until this mailbox has work due for delivery.
   *
   * Returns `true` when the FIFO head is claimable. Aborting, disposal, or the
   * timeout returns `false` and releases every process-local resource without
   * touching durable work.
   */
  async waitForAvailable(options?: ApplicationMailboxWaitOptions): Promise<boolean> {
    this.#assertLive();
    return waitForAvailableWork(this.#runtime, this.#disposal.signal, options);
  }

  /**
   * Run one bounded maintenance pass: release due commands, reclaim expired
   * leases at their original FIFO position, dead-letter commands past their
   * absolute deadline, and retire terminal receipts past retention.
   *
   * Nothing in this mailbox runs on a hidden timer, so a host configured with
   * `backgroundTasks: 'manual'` drives every time-based transition through this
   * one call.
   */
  async runMaintenance(now = this.#runtime.now()): Promise<ApplicationMailboxMaintenanceReport> {
    this.#assertLive();
    return runMailboxMaintenance(this.#runtime, now);
  }

  /**
   * Release every process-local resource: abort in-flight waits and every
   * attempt-scoped signal this process holds.
   *
   * Disposal never deletes durable work. A claim this process held stays leased
   * until its visibility expires and maintenance reclaims it.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const controller of this.#runtime.attemptControllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort(
          new Error('The application mailbox was disposed while this attempt was open.'),
        );
      }
    }
    this.#runtime.attemptControllers.clear();
    this.#disposal.abort(new Error('The application mailbox was disposed.'));
  }

  /** `using`-compatible disposal. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
