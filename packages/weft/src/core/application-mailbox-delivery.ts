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
import type {
  ApplicationCommandClaimedPayload,
  ApplicationMailboxClaimResult,
  LoadedCommandRecord,
} from './application-mailbox-contract.ts';
import {
  ApplicationMailboxContentionError,
  MAX_MAILBOX_TRANSITION_ATTEMPTS,
  commitCommandTransition,
  toApplicationCommandReceipt,
  type MailboxRuntime,
} from './application-mailbox-internals.ts';
import { loadCommand, loadDeliveryHead } from './application-mailbox-storage.ts';
import { recoverExpiredCommand } from './application-mailbox-transitions-recovery.ts';
import { claimWaitingCommand } from './application-mailbox-transitions.ts';
import type { ApplicationCommandRecord } from './application-mailbox-types.ts';
import {
  requireClockInstant,
  requireGeneratedIdentifier,
} from './application-mailbox-validation.ts';
import { computePayloadDigest } from './application-payload-digest.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

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

/** Whether a record has moved past the point where a delivery-index entry is meaningful. */
function isUndeliverable(loaded: LoadedCommandRecord | null): boolean {
  return (
    loaded === null || (loaded.record.state !== 'accepted' && loaded.record.state !== 'available')
  );
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
  if (loaded === null || isUndeliverable(loaded)) {
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
    return { status: 'held', availableAt: loaded.record.availableAt };
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
  requestSignal: AbortSignal | undefined,
): AbortController {
  const controller = new AbortController();
  if (runtime.adoptAttempt(attemptToken)) {
    runtime.attemptControllers.set(attemptToken, controller);
  } else {
    controller.abort(new Error('The application mailbox was disposed while this claim committed.'));
  }
  // An abort that raced the commit still has to reach the caller. The lease is
  // durable either way, but handing back a live signal for a request the caller
  // already abandoned would hide that from them.
  if (requestSignal?.aborted === true && !controller.signal.aborted) {
    controller.abort(new Error('The claim request was aborted while this claim committed.'));
  }
  return controller;
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
  for (let attempt = 1; attempt <= MAX_MAILBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    options?.signal?.throwIfAborted();
    const now = runtime.now();
    const head = await resolveDeliverableHead(runtime, now);
    if (head.status === 'empty') return { status: 'empty' };
    if (head.status === 'held') return { status: 'held', availableAt: head.availableAt };
    if (head.status === 'retry') continue;
    const claim = await leaseHead(runtime, head.loaded, options?.signal);
    if (claim !== null) return claim;
  }
  throw new ApplicationMailboxContentionError('claim', null);
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
  const attemptToken = requireGeneratedIdentifier(runtime.generateId(), 'attemptToken');
  const transition = claimWaitingCommand(loaded.record, { now: committedAt, attemptToken });
  if (!transition.ok) return null;
  const committed = await commitCommandTransition(runtime, {
    previous: loaded.record,
    expectedBytes: loaded.bytes,
    next: transition.next,
    now: committedAt,
  });
  if (!committed) return null;
  const controller = registerAttemptController(runtime, attemptToken, requestSignal);
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
