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
import {
  MAX_APPLICATION_IDENTITY_BYTES,
  isWellFormedString,
} from './application-mailbox-guards.ts';
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

/** What admission accepts for a reference digest; anything else persisted is damage. */
const PERSISTED_HEX_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Admission writes a reference payload's digest to `payloadDigest` as well, and
 * idempotency binds against the latter. A record where the two disagree would
 * hand a claimant one digest while identity was bound to the other.
 */
function readPayloadFields(source: Record<string, unknown>, key: string) {
  const payload = readPayload(source, key);
  const payloadDigest = readString(source, 'payloadDigest', key);
  if (payload.form === 'reference' && payload.digest !== payloadDigest) fail(key);
  return { payload, payloadDigest } as const;
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
  if (!PERSISTED_HEX_DIGEST.test(digest)) fail(key);
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
    ...readPayloadFields(source, key),
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

/**
 * A leased record's attempt is the one the claim just started, so it is at
 * least one and never beyond the budget; the transitions cannot produce
 * anything else, and settlement trusts the decoded attempt without rechecking.
 */
function readLeasedBase(source: Record<string, unknown>, key: string) {
  const base = readBase(source, key);
  if (base.attempt < 1 || base.attempt > base.maxAttempts) fail(key);
  return { ...base, ...readLease(source, key) } as const;
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
/**
 * Each terminal disposition is produced by exactly one kind of transition and
 * carries the failure that transition writes: `applied` none, `rejected` the
 * claimant's `application` failure, `cancelled` the mailbox's `cancelled`, and
 * `dead-lettered` either `attempts-exhausted` or `deadline-exceeded`. A record
 * pairing any other combination gives observers contradictory evidence.
 */
function failureMatchesState(
  state: ApplicationCommandTerminalState,
  reason: string | undefined,
): boolean {
  switch (state) {
    case 'applied':
      return reason === undefined;
    case 'rejected':
      return reason === 'application';
    case 'cancelled':
      return reason === 'cancelled';
    default:
      return reason === 'attempts-exhausted' || reason === 'deadline-exceeded';
  }
}

function decodeTerminalRecord(
  decoded: Record<string, unknown>,
  key: string,
  state: ApplicationCommandTerminalState,
): ApplicationCommandRecord {
  const cleanupPending = decoded['cleanupPending'];
  if (cleanupPending !== undefined && typeof cleanupPending !== 'boolean') fail(key);
  const failure = readFailure(decoded, key);
  if (!failureMatchesState(state, failure?.reason)) fail(key);
  return {
    ...readBase(decoded, key),
    state,
    terminalAt: readInteger(decoded, 'terminalAt', key),
    outcome: readOptionalJSONValue(decoded, 'outcome', key),
    failure,
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

/**
 * The transitions dead-letter a final attempt rather than release it, so a
 * waiting record with no attempt budget left cannot be produced by them. It is
 * damage, and claiming it would run attempt `maxAttempts + 1`.
 */
function readWaitingRecord(
  decoded: Record<string, unknown>,
  key: string,
  state: 'accepted' | 'available',
): ApplicationCommandRecord {
  const base = readBase(decoded, key);
  if (base.attempt >= base.maxAttempts) fail(key);
  return { ...base, state };
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
    return readWaitingRecord(decoded, key, state);
  }
  if (state === 'claimed') {
    return { ...readLeasedBase(decoded, key), state };
  }
  if (state === 'cancellation-requested') {
    return {
      ...readLeasedBase(decoded, key),
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
  const nextSequence = readInteger(decoded, 'nextSequence', key);
  const openCount = readInteger(decoded, 'openCount', key);
  const admittedCount = readInteger(decoded, 'admittedCount', key);
  // The allocator and the lifetime count start together and every admission
  // moves both, and the open backlog is a subset of what was ever admitted. A
  // header that breaks either relation is damage — a lowered allocator would
  // let the next admission overwrite an index entry at a reused position.
  if (nextSequence !== admittedCount || openCount > admittedCount) fail(key);
  return {
    recordVersion: APPLICATION_MAILBOX_RECORD_VERSION,
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
    commandId: readCommandIdentifier(decoded['commandId'], key),
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
/**
 * A persisted command id is handed straight to key construction by `claim()`,
 * `list()`, the waits, and idempotency lookups; an unpaired surrogate or an
 * oversized value there would escape as a raw `URIError` rather than the
 * corruption it is.
 */
function readCommandIdentifier(value: unknown, key: string): string {
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

export function decodeApplicationReadyEntry(bytes: Uint8Array, key: string): string {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    fail(key);
  }
  return readCommandIdentifier(decoded, key);
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
