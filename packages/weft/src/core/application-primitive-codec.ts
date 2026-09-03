/**
 * Fail-closed readers shared by the application primitives' codecs (WFT-84, WFT-85).
 *
 * Every reader raises `PersistedDataCorruptError` for the key being decoded
 * rather than coercing a damaged value into something plausible. The record
 * codec and the index codec are built from these.
 *
 * @module core/application-primitive-codec
 */

import {
  MAX_APPLICATION_IDENTITY_BYTES,
  isWellFormedString,
} from './application-mailbox-guards.ts';
import { APPLICATION_MAILBOX_RECORD_VERSION } from './application-mailbox-types.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function fail(key: string): never {
  throw new PersistedDataCorruptError(key);
}

export function readString(source: Record<string, unknown>, field: string, key: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) fail(key);
  return value;
}

export function readOptionalString(
  source: Record<string, unknown>,
  field: string,
  key: string,
): string | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(key);
  return value;
}

export function readInteger(source: Record<string, unknown>, field: string, key: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(key);
  return value;
}

/**
 * Admission requires these to be positive, so a persisted zero is corruption:
 * a zero visibility timeout would hand out a lease that is reclaimable the
 * instant it is granted, and zero attempts would deliver work that is already
 * exhausted.
 */
export function readPositiveInteger(
  source: Record<string, unknown>,
  field: string,
  key: string,
): number {
  const value = readInteger(source, field, key);
  if (value === 0) fail(key);
  return value;
}

export function readOptionalInteger(
  source: Record<string, unknown>,
  field: string,
  key: string,
): number | undefined {
  if (source[field] === undefined) return undefined;
  return readInteger(source, field, key);
}

export function readVersion(source: Record<string, unknown>, key: string): void {
  if (source['recordVersion'] !== APPLICATION_MAILBOX_RECORD_VERSION) fail(key);
}

/**
 * Rebuild the key a record's own identity names. Key construction percent-encodes
 * each component and throws a raw `URIError` on an unpaired surrogate; a
 * persisted identity that malformed is corruption and must surface as such.
 */
export function ownKey(build: () => string, key: string): string {
  try {
    return build();
  } catch {
    return fail(key);
  }
}

/**
 * A persisted command id is handed straight to key construction by `claim()`,
 * `list()`, the waits, and idempotency lookups; an unpaired surrogate or an
 * oversized value there would escape as a raw `URIError` rather than the
 * corruption it is.
 */
export function readIdentifier(value: unknown, key: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isWellFormedString(value) ||
    new TextEncoder().encode(value).byteLength > MAX_APPLICATION_IDENTITY_BYTES
  ) {
    fail(key);
  }
  return value;
}
