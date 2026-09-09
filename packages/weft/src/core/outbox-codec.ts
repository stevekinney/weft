/**
 * Encoding and fail-closed decoding for the durable application outbox's
 * delivery records (WFT-85). Index records live in
 * `outbox-index-codec.ts`.
 *
 * Decoding is deliberately paranoid, as the mailbox's is. A delivery record is
 * the authority for fencing, disposition, and whether an effect may already
 * have happened, so a truncated, hand-edited, or cross-version record must
 * raise `PersistedDataCorruptError` rather than be coerced into a plausible
 * state — silently treating a corrupt record as `queued` would resend work
 * that already reached its destination.
 *
 * @module core/outbox-codec
 */

import { KEYS } from '../storage/interface.ts';
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
import type {
  ApplicationDeliveryCausation,
  ApplicationDeliveryFailure,
  ApplicationDeliveryPayload,
  ApplicationDeliveryRecord,
  ApplicationDeliveryState,
  ApplicationDeliveryTerminalState,
  ApplicationDeliveryUnknownOutcomePolicy,
} from './outbox-types.ts';
import { OUTBOX_RECORD_VERSION, isApplicationDeliveryTerminalState } from './outbox-types.ts';

const DELIVERY_STATES: ReadonlySet<string> = new Set<ApplicationDeliveryState>([
  'queued',
  'retry-scheduled',
  'claimed',
  'attempting',
  'cancellation-requested',
  'acknowledged',
  'rejected',
  'cancelled',
  'unknown-outcome',
  'dead-lettered',
]);

const FAILURE_REASONS: ReadonlySet<string> = new Set<ApplicationDeliveryFailure['reason']>([
  'application',
  'retryable',
  'attempts-exhausted',
  'unknown-outcome',
  'cancelled',
]);

const POLICIES: ReadonlySet<string> = new Set<ApplicationDeliveryUnknownOutcomePolicy>([
  'park',
  'dead-letter',
  'retry-with-idempotency',
]);

const PERSISTED_HEX_DIGEST = /^[0-9a-f]{64}$/;

function readPayloadFields(source: Record<string, unknown>, key: string) {
  const payload = readPayload(source, key);
  const payloadDigest = readString(source, 'payloadDigest', key);
  if (payload.form === 'reference' && payload.digest !== payloadDigest) fail(key);
  return { payload, payloadDigest } as const;
}

function readPayload(source: Record<string, unknown>, key: string): ApplicationDeliveryPayload {
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
): ApplicationDeliveryCausation | undefined {
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
  field: string,
  key: string,
): ApplicationDeliveryFailure | undefined {
  const failure = source[field];
  if (failure === undefined) return undefined;
  if (!isRecordObject(failure)) fail(key);
  const reason = readString(failure, 'reason', key);
  if (!FAILURE_REASONS.has(reason)) fail(key);
  return {
    // Membership was just proved against the reason set.
    reason: reason as ApplicationDeliveryFailure['reason'],
    message: readOptionalString(failure, 'message', key),
    details: readOptionalJSONValue(failure, 'details', key),
  };
}

function readPolicy(source: Record<string, unknown>, key: string) {
  const policy = readString(source, 'unknownOutcomePolicy', key);
  if (!POLICIES.has(policy)) fail(key);
  // Membership was just proved against the policy set.
  return policy as ApplicationDeliveryUnknownOutcomePolicy;
}

function readOptionalIdentifier(source: Record<string, unknown>, field: string, key: string) {
  return source[field] === undefined ? undefined : readIdentifier(source[field], key);
}

