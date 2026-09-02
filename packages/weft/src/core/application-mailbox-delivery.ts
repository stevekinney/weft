/**
 * Delivery for the application command mailbox (WFT-84): leasing the FIFO head
 * to one attempt and handing that attempt a digest-verified payload.
 *
 * Strict FIFO is the ordering contract. A claim only ever considers the
 * lowest-sequence entry in the delivery index, so a later command never
 * overtakes a delayed head — `claim()` reports `held` instead of skipping
 * ahead. That also means head-of-line blocking is real and intended: a command
 * in retry backoff holds its resource's queue until it is due or dead-lettered.
 *
 * @module core/application-mailbox-delivery
 */

import { storageConditionalBatch } from '../storage/interface.ts';
import { raceAbort } from './application-mailbox-abort.ts';
import type {
  ApplicationCommandClaimedPayload,
  ApplicationMailboxClaimResult,
  LoadedCommandRecord,
} from './application-mailbox-contract.ts';
import {
  ApplicationMailboxContentionError,
  MAX_MAILBOX_TRANSITION_ATTEMPTS,
  commitCommandTransition,
  nextLeaseCommitSerial,
  toApplicationCommandReceipt,
  type AttemptRegistration,
  type MailboxRuntime,
} from './application-mailbox-internals.ts';
import { isWaitingState, loadCommand, loadDeliveryHead } from './application-mailbox-storage.ts';
import { recoverExpiredCommand } from './application-mailbox-transitions-recovery.ts';
import { claimWaitingCommand } from './application-mailbox-transitions.ts';
import type { ApplicationCommandRecord } from './application-mailbox-types.ts';
import {
  requireClockInstant,
  requireGeneratedIdentifier,
} from './application-mailbox-validation.ts';
import { computePayloadDigest } from './application-payload-digest.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

/** Process-local claim serial folded into every attempt token; see `leaseHead`. */
let localClaimSerial = 0;

/**
 * Recompute an inline payload's digest and fail closed on a mismatch.
 *
 * A reference payload cannot be verified here — Weft never dereferences the
 * locator — so the consumer receives the stored digest and `verified: false`
 * rather than a guarantee the mailbox cannot back up.
 *
 * @throws {PersistedDataCorruptError} When a stored inline payload no longer
 * matches the digest admission recorded for it.
 */
export async function verifyClaimedPayload(
  runtime: MailboxRuntime,
  record: ApplicationCommandRecord,
): Promise<ApplicationCommandClaimedPayload> {
  if (record.payload.form === 'reference') {
    return {
      form: 'reference',
      reference: record.payload.reference,
      digest: record.payload.digest,
      byteLength: record.payload.byteLength,
      verified: false,
    };
  }
  const digest = await computePayloadDigest(record.payload.value);
  if (digest !== record.payloadDigest) {
    throw new PersistedDataCorruptError(runtime.keys.command(record.commandId));
  }
  return { form: 'inline', value: record.payload.value, digest, verified: true };
}

/**
 * Whether a delivery-index entry no longer describes a claimable head: its
 * record is gone or has moved on, or the entry's key is not the one the
 * record's own sequence names. The last case is a stale or corrupted entry
 * pointing at a real waiting command; claiming through it would deliver that
 * command out of FIFO order and delete its genuine entry while leaving the
 * false one behind.
 */
function isOrphanedEntry(
  runtime: MailboxRuntime,
  head: { readonly key: string },
  loaded: LoadedCommandRecord,
): boolean {
  return !isWaitingState(loaded.record) || head.key !== runtime.keys.ready(loaded.record.sequence);
}

/**
 * Remove a delivery-index entry that outlived the record it pointed at.
 *
 * Guarded by a compare-and-swap on the entry's own bytes so a concurrent
 * consumer that re-added the entry is never clobbered.
 */
