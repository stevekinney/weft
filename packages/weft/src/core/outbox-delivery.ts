/**
 * Claims for the application delivery outbox (WFT-85): leasing the earliest
 * due delivery to one attempt and handing that attempt a digest-verified
 * payload, the credential reference, and an attempt-scoped abort signal.
 *
 * The due index is time-keyed, so a claim considers the earliest entries and
 * takes the first one that is due now. A delivery in retry backoff never holds
 * back one that is due, which is the deliberate difference from the mailbox's
 * strict FIFO.
 *
 * @module core/outbox-delivery
 */

import { storageConditionalBatch } from '../storage/interface.ts';
import { computePayloadDigest } from './application-payload-digest.ts';
import { raceAbort } from './application-primitive-abort.ts';
import {
  nextLeaseCommitSerial,
  type AttemptRegistration,
} from './application-primitive-attempt-registry.ts';
import type {
  ApplicationDeliveryClaimedPayload,
  LoadedDeliveryRecord,
  OutboxClaimResult,
} from './outbox-contract.ts';
import { requireClockInstant, requireGeneratedIdentifier } from './outbox-guards.ts';
import {
  commitDeliveryTransition,
  MAX_OUTBOX_TRANSITION_ATTEMPTS,
  OutboxContentionError,
  toApplicationDeliveryReceipt,
  type OutboxRuntime,
} from './outbox-internals.ts';
import { loadDelivery, loadDueHead, type DueEntry } from './outbox-storage.ts';
import { claimWaitingDelivery } from './outbox-transitions.ts';
import { isApplicationDeliveryWaiting, type ApplicationDeliveryRecord } from './outbox-types.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

/** How many due-index entries a non-mutating due-work observation looks past. */
export const DUE_HEAD_LOOKAHEAD = 8;

/** Process-local claim serial folded into every attempt token. */
let localClaimSerial = 0;

/**
 * Recompute an inline payload's digest and fail closed on a mismatch. A
 * reference payload is handed over unverified, with the stored digest.
 *
 * @throws {PersistedDataCorruptError} When a stored inline payload no longer
 * matches the digest enqueue recorded for it.
 */
export async function verifyClaimedPayload(
  runtime: OutboxRuntime,
  record: ApplicationDeliveryRecord,
): Promise<ApplicationDeliveryClaimedPayload> {
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
    throw new PersistedDataCorruptError(runtime.keys.delivery(record.deliveryId));
  }
  return { form: 'inline', value: record.payload.value, digest, verified: true };
}

/** Whether a due entry no longer describes the waiting record it names. */
function isOrphanedEntry(
  runtime: OutboxRuntime,
  entry: DueEntry,
  loaded: LoadedDeliveryRecord,
): boolean {
  return (
    !isApplicationDeliveryWaiting(loaded.record) ||
    entry.key !== runtime.keys.due(loaded.record.availableAt, loaded.record.deliveryId)
  );
}

/**
 * Remove a due entry that outlived the record it pointed at, fenced on the
 * entry's bytes AND the record's, so a byte-identical entry re-added by a
 * reschedule is never clobbered (the ABA hazard the mailbox documents).
 */
async function discardOrphanedEntry(
  runtime: OutboxRuntime,
  entry: DueEntry,
  observed: LoadedDeliveryRecord | null,
): Promise<boolean> {
  return storageConditionalBatch(
    runtime.storage,
    [
      { key: entry.key, expectedValue: entry.bytes },
      {
        key: runtime.keys.delivery(entry.deliveryId),
        expectedValue: observed === null ? null : observed.bytes,
      },
    ],
    [{ type: 'delete', key: entry.key }],
  );
}

type DeliverableHead =
  | { readonly status: 'claimable'; readonly loaded: LoadedDeliveryRecord }
  | { readonly status: 'empty' }
  | { readonly status: 'held'; readonly availableAt: number }
  | { readonly status: 'retry'; readonly progressed: boolean };

/**
 * What the due index currently offers: its earliest entry, when it names a
 * waiting record. An orphaned entry is discarded and the caller looks again;
 * an earliest entry that is not yet due is `held`.
 */
async function resolveDeliverableHead(
  runtime: OutboxRuntime,
  now: number,
): Promise<DeliverableHead> {
  const [entry] = await loadDueHead(runtime.storage, runtime.keys, 1);
  if (entry === undefined) return { status: 'empty' };
  const loaded = await loadDelivery(runtime.storage, runtime.keys, entry.deliveryId);
  if (loaded === null || isOrphanedEntry(runtime, entry, loaded)) {
    return { status: 'retry', progressed: await discardOrphanedEntry(runtime, entry, loaded) };
  }
  // The index is sorted by `availableAt`, so the first genuine entry decides:
  // either it is due, or nothing behind it is.
  if (now < loaded.record.availableAt) {
    return { status: 'held', availableAt: loaded.record.availableAt };
  }
  return { status: 'claimable', loaded };
}

