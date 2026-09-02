/**
 * Bounds and input validation for the durable application command mailbox
 * (WFT-84).
 *
 * Every bound here exists so a hostile or buggy caller cannot grow durable
 * storage without limit or push an unbounded string into a storage key. The
 * mailbox validates at admission — before any write — so a rejected command
 * leaves no trace.
 *
 * @module core/application-mailbox-validation
 */

import type {
  ApplicationCommandInput,
  ApplicationMailboxOptions,
} from './application-mailbox-contract.ts';
import {
  ApplicationCommandValidationError,
  MAX_APPLICATION_COMMAND_ATTEMPTS,
  MAX_APPLICATION_IDEMPOTENCY_KEY_BYTES,
  MAX_APPLICATION_IDENTITY_BYTES,
  MAX_APPLICATION_MAILBOX_BACKLOG,
  MAX_APPLICATION_PAYLOAD_REFERENCE_BYTES,
  optionalIdentityOf,
  requireIdentity,
  requireNonNegativeInteger,
  requirePositiveInteger,
} from './application-mailbox-guards.ts';
import type { ApplicationCommandPayload } from './application-mailbox-types.ts';
import { computePayloadDigest, PayloadDigestError } from './application-payload-digest.ts';
import { decode, encode } from './codec.ts';

const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Mailbox defaults resolved once at construction. */
export type ResolvedMailboxPolicy = Readonly<{
  namespace: string;
  resourceId: string;
  maxBacklog: number;
  visibilityTimeoutMs: number;
  commandTimeoutMs: number;
  maxAttempts: number;
  retryBackoffMs: number;
  maxRetryBackoffMs: number;
  terminalRetentionMs: number;
  maxInlinePayloadBytes: number;
  maintenanceBatchSize: number;
}>;

const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 86_400_000;
/** A year of milliseconds: the ceiling for any configured duration. */
const MAX_DURATION_MS = 31_536_000_000;

/**
 * Resolve and range-check the mailbox construction options.
 *
 * @throws {ApplicationCommandValidationError} When any option is out of range.
 */
export function resolveMailboxPolicy(options: ApplicationMailboxOptions): ResolvedMailboxPolicy {
  return {
    namespace: requireIdentity(options.namespace, 'namespace', MAX_APPLICATION_IDENTITY_BYTES),
    resourceId: requireIdentity(options.resourceId, 'resourceId', MAX_APPLICATION_IDENTITY_BYTES),
    maxBacklog: requirePositiveInteger(
      options.maxBacklog ?? 1000,
      'maxBacklog',
      MAX_APPLICATION_MAILBOX_BACKLOG,
    ),
    visibilityTimeoutMs: requirePositiveInteger(
      options.visibilityTimeoutMs ?? 30_000,
      'visibilityTimeoutMs',
      MAX_DURATION_MS,
    ),
    commandTimeoutMs: requirePositiveInteger(
      options.commandTimeoutMs ?? ONE_HOUR_MS,
      'commandTimeoutMs',
      MAX_DURATION_MS,
    ),
    maxAttempts: requirePositiveInteger(
      options.maxAttempts ?? 3,
      'maxAttempts',
      MAX_APPLICATION_COMMAND_ATTEMPTS,
    ),
    retryBackoffMs: requirePositiveInteger(
      options.retryBackoffMs ?? 1000,
      'retryBackoffMs',
      MAX_DURATION_MS,
    ),
    maxRetryBackoffMs: requirePositiveInteger(
      options.maxRetryBackoffMs ?? 60_000,
      'maxRetryBackoffMs',
      MAX_DURATION_MS,
    ),
    terminalRetentionMs: requirePositiveInteger(
      options.terminalRetentionMs ?? ONE_DAY_MS,
      'terminalRetentionMs',
      MAX_DURATION_MS,
    ),
    maxInlinePayloadBytes: requirePositiveInteger(
      options.maxInlinePayloadBytes ?? 262_144,
      'maxInlinePayloadBytes',
      64 * 1024 * 1024,
    ),
    maintenanceBatchSize: requirePositiveInteger(
      options.maintenanceBatchSize ?? 500,
      'maintenanceBatchSize',
      10_000,
    ),
  };
}

