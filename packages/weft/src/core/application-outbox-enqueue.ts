/**
 * Enqueue for the application delivery outbox (WFT-85): validating an offered
 * delivery, resolving its idempotency identity, enforcing backlog capacity,
 * and committing the record with its indexes and fleet event.
 *
 * Enqueue is the one transition that also allocates: it advances the outbox
 * header's sequence and open count in the same conditional batch as the record
 * itself, so backlog accounting can never drift from the records it describes.
 *
 * @module core/application-outbox-enqueue
 */

import type {
  ApplicationDeliveryAdmission,
  ApplicationDeliveryInput,
  ApplicationOutboxCapacity,
} from './application-outbox-contract.ts';
import {
  ApplicationDeliveryValidationError,
  requireGeneratedIdentifier,
} from './application-outbox-guards.ts';
import {
  encodeApplicationDeliveryEntry,
  encodeApplicationDeliveryIdempotencyRecord,
} from './application-outbox-index-codec.ts';
import {
  ApplicationOutboxContentionError,
  describeDeliveryTransition,
  MAX_OUTBOX_TRANSITION_ATTEMPTS,
  toApplicationDeliveryReceipt,
  type OutboxRuntime,
} from './application-outbox-internals.ts';
import {
  commitOutboxTransition,
  headerOperation,
  loadDelivery,
  loadDeliveryIdempotencyBinding,
  loadOutboxHeader,
  planDeliveryTransition,
} from './application-outbox-storage.ts';
import { createEnqueuedDeliveryRecord } from './application-outbox-transitions.ts';
import { APPLICATION_OUTBOX_RECORD_VERSION } from './application-outbox-types.ts';
import { validateDeliveryInput } from './application-outbox-validation.ts';
import { computeIdentityDigest } from './application-payload-digest.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

/** Backlog accounting, shared by enqueue rejection and the public `capacity()`. */
export function capacityOf(
  runtime: OutboxRuntime,
  open: number,
  enqueued: number,
): ApplicationOutboxCapacity {
  const limit = runtime.policy.maxBacklog;
  return Object.freeze({ open, limit, remaining: Math.max(0, limit - open), enqueued });
}

/**
 * The idempotency identity a retry key binds to. The credential reference is
 * deliberately absent: rotating a credential must not turn a retry into a
 * conflict, and the digest must never encode a secret locator.
 */
function identityOf(record: {
  readonly destinationRef: string;
  readonly kind: string;
  readonly payloadDigest: string;
}): Promise<string> {
  return computeIdentityDigest([record.destinationRef, record.kind, record.payloadDigest]);
}

/**
 * Offer a delivery to the outbox.
 *
 * An exact retry of the same idempotency identity returns the original
 * receipt. Reusing the key with a different destination, kind, or payload
 * digest returns a conflict and leaves the original untouched. A full backlog
 * is rejected before anything is persisted.
 */
export async function enqueueDelivery(
  runtime: OutboxRuntime,
  delivery: ApplicationDeliveryInput,
): Promise<ApplicationDeliveryAdmission> {
  const input = await validateDeliveryInput(delivery, runtime.policy);
  const identityDigest = await identityOf(input);
  for (let attempt = 1; attempt <= MAX_OUTBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    let expectedBinding: Uint8Array | null = null;
    if (input.idempotencyKey !== undefined) {
      const resolved = await resolveIdempotency(runtime, input.idempotencyKey, identityDigest);
      if (resolved.admission !== null) return resolved.admission;
      expectedBinding = resolved.staleBindingBytes;
    }
    const header = await loadOutboxHeader(
      runtime.storage,
      runtime.keys,
      runtime.policy.namespace,
      runtime.policy.ownerId,
    );
    if (header.record.openCount >= runtime.policy.maxBacklog) {
      return {
        status: 'rejected',
        reason: 'backlog-full',
        capacity: capacityOf(runtime, header.record.openCount, header.record.enqueuedCount),
      };
    }
    if (header.record.nextSequence >= Number.MAX_SAFE_INTEGER) {
      throw new ApplicationDeliveryValidationError(
        'This outbox has exhausted its sequence allocator; no further deliveries can be enqueued under this namespace and owner id.',
      );
    }
    const now = runtime.now();
    const record = createEnqueuedDeliveryRecord(input, {
      namespace: runtime.policy.namespace,
      ownerId: runtime.policy.ownerId,
      deliveryId: requireGeneratedIdentifier(runtime.generateId(), 'deliveryId'),
      sequence: header.record.nextSequence,
      now,
    });
    const idempotencyKey = input.idempotencyKey;
    const committed = await commitOutboxTransition(
      runtime.storage,
      runtime.events,
      planDeliveryTransition(runtime.keys, {
        previous: null,
        expectedBytes: null,
        next: record,
        event: describeDeliveryTransition(null, record),
        now,
        extraConditions: [
          { key: runtime.keys.header, expectedValue: header.bytes },
          ...(idempotencyKey === undefined
            ? []
            : [{ key: runtime.keys.idempotency(idempotencyKey), expectedValue: expectedBinding }]),
        ],
        extraOperations: [
          {
            type: 'put' as const,
            key: runtime.keys.bySequence(record.sequence),
            value: encodeApplicationDeliveryEntry(record.deliveryId),
          },
          headerOperation(runtime.keys, {
            ...header.record,
            nextSequence: header.record.nextSequence + 1,
            openCount: header.record.openCount + 1,
            enqueuedCount: header.record.enqueuedCount + 1,
          }),
          ...(idempotencyKey === undefined
            ? []
            : [
                {
                  type: 'put' as const,
                  key: runtime.keys.idempotency(idempotencyKey),
                  value: encodeApplicationDeliveryIdempotencyRecord({
                    recordVersion: APPLICATION_OUTBOX_RECORD_VERSION,
                    deliveryId: record.deliveryId,
                    identityDigest,
                  }),
                },
              ]),
        ],
      }),
    );
    if (!committed) continue;
    return { status: 'enqueued', receipt: toApplicationDeliveryReceipt(record) };
  }
  throw new ApplicationOutboxContentionError('enqueue', null);
}

/**
 * Resolve an idempotency key against durable state: the admission to hand back
 * when the key names a live delivery, or the bytes of a stale binding to
 * overwrite under a compare-and-swap.
 */
async function resolveIdempotency(
  runtime: OutboxRuntime,
  idempotencyKey: string,
  identityDigest: string,
): Promise<{
  admission: ApplicationDeliveryAdmission | null;
  staleBindingBytes: Uint8Array | null;
}> {
  const binding = await loadDeliveryIdempotencyBinding(
    runtime.storage,
    runtime.keys,
    idempotencyKey,
  );
  if (binding === null) return { admission: null, staleBindingBytes: null };
  const loaded = await loadDelivery(runtime.storage, runtime.keys, binding.record.deliveryId);
  // Retired by retention: the binding is spent, not a conflict.
  if (loaded === null) return { admission: null, staleBindingBytes: binding.bytes };
  const ownDigest = await identityOf(loaded.record);
  if (
    loaded.record.idempotencyKey !== idempotencyKey ||
    ownDigest !== binding.record.identityDigest
  ) {
    throw new PersistedDataCorruptError(runtime.keys.idempotency(idempotencyKey));
  }
  const receipt = toApplicationDeliveryReceipt(loaded.record);
  if (binding.record.identityDigest !== identityDigest) {
    return {
      admission: { status: 'conflict', receipt, reason: 'idempotency-identity-mismatch' },
      staleBindingBytes: null,
    };
  }
  return { admission: { status: 'duplicate', receipt }, staleBindingBytes: null };
}
