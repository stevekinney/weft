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
import { admitCommand, capacityOf } from './application-mailbox-admission.ts';
import type {
  ApplicationCommandAdmission,
  ApplicationCommandCancellationResult,
  ApplicationCommandCleanupResult,
  ApplicationCommandInput,
  ApplicationCommandReceipt,
  ApplicationCommandRejection,
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
import { decodeApplicationReadyEntry } from './application-mailbox-index-codec.ts';
import {
  attemptControllerRegistry,
  releaseAttemptControllerRegistry,
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
  createMailboxKeys,
  loadCommand,
  loadMailboxHeader,
} from './application-mailbox-storage.ts';
import {
  ApplicationCommandValidationError,
  clampListLimit,
  requireClockInstant,
  requireMaintenanceInstant,
  resolveMailboxPolicy,
  validateCancellationReason,
  validateCommandIdentifier,
  validateDurableJSONValue,
  validateFailure,
} from './application-mailbox-validation.ts';
import { waitForAvailableWork, waitForCleanup } from './application-mailbox-waits.ts';
import type { JSONValue } from './json.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

/** How many listing-index entries one page of `list()` reads. */
const MAILBOX_LIST_PAGE_SIZE = 200;

/**
 * How many index entries one `list()` call may examine before giving up.
 *
 * `limit` bounds the work only when enough records match. A narrow filter such as
 * `{ limit: 1, states: ['claimed'] }` against a mailbox full of terminal records
 * would otherwise walk every entry and load every record to return an empty
 * array. Listing is documented as a bounded query, not an exhaustive one: it
 * returns what it found within this ceiling.
 */
const MAILBOX_LIST_SCAN_CEILING = 5_000;

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
  /** Attempt tokens this handle claimed, so disposal aborts only its own work. */
  readonly #ownAttempts = new Set<string>();
  /** Where the last capped maintenance pass stopped, so the next one resumes there. */
  #maintenanceCursor: string | undefined;
  #disposed = false;

  constructor(options: ApplicationMailboxOptions) {
    const policy = resolveMailboxPolicy(options);
    const capabilities = options.storage.capabilities();
    if (!capabilities.conditionalBatch) {
      throw new ApplicationCommandValidationError(
        'Application mailboxes require storage with conditional batch support: every transition is a compare-and-swap.',
      );
    }
    // Strict FIFO is decided by reading the lowest key in the delivery index. A
    // best-effort scan can miss an earlier entry that a concurrent write is still
    // landing, and the compare-and-swap fences only the command actually
    // returned — so a later command could commit ahead of an earlier one and the
    // advertised ordering would be silently false.
    if (capabilities.scanConsistency !== 'snapshot') {
      throw new ApplicationCommandValidationError(
        'Application mailboxes require storage with snapshot scan consistency: strict FIFO delivery reads the index head, and a best-effort scan can return a later command ahead of an earlier one.',
      );
    }
    // Strict FIFO also needs every consumer to see every admission as soon as it
    // is durable. Session-consistent reads let a second process scan a snapshot
    // that omits sequence 0 while it already contains sequence 1, and the
    // compare-and-swap fences only the command it returned.
    if (capabilities.readAfterWrite !== 'linearizable') {
      throw new ApplicationCommandValidationError(
        'Application mailboxes require storage with linearizable read-after-write: strict FIFO delivery across processes needs every consumer to see every durable admission.',
      );
    }
    this.#runtime = {
      storage: options.storage,
      events: options.events,
      policy,
      keys: createMailboxKeys(policy.namespace, policy.resourceId),
      // Validate at the source rather than at each call site: every transition
      // derives durable timestamps from this, and a clock returning `NaN` or
      // `Infinity` would write records the decoder rejects — an `admitted`
      // receipt naming a command that blocks the FIFO as corrupt.
      now: () => requireClockInstant((options.now ?? Date.now)()),
      generateId: options.generateId ?? (() => crypto.randomUUID()),
      attemptControllers: attemptControllerRegistry(
        options.storage,
        policy.namespace,
        policy.resourceId,
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
    return admitCommand(this.#runtime, command);
  }

  /** Read one command's immutable receipt, or `null` when it is unknown or retired. */
  async receipt(commandId: string): Promise<ApplicationCommandReceipt | null> {
    this.#assertLive();
    const loaded = await loadCommand(
      this.#runtime.storage,
      this.#runtime.keys,
      validateCommandIdentifier(commandId),
    );
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
    // Walk the sequence index, not the command records. Records are keyed by
    // minted id and so scan in arbitrary order, which would force reading and
    // sorting the whole mailbox to answer even `limit: 1`. The index is already
    // in FIFO order, so `limit` bounds the storage reads and the allocation
    // rather than only the returned slice.
    let cursor: string | undefined;
    let examined = 0;
    while (receipts.length < limit && examined < MAILBOX_LIST_SCAN_CEILING) {
      const page = await this.#readListingPage(cursor, limit - receipts.length, states);
      receipts.push(...page.receipts);
      examined += page.examined;
      cursor = page.cursor;
      if (page.exhausted) break;
    }
    return receipts;
  }

  /** One bounded page of the sequence-ordered listing index. */
  async #readListingPage(
    cursor: string | undefined,
    remaining: number,
    states: ReadonlySet<string> | null,
  ): Promise<{
    receipts: ApplicationCommandReceipt[];
    cursor: string | undefined;
    exhausted: boolean;
    examined: number;
  }> {
    const receipts: ApplicationCommandReceipt[] = [];
    const scanOptions =
      cursor === undefined
        ? { limit: MAILBOX_LIST_PAGE_SIZE }
        : { limit: MAILBOX_LIST_PAGE_SIZE, gt: cursor };
    let seen = 0;
    let nextCursor = cursor;
    for await (const [indexKey, indexValue] of this.#runtime.storage.scan(
      this.#runtime.keys.bySequencePrefix,
      scanOptions,
    )) {
      seen += 1;
      nextCursor = indexKey;
      const commandId = decodeApplicationReadyEntry(indexValue, indexKey);
      const loaded = await loadCommand(this.#runtime.storage, this.#runtime.keys, commandId);
      // An index entry whose record is already gone is a retention race, not
      // corruption: the sweep deletes the record and the entry together, and a
      // concurrent listing can observe the moment between.
      if (loaded === null) continue;
      // The entry must be the one the record's own sequence names; a stale or
      // corrupted entry elsewhere would list the command at the wrong position
      // and again at its real one.
      if (indexKey !== this.#runtime.keys.bySequence(loaded.record.sequence)) {
        throw new PersistedDataCorruptError(indexKey);
      }
      if (states !== null && !states.has(loaded.record.state)) continue;
      receipts.push(toApplicationCommandReceipt(loaded.record));
      if (receipts.length >= remaining) break;
    }
    return {
      receipts,
      cursor: nextCursor,
      exhausted: seen < MAILBOX_LIST_PAGE_SIZE,
      examined: seen,
    };
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
    return capacityOf(this.#runtime, header.record.openCount, header.record.admittedCount);
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
    return renewClaim(this.#runtime, {
      commandId: validateCommandIdentifier(options.commandId),
      attemptToken: options.attemptToken,
      progress: validateDurableJSONValue(options.progress, 'progress'),
    });
  }

  /** Settle a claimed command successfully. */
  async acknowledge(options: {
    readonly commandId: string;
    readonly attemptToken: string;
    readonly outcome?: JSONValue | undefined;
  }): Promise<ApplicationCommandSettleResult> {
    this.#assertLive();
    return acknowledgeClaim(this.#runtime, {
      commandId: validateCommandIdentifier(options.commandId),
      attemptToken: options.attemptToken,
      outcome: validateDurableJSONValue(options.outcome, 'outcome'),
    });
  }

  /** Settle a claimed command as failed, optionally scheduling a retry. */
  async reject(options: {
    readonly commandId: string;
    readonly attemptToken: string;
    readonly failure: ApplicationCommandRejection;
    readonly retry?: boolean | undefined;
  }): Promise<ApplicationCommandSettleResult> {
    this.#assertLive();
    return rejectClaim(this.#runtime, {
      commandId: validateCommandIdentifier(options.commandId),
      attemptToken: options.attemptToken,
      failure: validateFailure(options.failure),
      retry: options.retry ?? false,
    });
  }

  /** Durably request cancellation and abort an in-process claimant. */
  async requestCancellation(options: {
    readonly commandId: string;
    readonly reason?: string | undefined;
  }): Promise<ApplicationCommandCancellationResult> {
    this.#assertLive();
    return requestCancellation(this.#runtime, {
      commandId: validateCommandIdentifier(options.commandId),
      reason: validateCancellationReason(options.reason),
    });
  }

  /**
   * Read whether a cancelled command's claimant has finished. Non-consuming and
   * safe to call from any number of observers.
   */
  async cleanupState(commandId: string): Promise<ApplicationCommandCleanupResult> {
    this.#assertLive();
    return readCleanupState(this.#runtime, validateCommandIdentifier(commandId));
  }

  /**
   * Wait, bounded, for a cancelled command's claimant to settle.
   *
   * A `pending` result means this mailbox stopped waiting — never that the
   * handler stopped. A caller signal that aborts at any point — before a read,
   * during one, or during the sleep between polls — rejects the wait with that
   * signal's reason; disposing the mailbox during a read rejects with the
   * disposal error, and during a sleep returns the last observation. The
   * budget bounds the reads themselves as well as the sleeps between them: a
   * budget that runs out during a later read returns the last observation, and
   * one that runs out during the first read, with nothing observed yet,
   * rejects with `WaitBudgetElapsedError`.
   */
  async awaitCleanup(options: {
    readonly commandId: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly pollIntervalMs?: number | undefined;
  }): Promise<ApplicationCommandCleanupResult> {
    this.#assertLive();
    return waitForCleanup(this.#runtime, this.#disposal.signal, {
      ...options,
      commandId: validateCommandIdentifier(options.commandId),
    });
  }

  /**
   * Wait, bounded and abortably, until this mailbox has work due for delivery.
   *
   * Returns `true` when the FIFO head is claimable. Aborting, disposal, or the
   * timeout returns `false` and releases every process-local resource without
   * touching durable work.
   *
   * `timeoutMs` defaults to `0`, so calling this with no options checks once and
   * returns immediately rather than blocking. Pass a timeout to actually wait.
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
    return runMailboxMaintenance(this.#runtime, requireMaintenanceInstant(now));
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
    // Only this handle's own attempts. The registry is shared with sibling
    // handles onto the same mailbox, and disposing one handle must not abort a
    // claim another handle is still working.
    for (const attemptToken of this.#ownAttempts) {
      const registration = this.#runtime.attemptControllers.get(attemptToken);
      if (registration === undefined) continue;
      this.#runtime.attemptControllers.delete(attemptToken);
      if (!registration.controller.signal.aborted) {
        registration.controller.abort(
          new Error('The application mailbox was disposed while this attempt was open.'),
        );
      }
    }
    this.#ownAttempts.clear();
    this.#disposal.abort(new Error('The application mailbox was disposed.'));
    releaseAttemptControllerRegistry(
      this.#runtime.storage,
      this.#runtime.policy.namespace,
      this.#runtime.policy.resourceId,
    );
  }

  /** `using`-compatible disposal. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