/** A validated command input with its digest and effective per-command policy resolved. */
export type ValidatedCommandInput = Readonly<{
  caller: string;
  target: string;
  kind: string;
  payload: ApplicationCommandPayload;
  payloadDigest: string;
  payloadMediaType?: string | undefined;
  payloadSchema?: string | undefined;
  idempotencyKey?: string | undefined;
  causation?: ApplicationCommandInput['causation'] | undefined;
  availableAfterMs: number;
  maxAttempts: number;
  visibilityTimeoutMs: number;
  commandTimeoutMs: number;
}>;

async function validateInlinePayload(
  payload: object,
  maxInlinePayloadBytes: number,
): Promise<{ payload: ApplicationCommandPayload; digest: string }> {
  const value: unknown = Reflect.get(payload, 'value');
  // Snapshot BEFORE anything is awaited, then size-check and digest the snapshot.
  // Digesting awaits Web Crypto, so a caller mutating its object during that await
  // would otherwise have the new bytes persisted under the old digest — and the
  // resulting command fails verification at the FIFO head, blocking every command
  // behind it. Taking the snapshot first makes the digested bytes and the stored
  // bytes the same bytes by construction.
  let encoded: Uint8Array;
  try {
    encoded = encode(value);
  } catch (cause) {
    throw new ApplicationCommandValidationError(
      'payload.value is not encodable by the structured-clone codec.',
      { cause },
    );
  }
  if (encoded.byteLength > maxInlinePayloadBytes) {
    throw new ApplicationCommandValidationError(
      `payload.value encodes to ${encoded.byteLength} bytes, over the ${maxInlinePayloadBytes}-byte inline ceiling. Store it behind a content-addressed reference instead.`,
    );
  }
  const snapshot: unknown = decode(encoded);
  try {
    return {
      payload: { form: 'inline', value: snapshot },
      digest: await computePayloadDigest(snapshot),
    };
  } catch (cause) {
    if (cause instanceof PayloadDigestError) {
      throw new ApplicationCommandValidationError(
        `payload.value cannot be digested: ${cause.message}`,
        { cause },
      );
    }
    throw cause;
  }
}

function validateReferencePayload(payload: object): {
  payload: ApplicationCommandPayload;
  digest: string;
} {
  const reference = requireIdentity(
    Reflect.get(payload, 'reference'),
    'payload.reference',
    MAX_APPLICATION_PAYLOAD_REFERENCE_BYTES,
  );
  const digest: unknown = Reflect.get(payload, 'digest');
  if (typeof digest !== 'string' || !HEX_DIGEST_PATTERN.test(digest)) {
    throw new ApplicationCommandValidationError(
      'payload.digest must be a 64-character lowercase hexadecimal SHA-256 digest. A reference payload has no other way to bind idempotency to payload identity.',
    );
  }
  const rawByteLength: unknown = Reflect.get(payload, 'byteLength');
  if (rawByteLength === undefined) {
    return { payload: { form: 'reference', reference, digest }, digest };
  }
  const referencedBytes = requireNonNegativeInteger(
    rawByteLength,
    'payload.byteLength',
    Number.MAX_SAFE_INTEGER,
  );
  return {
    payload: { form: 'reference', reference, digest, byteLength: referencedBytes },
    digest,
  };
}

async function validatePayload(
  payload: unknown,
  maxInlinePayloadBytes: number,
): Promise<{ payload: ApplicationCommandPayload; digest: string }> {
  if (typeof payload !== 'object' || payload === null || !('form' in payload)) {
    throw new ApplicationCommandValidationError(
      'payload must be an inline or reference payload object.',
    );
  }
  const form: unknown = Reflect.get(payload, 'form');
  if (form === 'inline') return validateInlinePayload(payload, maxInlinePayloadBytes);
  if (form !== 'reference') {
    throw new ApplicationCommandValidationError("payload.form must be 'inline' or 'reference'.");
  }
  return validateReferencePayload(payload);
}

