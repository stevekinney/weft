/**
 * Encoding and fail-closed decoding for the durable application mailbox's
 * command records (WFT-84). Index records live in
 * `application-mailbox-index-codec.ts`; shared readers in
 * `application-mailbox-codec-primitives.ts`.
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
  ApplicationCommandPayload,
  ApplicationCommandRecord,
  ApplicationCommandState,
  ApplicationCommandTerminalState,
} from './application-mailbox-types.ts';
import {
  APPLICATION_MAILBOX_RECORD_VERSION,
  isApplicationCommandLeased,
  isApplicationCommandTerminalState,
} from './application-mailbox-types.ts';
import {
  fail,
  isRecordObject,
  ownKey,
  readIdentifier,
  readInteger,
  readOptionalInteger,
  readOptionalString,
  readPositiveInteger,
  readString,
  readVersion,
} from './application-primitive-codec.ts';
import { decode, encode } from './codec.ts';
import { isJSONValue, type JSONValue } from './json.ts';

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
    // A persisted key component, validated like every other identifier.
    idempotencyKey:
      source['idempotencyKey'] === undefined
        ? undefined
        : readIdentifier(source['idempotencyKey'], key),
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
  const lease = readLease(source, key);
  // Every claim and renewal writes the expiry as the lesser of the activity
  // instant plus the visibility window and the absolute deadline. A lowered
  // value would let maintenance reclaim a lease its holder is still inside; a
  // raised one would defer recovery past the configured window.
  const expected = Math.min(
    lease.lastActivityAt + base.visibilityTimeoutMs,
    base.absoluteDeadlineAt,
  );
  if (lease.visibilityExpiresAt !== expected) fail(key);
  return { ...base, ...lease } as const;
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
  const abandoned = readOptionalString(decoded, 'abandonedAttemptToken', key);
  if (!cleanupFieldsMatchState(state, cleanupPending === true, abandoned)) fail(key);
  return {
    ...readBase(decoded, key),
    state,
    terminalAt: readInteger(decoded, 'terminalAt', key),
    outcome: readOptionalJSONValue(decoded, 'outcome', key),
    failure,
    cancellationRequestedAt: readOptionalInteger(decoded, 'cancellationRequestedAt', key),
    cancellationReason: readOptionalString(decoded, 'cancellationReason', key),
    cleanupPending,
    abandonedAttemptToken: abandoned,
  };
}

/**
 * Only the transitions that abandon a lease — cancellation expiry and the two
 * dead-letter paths — write `cleanupPending: true`, and they always name the
 * abandoned attempt. A record with one without the other, or with either on an
 * `applied` or `rejected` disposition, is damage; accepting it could report an
 * abandoned handler as settled.
 */
function cleanupFieldsMatchState(
  state: ApplicationCommandTerminalState,
  cleanupPending: boolean,
  abandonedAttemptToken: string | undefined,
): boolean {
  if (cleanupPending !== (abandonedAttemptToken !== undefined)) return false;
  return !cleanupPending || state === 'cancelled' || state === 'dead-lettered';
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

/**
 * Decode one persisted command record, failing closed on anything unexpected.
 *
 * @throws {PersistedDataCorruptError} When the stored bytes are not a
 * well-formed current-version command record.
 */
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
 * Whether a decoded record still holds an attempt lease. Re-exported here so
 * storage callers need only one import.
 */
export { isApplicationCommandLeased };