/** Take ownership of a freshly committed attempt, or learn that disposal already won. */
function registerAttemptController(
  runtime: OutboxRuntime,
  attemptToken: string,
  deliveryId: string,
): { readonly controller: AbortController; readonly registration: AttemptRegistration | null } {
  const controller = new AbortController();
  const release = runtime.adoptAttempt(attemptToken);
  if (release === null) {
    controller.abort(new Error('The application outbox was disposed while this claim committed.'));
    return { controller, registration: null };
  }
  const registration: AttemptRegistration = {
    controller,
    release,
    subjectId: deliveryId,
    committedSerial: null,
  };
  runtime.attemptControllers.set(attemptToken, registration);
  return { controller, registration };
}

function releaseOwnRegistration(
  runtime: OutboxRuntime,
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
 * Lease the earliest due delivery to one attempt.
 *
 * Only a lost compare-and-swap counts toward contention; housekeeping that
 * discarded an orphaned entry is progress.
 */
export async function claimNextDelivery(
  runtime: OutboxRuntime,
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<OutboxClaimResult> {
  let losses = 0;
  while (losses < MAX_OUTBOX_TRANSITION_ATTEMPTS) {
    options?.signal?.throwIfAborted();
    const outcome = await attemptClaim(runtime, options?.signal);
    if ('status' in outcome) return outcome;
    if (outcome.lost) losses += 1;
  }
  throw new OutboxContentionError('claim', null);
}

async function attemptClaim(
  runtime: OutboxRuntime,
  signal: AbortSignal | undefined,
): Promise<OutboxClaimResult | { readonly lost: boolean }> {
  const now = runtime.now();
  const observed = await raceAbort(() => resolveDeliverableHead(runtime, now), signal);
  if (observed.aborted) throw observed.reason as Error;
  signal?.throwIfAborted();
  const head = observed.value;
  if (head.status === 'empty') return { status: 'empty' };
  if (head.status === 'held') return { status: 'held', availableAt: head.availableAt };
  if (head.status === 'retry') return { lost: !head.progressed };
  const claim = await leaseDelivery(runtime, head.loaded, signal);
  return claim ?? { lost: true };
}

/**
 * Verify the payload and commit the lease, or return `null` when the
 * compare-and-swap lost and the caller should look again.
 */
async function leaseDelivery(
  runtime: OutboxRuntime,
  loaded: LoadedDeliveryRecord,
  requestSignal: AbortSignal | undefined,
): Promise<OutboxClaimResult | null> {
  const payload = await verifyClaimedPayload(runtime, loaded.record);
  const committedAt = requireClockInstant(runtime.now());
  requestSignal?.throwIfAborted();
  // The token is unique across the outbox even if the injected generator
  // repeats, and across concurrent claims in this process however it behaves;
  // see the mailbox's delivery module for the full rationale.
  const generated = requireGeneratedIdentifier(runtime.generateId(), 'attemptToken');
  localClaimSerial += 1;
  const attemptToken = `${loaded.record.sequence}.${loaded.record.attempt + 1}.${localClaimSerial}.${generated}`;
  const transition = claimWaitingDelivery(loaded.record, { now: committedAt, attemptToken });
  if (!transition.ok) return null;
  const { controller, registration } = registerAttemptController(
    runtime,
    attemptToken,
    loaded.record.deliveryId,
  );
  let committed: boolean;
  try {
    committed = await commitDeliveryTransition(runtime, {
      previous: loaded.record,
      expectedBytes: loaded.bytes,
      next: transition.next,
      now: committedAt,
    });
  } catch (error) {
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
  if (requestSignal?.aborted === true && !controller.signal.aborted) {
    controller.abort(new Error('The claim request was aborted while this claim committed.'));
  }
  return {
    status: 'claimed',
    claim: {
      receipt: toApplicationDeliveryReceipt(transition.next),
      payload,
      credentialRef: transition.next.credentialRef,
      attemptToken,
      attempt: transition.next.attempt,
      visibilityExpiresAt: transition.next.visibilityExpiresAt,
      attemptDeadlineAt: transition.next.attemptDeadlineAt,
      signal: controller.signal,
    },
  };
}