function validateCausation(
  causation: ApplicationCommandInput['causation'],
): ApplicationCommandInput['causation'] {
  if (causation === undefined) return undefined;
  // `typeof null === 'object'`, so the null case needs naming or it escapes as a
  // raw TypeError from the field reads below.
  if (typeof causation !== 'object' || causation === null) {
    throw new ApplicationCommandValidationError('causation must be an object when present.');
  }
  const correlationId = optionalIdentityOf(
    causation.correlationId,
    'causation.correlationId',
    MAX_APPLICATION_IDENTITY_BYTES,
  );
  const causationId = optionalIdentityOf(
    causation.causationId,
    'causation.causationId',
    MAX_APPLICATION_IDENTITY_BYTES,
  );
  const traceparent = optionalIdentityOf(
    causation.traceparent,
    'causation.traceparent',
    MAX_APPLICATION_IDENTITY_BYTES,
  );
  if (correlationId === undefined && causationId === undefined && traceparent === undefined) {
    return undefined;
  }
  return { correlationId, causationId, traceparent };
}

/**
 * Validate one command offered for admission and resolve its effective policy.
 *
 * @throws {ApplicationCommandValidationError} When any field is missing,
 * oversized, or out of range.
 */
export async function validateCommandInput(
  input: ApplicationCommandInput,
  policy: ResolvedMailboxPolicy,
): Promise<ValidatedCommandInput> {
  if (typeof input !== 'object' || input === null) {
    throw new ApplicationCommandValidationError('command must be an object.');
  }
  const { payload, digest } = await validatePayload(input.payload, policy.maxInlinePayloadBytes);
  return {
    caller: requireIdentity(input.caller, 'caller', MAX_APPLICATION_IDENTITY_BYTES),
    target: requireIdentity(input.target, 'target', MAX_APPLICATION_IDENTITY_BYTES),
    kind: requireIdentity(input.kind, 'kind', MAX_APPLICATION_IDENTITY_BYTES),
    payload,
    payloadDigest: digest,
    payloadMediaType: optionalIdentityOf(
      input.payloadMediaType,
      'payloadMediaType',
      MAX_APPLICATION_IDENTITY_BYTES,
    ),
    payloadSchema: optionalIdentityOf(
      input.payloadSchema,
      'payloadSchema',
      MAX_APPLICATION_IDENTITY_BYTES,
    ),
    idempotencyKey: optionalIdentityOf(
      input.idempotencyKey,
      'idempotencyKey',
      MAX_APPLICATION_IDEMPOTENCY_KEY_BYTES,
    ),
    causation: validateCausation(input.causation),
    availableAfterMs: requireNonNegativeInteger(
      input.availableAfterMs ?? 0,
      'availableAfterMs',
      MAX_DURATION_MS,
    ),
    maxAttempts: requirePositiveInteger(
      input.maxAttempts ?? policy.maxAttempts,
      'maxAttempts',
      MAX_APPLICATION_COMMAND_ATTEMPTS,
    ),
    visibilityTimeoutMs: requirePositiveInteger(
      input.visibilityTimeoutMs ?? policy.visibilityTimeoutMs,
      'visibilityTimeoutMs',
      MAX_DURATION_MS,
    ),
    commandTimeoutMs: requirePositiveInteger(
      input.commandTimeoutMs ?? policy.commandTimeoutMs,
      'commandTimeoutMs',
      MAX_DURATION_MS,
    ),
  };
}

export {
  ApplicationCommandValidationError,
  clampListLimit,
  DEFAULT_WAIT_POLL_INTERVAL_MS,
  MAX_APPLICATION_COMMAND_ATTEMPTS,
  MAX_APPLICATION_IDEMPOTENCY_KEY_BYTES,
  MAX_APPLICATION_IDENTITY_BYTES,
  MAX_APPLICATION_MAILBOX_BACKLOG,
  MAX_APPLICATION_MAILBOX_LIST_LIMIT,
  MAX_APPLICATION_PAYLOAD_REFERENCE_BYTES,
  MAX_CANCELLATION_REASON_BYTES,
  MAX_FAILURE_MESSAGE_BYTES,
  requireClockInstant,
  requireDerivedInstant,
  requireGeneratedIdentifier,
  requireMaintenanceInstant,
  requireWaitBudget,
  validateCancellationReason,
  validateDurableJSONValue,
  validateFailure,
} from './application-mailbox-guards.ts';
