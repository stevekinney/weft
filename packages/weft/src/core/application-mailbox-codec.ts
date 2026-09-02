/**
 * Encoding and fail-closed decoding for the durable application mailbox's
 * persisted records (WFT-84).
 *
 * Decoding is deliberately paranoid. A mailbox record is the authority for
 * delivery, fencing, and terminal disposition, so a truncated, hand-edited, or
 * cross-version record must raise `PersistedDataCorruptError` rather than be
 * coerced into a plausible-looking state — silently treating a corrupt record
 * as `available` would redeliver work that already applied.
 *
 * @module core/application-mailbox-codec
 */

import { KEYS } from '../storage/interface.ts';
import type {
  ApplicationCommandCausation,
  ApplicationCommandFailure,
  ApplicationCommandIdempotencyRecord,
  ApplicationCommandPayload,
  ApplicationCommandRecord,
  ApplicationCommandState,
  ApplicationCommandTerminalState,
  ApplicationMailboxRecord,
} from './application-mailbox-types.ts';
import {
  APPLICATION_MAILBOX_RECORD_VERSION,
  isApplicationCommandLeased,
  isApplicationCommandTerminalState,
} from './application-mailbox-types.ts';
import { decode, encode } from './codec.ts';
import { isJSONValue, type JSONValue } from './json.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

const COMMAND_STATES: ReadonlySet<string> = new Set<ApplicationCommandState>([
  'accepted',
  'available',
  'claimed',
  'cancellation-requested',
  'applied',
  'rejected',
  'cancelled',
  'dead-lettered',
]);

const FAILURE_REASONS: ReadonlySet<string> = new Set([
  'application',
  'attempts-exhausted',
  'deadline-exceeded',
  'cancelled',
]);

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(key: string): never {
  throw new PersistedDataCorruptError(key);
}

function readString(source: Record<string, unknown>, field: string, key: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) fail(key);
  return value;
}

function readOptionalString(
  source: Record<string, unknown>,
  field: string,
  key: string,
): string | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(key);
  return value;
}

function readInteger(source: Record<string, unknown>, field: string, key: string): number {
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
function readPositiveInteger(source: Record<string, unknown>, field: string, key: string): number {
  const value = readInteger(source, field, key);
  if (value === 0) fail(key);
  return value;
}

function readOptionalInteger(
  source: Record<string, unknown>,
  field: string,
  key: string,
): number | undefined {
  if (source[field] === undefined) return undefined;
  return readInteger(source, field, key);
}

function readVersion(source: Record<string, unknown>, key: string): void {
  if (source['recordVersion'] !== APPLICATION_MAILBOX_RECORD_VERSION) fail(key);
}

function readPayload(source: Record<string, unknown>, key: string): ApplicationCommandPayload {
  const payload = source['payload'];
  if (!isRecordObject(payload)) fail(key);
  if (payload['form'] === 'inline') {
    if (!('value' in payload)) fail(key);
    return { form: 'inline', value: payload['value'] };
  }
  if (payload['form'] !== 'reference') fail(key);
  const reference = readString(payload, 'reference', key);
  const digest = readString(payload, 'digest', key);
  const byteLength = readOptionalInteger(payload, 'byteLength', key);
  return byteLength === undefined
    ? { form: 'reference', reference, digest }
    : { form: 'reference', reference, digest, byteLength };
}

function readCausation(
  source: Record<string, unknown>,
  key: string,
): ApplicationCommandCausation | undefined {
  const causation = source['causation'];
  if (causation === undefined) return undefined;
  if (!isRecordObject(causation)) fail(key);
  return {
    correlationId: readOptionalString(causation, 'correlationId', key),
    causationId: readOptionalString(causation, 'causationId', key),
    traceparent: readOptionalString(causation, 'traceparent', key),
  };
}

function readFailure(
  source: Record<string, unknown>,
  key: string,
): ApplicationCommandFailure | undefined {
  const failure = source['failure'];
  if (failure === undefined) return undefined;
  if (!isRecordObject(failure)) fail(key);
  const reason = readString(failure, 'reason', key);
  if (!FAILURE_REASONS.has(reason)) fail(key);
  return {
    reason: reason as ApplicationCommandFailure['reason'],
    message: readOptionalString(failure, 'message', key),
    details: readOptionalJSONValue(failure, 'details', key),
  };
}

function readBase(source: Record<string, unknown>, key: string) {
  return {
    recordVersion: APPLICATION_MAILBOX_RECORD_VERSION,
    namespace: readString(source, 'namespace', key),
    resourceId: readString(source, 'resourceId', key),
    commandId: readString(source, 'commandId', key),
    sequence: readInteger(source, 'sequence', key),
    idempotencyKey: readOptionalString(source, 'idempotencyKey', key),
    caller: readString(source, 'caller', key),
    target: readString(source, 'target', key),
    kind: readString(source, 'kind', key),
    payload: readPayload(source, key),
    payloadDigest: readString(source, 'payloadDigest', key),
    payloadMediaType: readOptionalString(source, 'payloadMediaType', key),
    payloadSchema: readOptionalString(source, 'payloadSchema', key),
    causation: readCausation(source, key),
    acceptedAt: readInteger(source, 'acceptedAt', key),
    availableAt: readInteger(source, 'availableAt', key),
    absoluteDeadlineAt: readInteger(source, 'absoluteDeadlineAt', key),
    maxAttempts: readPositiveInteger(source, 'maxAttempts', key),
    visibilityTimeoutMs: readPositiveInteger(source, 'visibilityTimeoutMs', key),
    generation: readInteger(source, 'generation', key),
    attempt: readInteger(source, 'attempt', key),
    retryCount: readInteger(source, 'retryCount', key),
    firstClaimedAt: readOptionalInteger(source, 'firstClaimedAt', key),
  } as const;
}

function readOptionalJSONValue(
  source: Record<string, unknown>,
  field: string,
  key: string,
): JSONValue | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (!isJSONValue(value)) fail(key);
  return value;
}

