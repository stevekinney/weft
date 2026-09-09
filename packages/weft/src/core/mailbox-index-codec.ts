/**
 * Encoding and fail-closed decoding for the application mailbox's index
 * records (WFT-84): the per-mailbox header, idempotency bindings, and the
 * entries of the delivery, listing, and terminal-retention indexes.
 *
 * Kept apart from the command-record codec so each stays under the repository's
 * file ceiling while carrying its full rationale.
 *
 * @module core/mailbox-index-codec
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
import type { ApplicationCommandIdempotencyRecord, MailboxRecord } from './mailbox-types.ts';
import { MAILBOX_RECORD_VERSION } from './mailbox-types.ts';

/**
 * Decode the per-mailbox header holding the FIFO allocator and backlog counter.
 *
 * @throws {PersistedDataCorruptError} When the stored bytes are malformed.
 */
export function decodeMailboxRecord(bytes: Uint8Array, key: string): MailboxRecord {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    fail(key);
  }
  if (!isRecordObject(decoded)) fail(key);
  readVersion(decoded, key);
  const namespace = readString(decoded, 'namespace', key);
  const resourceId = readString(decoded, 'resourceId', key);
  // A header copied from another scope, or corrupted into one, would hand its
  // sequence allocator to this mailbox and let the next admission overwrite an
  // existing index entry. It must name the scope it is stored under.
  if (ownKey(() => KEYS.applicationMailbox(namespace, resourceId), key) !== key) fail(key);
  const nextSequence = readInteger(decoded, 'nextSequence', key);
  const openCount = readInteger(decoded, 'openCount', key);
  const admittedCount = readInteger(decoded, 'admittedCount', key);
  // The allocator and the lifetime count start together and every admission
  // moves both, and the open backlog is a subset of what was ever admitted. A
  // header that breaks either relation is damage — a lowered allocator would
  // let the next admission overwrite an index entry at a reused position.
  if (nextSequence !== admittedCount || openCount > admittedCount) fail(key);
  return {
    recordVersion: MAILBOX_RECORD_VERSION,
    namespace,
    resourceId,
    nextSequence,
    openCount,
    admittedCount,
  };
}

/**
 * Encode the per-mailbox header.
 */
export function encodeMailboxRecord(record: MailboxRecord): Uint8Array {
  return encode(record);
}

/**
 * Decode an idempotency index record.
 *
 * @throws {PersistedDataCorruptError} When the stored bytes are malformed.
 */
export function decodeApplicationCommandIdempotencyRecord(
  bytes: Uint8Array,
  key: string,
): ApplicationCommandIdempotencyRecord {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    fail(key);
  }
  if (!isRecordObject(decoded)) fail(key);
  readVersion(decoded, key);
  return {
    recordVersion: MAILBOX_RECORD_VERSION,
    commandId: readIdentifier(decoded['commandId'], key),
    identityDigest: readString(decoded, 'identityDigest', key),
  };
}

/**
 * Encode an idempotency index record.
 */
export function encodeApplicationCommandIdempotencyRecord(
  record: ApplicationCommandIdempotencyRecord,
): Uint8Array {
  return encode(record);
}

/**
 * Decode the command id stored in a FIFO delivery-index entry.
 *
 * @throws {PersistedDataCorruptError} When the entry is not a non-empty string.
 */

export function decodeApplicationReadyEntry(bytes: Uint8Array, key: string): string {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    fail(key);
  }
  return readIdentifier(decoded, key);
}

/**
 * Encode a FIFO delivery-index entry.
 */
export function encodeApplicationReadyEntry(commandId: string): Uint8Array {
  return encode(commandId);
}