function readBase(source: Record<string, unknown>, key: string) {
  const externalIdempotencyKey = readOptionalIdentifier(source, 'externalIdempotencyKey', key);
  const unknownOutcomePolicy = readPolicy(source, key);
  // Enqueue refuses this combination; a persisted one is damage that recovery
  // could turn into an unsafe retry.
  if (unknownOutcomePolicy === 'retry-with-idempotency' && externalIdempotencyKey === undefined) {
    fail(key);
  }
  return {
    recordVersion: OUTBOX_RECORD_VERSION,
    namespace: readString(source, 'namespace', key),
    ownerId: readString(source, 'ownerId', key),
    deliveryId: readString(source, 'deliveryId', key),
    sequence: readInteger(source, 'sequence', key),
    idempotencyKey: readOptionalIdentifier(source, 'idempotencyKey', key),
    destinationRef: readString(source, 'destinationRef', key),
    credentialRef: readOptionalString(source, 'credentialRef', key),
    kind: readString(source, 'kind', key),
    ...readPayloadFields(source, key),
    payloadMediaType: readOptionalString(source, 'payloadMediaType', key),
    payloadSchema: readOptionalString(source, 'payloadSchema', key),
    causation: readCausation(source, key),
    externalIdempotencyKey,
    unknownOutcomePolicy,
    enqueuedAt: readInteger(source, 'enqueuedAt', key),
    availableAt: readInteger(source, 'availableAt', key),
    maxAttempts: readPositiveInteger(source, 'maxAttempts', key),
    visibilityTimeoutMs: readPositiveInteger(source, 'visibilityTimeoutMs', key),
    attemptTimeoutMs: readPositiveInteger(source, 'attemptTimeoutMs', key),
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
 * A leased record's attempt is the one the claim started, so it is at least
 * one and never beyond the budget, and its expiries obey what every claim,
 * begin, and heartbeat writes: the deadline is fixed at the claim, and
 * visibility is the lesser of the last activity plus the window and that
 * deadline.
 */
function readLeasedBase(source: Record<string, unknown>, key: string) {
  const base = readBase(source, key);
  if (base.attempt < 1 || base.attempt > base.maxAttempts) fail(key);
  const lease = {
    attemptToken: readString(source, 'attemptToken', key),
    claimedAt: readInteger(source, 'claimedAt', key),
    visibilityExpiresAt: readInteger(source, 'visibilityExpiresAt', key),
    attemptDeadlineAt: readInteger(source, 'attemptDeadlineAt', key),
    lastActivityAt: readInteger(source, 'lastActivityAt', key),
    transportActivity: readOptionalJSONValue(source, 'transportActivity', key),
  } as const;
  if (lease.attemptDeadlineAt !== lease.claimedAt + base.attemptTimeoutMs) fail(key);
  const expected = Math.min(
    lease.lastActivityAt + base.visibilityTimeoutMs,
    lease.attemptDeadlineAt,
  );
  if (lease.visibilityExpiresAt !== expected) fail(key);
  return { ...base, ...lease } as const;
}

/**
 * Each terminal disposition carries the failure its transition writes:
 * `acknowledged` none, `rejected` the transport's `application` refusal,
 * `cancelled` the outbox's `cancelled`, `unknown-outcome` the outbox's
 * `unknown-outcome`, and `dead-lettered` either `attempts-exhausted` or
 * `unknown-outcome`.
 */
function failureMatchesState(
  state: ApplicationDeliveryTerminalState,
  reason: string | undefined,
): boolean {
  switch (state) {
    case 'acknowledged':
      return reason === undefined;
    case 'rejected':
      return reason === 'application';
    case 'cancelled':
      return reason === 'cancelled';
    case 'unknown-outcome':
      return reason === 'unknown-outcome';
    default:
      return reason === 'attempts-exhausted' || reason === 'unknown-outcome';
  }
}

/**
 * An abandoned lease is recorded only on the dispositions recovery can
 * produce, and always with the attempt it abandoned. `acknowledged`,
 * `rejected`, and a settled `cancelled` never abandon anything.
 */
function cleanupFieldsMatchState(
  state: ApplicationDeliveryTerminalState,
  cleanupPending: boolean,
  abandonedAttemptToken: string | undefined,
): boolean {
  if (cleanupPending !== (abandonedAttemptToken !== undefined)) return false;
  return !cleanupPending || state === 'unknown-outcome' || state === 'dead-lettered';
}

function decodeTerminalRecord(
  decoded: Record<string, unknown>,
  key: string,
  state: ApplicationDeliveryTerminalState,
): ApplicationDeliveryRecord {
  const cleanupPending = decoded['cleanupPending'];
  if (cleanupPending !== undefined && typeof cleanupPending !== 'boolean') fail(key);
  const failure = readFailure(decoded, 'failure', key);
  if (!failureMatchesState(state, failure?.reason)) fail(key);
  const abandoned = readOptionalString(decoded, 'abandonedAttemptToken', key);
  if (!cleanupFieldsMatchState(state, cleanupPending === true, abandoned)) fail(key);
  return {
    ...readBase(decoded, key),
    state,
    terminalAt: readInteger(decoded, 'terminalAt', key),
    evidence: readOptionalJSONValue(decoded, 'evidence', key),
    failure,
    cancellationRequestedAt: readOptionalInteger(decoded, 'cancellationRequestedAt', key),
    cancellationReason: readOptionalString(decoded, 'cancellationReason', key),
    cleanupPending,
    abandonedAttemptToken: abandoned,
  };
}

/**
 * A record must live under the key its own identity names; a misplaced one
 * would be returned as another delivery's receipt.
 */
function assertIdentityMatchesKey(decoded: Record<string, unknown>, key: string): void {
  const namespace = readString(decoded, 'namespace', key);
  const ownerId = readString(decoded, 'ownerId', key);
  const deliveryId = readString(decoded, 'deliveryId', key);
  if (ownKey(() => KEYS.applicationDelivery(namespace, ownerId, deliveryId), key) !== key) {
    fail(key);
  }
}

/**
 * A waiting record with no attempt budget left cannot be produced by the
 * transitions — a spent budget dead-letters, and an operator retry raises the
 * budget — so it is damage, and claiming it would run attempt
 * `maxAttempts + 1`.
 */
function readWaitingRecord(
  decoded: Record<string, unknown>,
  key: string,
  state: 'queued' | 'retry-scheduled',
): ApplicationDeliveryRecord {
  const base = readBase(decoded, key);
  if (base.attempt >= base.maxAttempts) fail(key);
  if (state === 'queued') return { ...base, state };
  const lastFailure = readFailure(decoded, 'lastFailure', key);
  // Only a retryable or an unknown outcome reschedules.
  if (
    lastFailure === undefined ||
    (lastFailure.reason !== 'retryable' && lastFailure.reason !== 'unknown-outcome')
  ) {
    fail(key);
  }
  return { ...base, state, lastFailure };
}

/** Decode the bytes into a versioned record object, or fail closed. */
function readEnvelope(bytes: Uint8Array, key: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    fail(key);
  }
  if (!isRecordObject(decoded)) fail(key);
  readVersion(decoded, key, OUTBOX_RECORD_VERSION);
  return decoded;
}

/**
 * Decode one persisted delivery record, failing closed on anything unexpected.
 *
 * @throws {PersistedDataCorruptError} When the stored bytes are not a
 * well-formed current-version delivery record.
 */
export function decodeApplicationDeliveryRecord(
  bytes: Uint8Array,
  key: string,
): ApplicationDeliveryRecord {
  const decoded = readEnvelope(bytes, key);
  assertIdentityMatchesKey(decoded, key);
  const state = decoded['state'];
  if (!isDeliveryState(state)) fail(key);
  if (state === 'queued' || state === 'retry-scheduled') {
    return readWaitingRecord(decoded, key, state);
  }
  if (isApplicationDeliveryTerminalState(state)) return decodeTerminalRecord(decoded, key, state);
  return decodeLeasedRecord(decoded, key, state);
}

function isDeliveryState(state: unknown): state is ApplicationDeliveryState {
  return typeof state === 'string' && DELIVERY_STATES.has(state);
}

function decodeLeasedRecord(
  decoded: Record<string, unknown>,
  key: string,
  state: 'claimed' | 'attempting' | 'cancellation-requested',
): ApplicationDeliveryRecord {
  const base = readLeasedBase(decoded, key);
  if (state === 'claimed') return { ...base, state };
  const attemptStartedAt = readInteger(decoded, 'attemptStartedAt', key);
  if (state === 'attempting') return { ...base, state, attemptStartedAt };
  return {
    ...base,
    state,
    attemptStartedAt,
    cancellationRequestedAt: readInteger(decoded, 'cancellationRequestedAt', key),
    cancellationReason: readOptionalString(decoded, 'cancellationReason', key),
  };
}

/** Encode a delivery record for storage. */
export function encodeApplicationDeliveryRecord(record: ApplicationDeliveryRecord): Uint8Array {
  return encode(record);
}