function readLease(source: Record<string, unknown>, key: string) {
  return {
    attemptToken: readString(source, 'attemptToken', key),
    claimedAt: readInteger(source, 'claimedAt', key),
    visibilityExpiresAt: readInteger(source, 'visibilityExpiresAt', key),
    lastActivityAt: readInteger(source, 'lastActivityAt', key),
    progress: readOptionalJSONValue(source, 'progress', key),
  } as const;
}

/**
 * Decode one persisted command record, failing closed on anything unexpected.
 *
 * @throws {PersistedDataCorruptError} When the stored bytes are not a
 * well-formed current-version command record.
 */
function decodeTerminalRecord(
  decoded: Record<string, unknown>,
  key: string,
  state: ApplicationCommandTerminalState,
): ApplicationCommandRecord {
  const cleanupPending = decoded['cleanupPending'];
  if (cleanupPending !== undefined && typeof cleanupPending !== 'boolean') fail(key);
  return {
    ...readBase(decoded, key),
    state,
    terminalAt: readInteger(decoded, 'terminalAt', key),
    outcome: readOptionalJSONValue(decoded, 'outcome', key),
    failure: readFailure(decoded, key),
    cancellationRequestedAt: readOptionalInteger(decoded, 'cancellationRequestedAt', key),
    cancellationReason: readOptionalString(decoded, 'cancellationReason', key),
    cleanupPending,
    abandonedAttemptToken: readOptionalString(decoded, 'abandonedAttemptToken', key),
  };
}

/**
 * A record must live under the key its own identity names. Accepting a
 * misplaced or corrupted record would return it as another command's receipt,
 * and every later transition would build its compare-and-swap key from the
 * embedded identity rather than the one the caller asked for.
 */
function assertIdentityMatchesKey(decoded: Record<string, unknown>, key: string): void {
  const namespace = readString(decoded, 'namespace', key);
  const resourceId = readString(decoded, 'resourceId', key);
  const commandId = readString(decoded, 'commandId', key);
  if (ownKey(() => KEYS.applicationCommand(namespace, resourceId, commandId), key) !== key) {
    fail(key);
  }
}

/**
 * Rebuild the key a record's own identity names. Key construction percent-encodes
 * each component and throws a raw `URIError` on an unpaired surrogate; a
 * persisted identity that malformed is corruption and must surface as such.
 */
function ownKey(build: () => string, key: string): string {
  try {
    return build();
  } catch {
    return fail(key);
  }
}

export function decodeApplicationCommandRecord(
  bytes: Uint8Array,
  key: string,
): ApplicationCommandRecord {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    fail(key);
  }
  if (!isRecordObject(decoded)) fail(key);
  readVersion(decoded, key);
  assertIdentityMatchesKey(decoded, key);
  const state = decoded['state'];
  if (typeof state !== 'string' || !COMMAND_STATES.has(state)) fail(key);
  if (state === 'accepted' || state === 'available') {
    return { ...readBase(decoded, key), state };
  }
  if (state === 'claimed') {
    return { ...readBase(decoded, key), ...readLease(decoded, key), state };
  }
  if (state === 'cancellation-requested') {
    return {
      ...readBase(decoded, key),
      ...readLease(decoded, key),
      state,
      cancellationRequestedAt: readInteger(decoded, 'cancellationRequestedAt', key),
      cancellationReason: readOptionalString(decoded, 'cancellationReason', key),
    };
  }
  if (!isApplicationCommandTerminalState(state)) fail(key);
  return decodeTerminalRecord(decoded, key, state);
}

/**
 * Encode a command record for storage.
 */
export function encodeApplicationCommandRecord(record: ApplicationCommandRecord): Uint8Array {
  return encode(record);
}

/**
 * Decode the per-mailbox header holding the FIFO allocator and backlog counter.
 *
 * @throws {PersistedDataCorruptError} When the stored bytes are malformed.
 */
export function decodeApplicationMailboxRecord(
  bytes: Uint8Array,
  key: string,
): ApplicationMailboxRecord {
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
  return {
    recordVersion: APPLICATION_MAILBOX_RECORD_VERSION,
    namespace,
    resourceId,
    nextSequence: readInteger(decoded, 'nextSequence', key),
    openCount: readInteger(decoded, 'openCount', key),
    admittedCount: readInteger(decoded, 'admittedCount', key),
  };
}

/**
 * Encode the per-mailbox header.
 */
export function encodeApplicationMailboxRecord(record: ApplicationMailboxRecord): Uint8Array {
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
    recordVersion: APPLICATION_MAILBOX_RECORD_VERSION,
    commandId: readString(decoded, 'commandId', key),
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
  if (typeof decoded !== 'string' || decoded.length === 0) fail(key);
  return decoded;
}

/**
 * Encode a FIFO delivery-index entry.
 */
export function encodeApplicationReadyEntry(commandId: string): Uint8Array {
  return encode(commandId);
}

/**
 * Whether a decoded record still holds an attempt lease. Re-exported here so
 * storage callers need only one import.
 */
export { isApplicationCommandLeased };
