/**
 * Bounds and input validation for the durable application command mailbox
 * (WFT-84).
 *
 * Every bound here exists so a hostile or buggy caller cannot grow durable
 * storage without limit or push an unbounded string into a storage key. The
 * mailbox validates at admission — before any write — so a rejected command
 * leaves no trace.
 *
 * @module core/mailbox-validation
 */

import { createPayloadValidators } from './application-primitive-payload.ts';
import type { ApplicationCommandInput, MailboxOptions } from './mailbox-contract.ts';
import {
  ApplicationCommandValidationError,
  MAX_APPLICATION_COMMAND_ATTEMPTS,
  MAX_APPLICATION_IDEMPOTENCY_KEY_BYTES,
  MAX_APPLICATION_IDENTITY_BYTES,
  MAX_MAILBOX_BACKLOG,
  optionalIdentityOf,
  requireIdentity,
  requireNonNegativeInteger,
  requirePositiveInteger,
} from './mailbox-guards.ts';
import type { ApplicationCommandPayload } from './mailbox-types.ts';

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
export function resolveMailboxPolicy(options: MailboxOptions): ResolvedMailboxPolicy {
  return {
    namespace: requireIdentity(options.namespace, 'namespace', MAX_APPLICATION_IDENTITY_BYTES),
    resourceId: requireIdentity(options.resourceId, 'resourceId', MAX_APPLICATION_IDENTITY_BYTES),
    maxBacklog: requirePositiveInteger(
      options.maxBacklog ?? 1000,
      'maxBacklog',
      MAX_MAILBOX_BACKLOG,
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

const { validatePayload, validateCausation } = createPayloadValidators(
  ApplicationCommandValidationError,
);

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
  MAX_APPLICATION_PAYLOAD_REFERENCE_BYTES,
  MAX_CANCELLATION_REASON_BYTES,
  MAX_FAILURE_MESSAGE_BYTES,
  MAX_MAILBOX_BACKLOG,
  MAX_MAILBOX_LIST_LIMIT,
  requireClockInstant,
  requireDerivedInstant,
  requireGeneratedIdentifier,
  requireMaintenanceInstant,
  requireWaitBudget,
  validateCancellationReason,
  validateDurableJSONValue,
  validateFailure,
} from './mailbox-guards.ts';

/**
 * Validate a caller-supplied command id before it reaches key construction.
 *
 * Every command-scoped operation builds a storage key from this value, and
 * `encodeURIComponent` throws a raw `URIError` on an unpaired surrogate; the
 * contract says caller mistakes surface as `ApplicationCommandValidationError`.
 */
export function validateCommandIdentifier(commandId: unknown): string {
  return requireIdentity(commandId, 'commandId', MAX_APPLICATION_IDENTITY_BYTES);
}
