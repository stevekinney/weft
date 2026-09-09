/**
 * Encoding and fail-closed decoding for the application outbox's index
 * records (WFT-85): the per-outbox header, the idempotency binding, and the
 * delivery-id entries the due, listing, and terminal indexes hold.
 *
 * @module core/outbox-index-codec
 */

import { KEYS } from '../storage/interface.ts';
import {
  fail,
  isRecordObject,
  ownKey,
  readIdentifier,
  readInteger,
  readString,
  readVersion,
} from './application-primitive-codec.ts';
import { decode, encode } from './codec.ts';
import type { ApplicationDeliveryIdempotencyRecord, OutboxRecord } from './outbox-types.ts';
import { OUTBOX_RECORD_VERSION } from './outbox-types.ts';

/**
 * Decode the per-outbox header.
 *
 * @throws {PersistedDataCorruptError} When the stored bytes are malformed or
 * name a different outbox than the key does.
 */
export function decodeOutboxRecord(bytes: Uint8Array, key: string): OutboxRecord {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    fail(key);
  }
  if (!isRecordObject(decoded)) fail(key);
  readVersion(decoded, key, OUTBOX_RECORD_VERSION);
  const namespace = readString(decoded, 'namespace', key);
  const ownerId = readString(decoded, 'ownerId', key);
  if (ownKey(() => KEYS.applicationOutbox(namespace, ownerId), key) !== key) fail(key);
  const nextSequence = readInteger(decoded, 'nextSequence', key);
  const openCount = readInteger(decoded, 'openCount', key);
  const enqueuedCount = readInteger(decoded, 'enqueuedCount', key);
  // The open backlog can never exceed lifetime enqueues, and a sequence can
  // only be allocated by an enqueue.
  if (openCount > enqueuedCount || nextSequence < enqueuedCount) fail(key);
  return {
    recordVersion: OUTBOX_RECORD_VERSION,
    namespace,
    ownerId,
    nextSequence,
    openCount,
    enqueuedCount,
  };
}

/** Encode the per-outbox header. */
export function encodeOutboxRecord(record: OutboxRecord): Uint8Array {
  return encode(record);
}

/**
 * Decode an idempotency binding.
 *
 * @throws {PersistedDataCorruptError} When the stored bytes are malformed.
 */
export function decodeApplicationDeliveryIdempotencyRecord(
  bytes: Uint8Array,
  key: string,
): ApplicationDeliveryIdempotencyRecord {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    fail(key);
  }
  if (!isRecordObject(decoded)) fail(key);
  readVersion(decoded, key, OUTBOX_RECORD_VERSION);
  return {
    recordVersion: OUTBOX_RECORD_VERSION,
    deliveryId: readIdentifier(decoded['deliveryId'], key),
    identityDigest: readString(decoded, 'identityDigest', key),
  };
}

/** Encode an idempotency binding. */
export function encodeApplicationDeliveryIdempotencyRecord(
  record: ApplicationDeliveryIdempotencyRecord,
): Uint8Array {
  return encode(record);
}

/**
 * Decode a due, listing, or terminal index entry: the delivery id it points at.
 *
 * @throws {PersistedDataCorruptError} When the entry is not a usable identifier.
 */
export function decodeApplicationDeliveryEntry(bytes: Uint8Array, key: string): string {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    fail(key);
  }
  return readIdentifier(decoded, key);
}

/** Encode a due, listing, or terminal index entry. */
export function encodeApplicationDeliveryEntry(deliveryId: string): Uint8Array {
  return encode(deliveryId);
}
