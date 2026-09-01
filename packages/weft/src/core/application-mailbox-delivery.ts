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
import { requireGeneratedIdentifier } from './application-mailbox-validation.ts';
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
  head: { readonly key: string; readonly bytes: Uint8Array },
): Promise<void> {
  await storageConditionalBatch(
    runtime.storage,
    [{ key: head.key, expectedValue: head.bytes }],
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
    await discardOrphanedEntry(runtime, head);
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
    const loaded = head.loaded;
    const payload = await verifyClaimedPayload(runtime, loaded.record);
    const attemptToken = requireGeneratedIdentifier(runtime.generateId(), 'attemptToken');
    const transition = claimWaitingCommand(loaded.record, { now, attemptToken });
    if (!transition.ok) continue;
    const committed = await commitCommandTransition(runtime, {
      previous: loaded.record,
      expectedBytes: loaded.bytes,
      next: transition.next,
      now,
    });
    if (!committed) continue;
    const controller = new AbortController();
    // Disposal may have run while the commit was in flight. Registering an
    // un-aborted controller now would hand back a live claim from a disposed
    // mailbox that no later `dispose()` could ever reach.
    if (runtime.isDisposed()) {
      controller.abort(
        new Error('The application mailbox was disposed while this claim committed.'),
      );
    } else {
      runtime.attemptControllers.set(attemptToken, controller);
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
  throw new ApplicationMailboxContentionError('claim', null);
}