async function discardOrphanedEntry(
  runtime: MailboxRuntime,
  head: { readonly key: string; readonly bytes: Uint8Array; readonly commandId: string },
  observed: LoadedCommandRecord | null,
): Promise<void> {
  // Fence on the COMMAND record as well as the index entry. The entry's value is
  // just the command id and never changes, so a compare-and-swap on it alone is
  // an ABA hazard: this reader sees the entry, another consumer claims the
  // command, maintenance reclaims the lease and re-adds a byte-identical entry,
  // and this stale delete then removes a newly valid one. The record would stay
  // `accepted`/`available` with no index entry, and because maintenance treats
  // both as waiting it would never restore it — the command would be lost from
  // the FIFO permanently.
  await storageConditionalBatch(
    runtime.storage,
    [
      { key: head.key, expectedValue: head.bytes },
      {
        key: runtime.keys.command(head.commandId),
        expectedValue: observed === null ? null : observed.bytes,
      },
    ],
    [{ type: 'delete', key: head.key }],
  );
}

/**
 * Dead-letter a delivery-index head that outlived its absolute command deadline.
 *
 * A lost compare-and-swap is not an error here: another actor terminalized the
 * same record, which is the outcome this wanted anyway.
 */
async function terminalizeExpiredHead(
  runtime: MailboxRuntime,
  loaded: LoadedCommandRecord,
  now: number,
): Promise<void> {
  const transition = recoverExpiredCommand(loaded.record, {
    now,
    retryBackoffMs: runtime.policy.retryBackoffMs,
    maxRetryBackoffMs: runtime.policy.maxRetryBackoffMs,
  });
  if (!transition.ok) return;
  await commitCommandTransition(runtime, {
    previous: loaded.record,
    expectedBytes: loaded.bytes,
    next: transition.next,
    now,
  });
}

/**
 * What the delivery index's head currently offers.
 *
 * Resolving this separately from the claim keeps every reason a head is not
 * claimable — gone, not yet due, past its deadline — in one place rather than
 * interleaved with the compare-and-swap loop.
 */
type DeliverableHead =
  | { readonly status: 'claimable'; readonly loaded: LoadedCommandRecord }
  | { readonly status: 'empty' }
  | { readonly status: 'held'; readonly availableAt: number }
  /** The head could not be used and the caller should look again. */
  | { readonly status: 'retry' };

async function resolveDeliverableHead(
  runtime: MailboxRuntime,
  now: number,
): Promise<DeliverableHead> {
  const head = await loadDeliveryHead(runtime.storage, runtime.keys);
  if (head === null) return { status: 'empty' };
  const loaded = await loadCommand(runtime.storage, runtime.keys, head.commandId);
  if (loaded === null || isOrphanedEntry(runtime, head, loaded)) {
    await discardOrphanedEntry(runtime, head, loaded);
    return { status: 'retry' };
  }
  // The deadline outranks availability, and the order matters. A head in retry
  // backoff whose deadline already passed can never come due, so checking
  // availability first would report `held` forever and — under
  // `backgroundTasks: 'manual'`, where nothing else runs — block the mailbox on
  // a command no maintenance pass was scheduled to clear.
  if (now >= loaded.record.absoluteDeadlineAt) {
    await terminalizeExpiredHead(runtime, loaded, now);
    return { status: 'retry' };
  }
  if (now < loaded.record.availableAt) {
    // A head whose availability lies past its deadline becomes actionable AT
    // the deadline — `claim()` dead-letters it then and exposes what follows —
    // so a caller sleeping until `availableAt` would block the FIFO for longer
    // than the command's whole lifetime.
    return {
      status: 'held',
      availableAt: Math.min(loaded.record.availableAt, loaded.record.absoluteDeadlineAt),
    };
  }
  return { status: 'claimable', loaded };
}

/**
 * Take ownership of a freshly committed attempt and return its abort signal.
 *
 * Ownership and the disposal check happen in one synchronous step. Doing this in
 * the caller's `await` continuation instead would leave a window where
 * `dispose()` sees no owned attempt and the caller still receives a live signal
 * nothing can ever reach.
 */
function registerAttemptController(
  runtime: MailboxRuntime,
  attemptToken: string,
  commandId: string,
): { readonly controller: AbortController; readonly registration: AttemptRegistration | null } {
  const controller = new AbortController();
  const release = runtime.adoptAttempt(attemptToken);
  if (release === null) {
    controller.abort(new Error('The application mailbox was disposed while this claim committed.'));
    return { controller, registration: null };
  }
  const registration: AttemptRegistration = {
    controller,
    release,
    commandId,
    committedSerial: null,
  };
  runtime.attemptControllers.set(attemptToken, registration);
  return { controller, registration };
}

