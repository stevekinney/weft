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
import { claimWaitingCommand } from './application-mailbox-transitions.ts';
import type { ApplicationCommandRecord } from './application-mailbox-types.ts';
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
    const head = await loadDeliveryHead(runtime.storage, runtime.keys);
    if (head === null) return { status: 'empty' };
    const loaded = await loadCommand(runtime.storage, runtime.keys, head.commandId);
    if (isUndeliverable(loaded) || loaded === null) {
      await discardOrphanedEntry(runtime, head);
      continue;
    }
    const now = runtime.now();
    if (now < loaded.record.availableAt) {
      return { status: 'held', availableAt: loaded.record.availableAt };
    }
    const payload = await verifyClaimedPayload(runtime, loaded.record);
    const attemptToken = runtime.generateId();
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
    runtime.attemptControllers.set(attemptToken, controller);
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