/**
 * Release a claim's own registration.
 *
 * Tokens are unique per claim invocation, so the published registration is
 * always this claim's; the identity check is a guard, not a branch anyone
 * relies on.
 */
function releaseOwnRegistration(
  runtime: MailboxRuntime,
  attemptToken: string,
  registration: AttemptRegistration | null,
  reason: string,
): void {
  if (registration === null) return;
  if (runtime.attemptControllers.get(attemptToken) === registration) {
    runtime.attemptControllers.delete(attemptToken);
  }
  registration.release();
  if (!registration.controller.signal.aborted) registration.controller.abort(new Error(reason));
}

/**
 * Lease the FIFO head of a mailbox to one attempt.
 *
 * The returned claim carries an attempt-scoped `AbortSignal` registered in this
 * process, so a cancellation request raised here reaches the claimant
 * immediately. A claimant in another process learns about cancellation from
 * `renew()` instead — the signal is process-local by construction.
 */
export async function claimNextCommand(
  runtime: MailboxRuntime,
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<ApplicationMailboxClaimResult> {
  // Only a lost compare-and-swap counts as contention. Housekeeping that
  // succeeded — an orphaned entry discarded, an expired head dead-lettered — is
  // durable progress on a backlog, and a long run of it (every head expired
  // during downtime, say) must not surface as a contention error.
  let losses = 0;
  while (losses < MAX_MAILBOX_TRANSITION_ATTEMPTS) {
    options?.signal?.throwIfAborted();
    const now = runtime.now();
    const head = await observeHead(runtime, now, options?.signal);
    if (head.status === 'empty') return { status: 'empty' };
    if (head.status === 'held') return { status: 'held', availableAt: head.availableAt };
    if (head.status === 'retry') continue;
    const claim = await leaseHead(runtime, head.loaded, options?.signal);
    if (claim !== null) return claim;
    losses += 1;
  }
  throw new ApplicationMailboxContentionError('claim', null);
}

/**
 * Dead-letter a lease whose commit completed past the absolute deadline.
 *
 * Losing the compare-and-swap here is fine: whoever won has either settled or
 * dead-lettered the attempt, and maintenance covers anything left over. The
 * caller releases the attempt's controller registration before calling this.
 */
async function deadLetterCommittedLease(runtime: MailboxRuntime, commandId: string): Promise<void> {
  const loaded = await loadCommand(runtime.storage, runtime.keys, commandId);
  if (loaded === null) return;
  const now = runtime.now();
  const transition = recoverExpiredCommand(loaded.record, {
    now,
    retryBackoffMs: runtime.policy.retryBackoffMs,
    maxRetryBackoffMs: runtime.policy.maxRetryBackoffMs,
  });
  if (!transition.ok) return;
  await commitCommandTransition(runtime, {
    previous: loaded.record,
    expectedBytes: loaded.bytes,
    next: transition.next,
    now,
  });
}

/**
 * Resolve the head while honouring the request signal.
 *
 * A caller that aborts while the index scan or the record read is stalled on
 * remote storage must not stay pending until storage answers, and an
 * observation that lands a moment before the abort must not turn into a normal
 * `empty` or `held` result that hides it.
 */
async function observeHead(
  runtime: MailboxRuntime,
  now: number,
  signal: AbortSignal | undefined,
): Promise<DeliverableHead> {
  const observed = await raceAbort(() => resolveDeliverableHead(runtime, now), signal);
  if (observed.aborted) throw observed.reason as Error;
  signal?.throwIfAborted();
  return observed.value;
}

/**
 * Verify the payload and commit the lease, or return `null` when the
 * compare-and-swap lost and the caller should look at the head again.
 */
async function leaseHead(
  runtime: MailboxRuntime,
  loaded: LoadedCommandRecord,
  requestSignal: AbortSignal | undefined,
): Promise<ApplicationMailboxClaimResult | null> {
  const payload = await verifyClaimedPayload(runtime, loaded.record);
  // Digest verification and the reads before it are asynchronous, so re-read the
  // clock: a claim that began just inside the deadline can cross it while the
  // payload is being verified, and committing on the stale reading would hand out
  // exactly the expired work the deadline check exists to prevent.
  const committedAt = requireClockInstant(runtime.now());
  // The caller may have abandoned the request during those awaits. Committing a
  // lease nobody is waiting for leaves durable work parked until maintenance
  // reclaims it.
  requestSignal?.throwIfAborted();
  // Prefix with the command's FIFO sequence and the attempt number so the token
  // is unique across the whole mailbox even if the injected generator repeats a
  // value. Fencing and the process-local controller registry must not depend on
  // the generator's quality: a repeated token would let a superseded claimant
  // settle the newer attempt, and two first claims on different commands would
  // share one registry entry.
  // The generated suffix is validated on its own, before the prefix is added, so
  // a generator returning a well-formed identifier at the byte ceiling — which
  // admission accepts — still yields a usable token rather than one every claim
  // rejects.
  const generated = requireGeneratedIdentifier(runtime.generateId(), 'attemptToken');
  // A process-local serial makes two concurrent claims of the SAME attempt in
  // this process distinct as well, so their controller registrations can never
  // collide however the generator behaves. The compare-and-swap decides which
  // of them commits; cross-process uniqueness is irrelevant to the registry.
  localClaimSerial += 1;
  const attemptToken = `${loaded.record.sequence}.${loaded.record.attempt + 1}.${localClaimSerial}.${generated}`;
  const transition = claimWaitingCommand(loaded.record, { now: committedAt, attemptToken });
  if (!transition.ok) return null;
  // Register BEFORE the commit. A sibling handle that cancels the command after
  // the lease lands but before registration would find nothing to abort, and
  // this claim would hand back a live signal for work whose cancellation is
  // already durable. A registration for a lease that never commits, or that is
  // withheld below, is released again.
  const { controller, registration } = registerAttemptController(
    runtime,
    attemptToken,
    loaded.record.commandId,
  );
  let committed: boolean;
  try {
    committed = await commitCommandTransition(runtime, {
      previous: loaded.record,
      expectedBytes: loaded.bytes,
      next: transition.next,
      now: committedAt,
    });
  } catch (error) {
    // Nothing was claimed, so nothing may stay registered: on a long-lived
    // handle, transient commit failures would otherwise grow the registry and
    // the handle's ownership set by one unique token each.
    releaseOwnRegistration(runtime, attemptToken, registration, 'The claim commit failed.');
    throw error;
  }
  if (!committed) {
    releaseOwnRegistration(
      runtime,
      attemptToken,
      registration,
      'The claim lost its compare-and-swap.',
    );
    return null;
  }
  if (registration !== null) registration.committedSerial = nextLeaseCommitSerial();
  // The commit is itself asynchronous — a fleet-event sink may retry its
  // compare-and-swap — so the lease can land after the deadline it was checked
  // against. Handing that claim out would start work the contract already calls
  // expired; dead-letter it and let the caller look at the head again.
  if (runtime.now() >= transition.next.absoluteDeadlineAt) {
    releaseOwnRegistration(
      runtime,
      attemptToken,
      registration,
      'The application mailbox dead-lettered this command at its absolute deadline.',
    );
    await deadLetterCommittedLease(runtime, transition.next.commandId);
    return null;
  }
  // An abort that raced the commit still has to reach the caller. The lease is
  // durable either way, but handing back a live signal for a request the caller
  // already abandoned would hide that from them.
  if (requestSignal?.aborted === true && !controller.signal.aborted) {
    controller.abort(new Error('The claim request was aborted while this claim committed.'));
  }
  return {
    status: 'claimed',
    claim: {
      receipt: toApplicationCommandReceipt(transition.next),
      payload,
      attemptToken,
      attempt: transition.next.attempt,
      visibilityExpiresAt: transition.next.visibilityExpiresAt,
      absoluteDeadlineAt: transition.next.absoluteDeadlineAt,
      signal: controller.signal,
    },
  };
}
