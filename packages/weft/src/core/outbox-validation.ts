/**
 * Bounds and input validation for the durable application delivery outbox
 * (WFT-85): construction options, offered deliveries, and adapter outcomes.
 *
 * Every bound here exists so a hostile or buggy caller — or a misbehaving
 * transport — cannot grow durable storage without limit, push an unbounded
 * string into a storage key, or write a record the decoder rejects. The outbox
 * validates at the boundary, before any write, so a rejected input leaves no
 * trace.
 *
 * @module core/outbox-validation
 */

import { createPayloadValidators } from './application-primitive-payload.ts';
import type { JSONValue } from './json.ts';
import type {
  ApplicationDeliveryInput,
  ApplicationDeliveryOutcome,
  OutboxOptions,
} from './outbox-contract.ts';
import {
  ApplicationDeliveryValidationError,
  MAX_APPLICATION_DELIVERY_ATTEMPTS,
  MAX_APPLICATION_DELIVERY_IDEMPOTENCY_KEY_BYTES,
  MAX_APPLICATION_IDENTITY_BYTES,
  MAX_DELIVERY_FAILURE_MESSAGE_BYTES,
  MAX_OUTBOX_BACKLOG,
  MAX_TIMER_DELAY_MS,
  optionalIdentityOf,
  requireIdentity,
  requireNonNegativeInteger,
  requirePositiveInteger,
  validateDurableJSONValue,
  validateFailureEvidence,
} from './outbox-guards.ts';
import type {
  ApplicationDeliveryFailure,
  ApplicationDeliveryPayload,
  ApplicationDeliveryUnknownOutcomePolicy,
} from './outbox-types.ts';

const { validatePayload, validateCausation } = createPayloadValidators(
  ApplicationDeliveryValidationError,
);

const UNKNOWN_OUTCOME_POLICIES: ReadonlySet<string> =
  new Set<ApplicationDeliveryUnknownOutcomePolicy>([
    'park',
    'dead-letter',
    'retry-with-idempotency',
  ]);

const ONE_DAY_MS = 86_400_000;
/** A year of milliseconds: the ceiling for any configured duration. */
const MAX_DURATION_MS = 31_536_000_000;

/** Outbox defaults resolved once at construction. */
export type ResolvedOutboxPolicy = Readonly<{
  namespace: string;
  ownerId: string;
  maxBacklog: number;
  visibilityTimeoutMs: number;
  attemptTimeoutMs: number;
  maxAttempts: number;
  retryBackoffMs: number;
  maxRetryBackoffMs: number;
  terminalRetentionMs: number;
  maxInlinePayloadBytes: number;
  maintenanceBatchSize: number;
  unknownOutcomePolicy: ApplicationDeliveryUnknownOutcomePolicy;
  backgroundTasks: 'automatic' | 'manual';
  maintenanceIntervalMs: number;
}>;

function requirePolicy(value: unknown, field: string): ApplicationDeliveryUnknownOutcomePolicy {
  if (typeof value !== 'string' || !UNKNOWN_OUTCOME_POLICIES.has(value)) {
    throw new ApplicationDeliveryValidationError(
      `${field} must be one of ${[...UNKNOWN_OUTCOME_POLICIES].join(', ')}.`,
    );
  }
  // Membership in the set of policy names was just proved.
  return value as ApplicationDeliveryUnknownOutcomePolicy;
}

/**
 * Resolve and range-check the outbox construction options.
 *
 * `attemptTimeoutMs` and `maintenanceIntervalMs` are each scheduled as one
 * timer, so they are bounded by the largest delay a timer honours rather than
 * by the general duration ceiling: a larger value would be clamped to a tick by
 * the runtime, and every attempt would abort at once.
 *
 * @throws {ApplicationDeliveryValidationError} When any option is out of range.
 */
export function resolveOutboxPolicy(options: OutboxOptions): ResolvedOutboxPolicy {
  const backgroundTasks = options.backgroundTasks ?? 'manual';
  if (backgroundTasks !== 'manual' && backgroundTasks !== 'automatic') {
    throw new ApplicationDeliveryValidationError(
      "backgroundTasks must be 'manual' or 'automatic'.",
    );
  }
  return {
    namespace: requireIdentity(options.namespace, 'namespace', MAX_APPLICATION_IDENTITY_BYTES),
    ownerId: requireIdentity(options.ownerId, 'ownerId', MAX_APPLICATION_IDENTITY_BYTES),
    ...resolveBounds(options),
    unknownOutcomePolicy: requirePolicy(
      options.unknownOutcomePolicy ?? 'park',
      'unknownOutcomePolicy',
    ),
    backgroundTasks,
  };
}

/** The numeric bounds of the policy, each defaulted then range-checked. */
function positive(
  value: number | undefined,
  fallback: number,
  field: string,
  maximum: number,
): number {
  return requirePositiveInteger(value ?? fallback, field, maximum);
}

function resolveBounds(options: OutboxOptions) {
  return {
    maxBacklog: positive(options.maxBacklog, 1000, 'maxBacklog', MAX_OUTBOX_BACKLOG),
    visibilityTimeoutMs: positive(
      options.visibilityTimeoutMs,
      30_000,
      'visibilityTimeoutMs',
      MAX_DURATION_MS,
    ),
    attemptTimeoutMs: positive(
      options.attemptTimeoutMs,
      300_000,
      'attemptTimeoutMs',
      MAX_TIMER_DELAY_MS,
    ),
    maxAttempts: positive(options.maxAttempts, 3, 'maxAttempts', MAX_APPLICATION_DELIVERY_ATTEMPTS),
    retryBackoffMs: positive(options.retryBackoffMs, 1000, 'retryBackoffMs', MAX_DURATION_MS),
    maxRetryBackoffMs: positive(
      options.maxRetryBackoffMs,
      60_000,
      'maxRetryBackoffMs',
      MAX_DURATION_MS,
    ),
    terminalRetentionMs: positive(
      options.terminalRetentionMs,
      ONE_DAY_MS,
      'terminalRetentionMs',
      MAX_DURATION_MS,
    ),
    maxInlinePayloadBytes: positive(
      options.maxInlinePayloadBytes,
      262_144,
      'maxInlinePayloadBytes',
      64 * 1024 * 1024,
    ),
    maintenanceBatchSize: positive(
      options.maintenanceBatchSize,
      500,
      'maintenanceBatchSize',
      10_000,
    ),
    maintenanceIntervalMs: positive(
      options.maintenanceIntervalMs,
      1000,
      'maintenanceIntervalMs',
      MAX_TIMER_DELAY_MS,
    ),
  } as const;
}

/** A validated delivery input with its digest and effective per-delivery policy resolved. */
export type ValidatedDeliveryInput = Readonly<{
  destinationRef: string;
  credentialRef?: string | undefined;
  kind: string;
  payload: ApplicationDeliveryPayload;
  payloadDigest: string;
  payloadMediaType?: string | undefined;
  payloadSchema?: string | undefined;
  idempotencyKey?: string | undefined;
  externalIdempotencyKey?: string | undefined;
  unknownOutcomePolicy: ApplicationDeliveryUnknownOutcomePolicy;
  causation?: ApplicationDeliveryInput['causation'] | undefined;
  availableAfterMs: number;
  maxAttempts: number;
  visibilityTimeoutMs: number;
  attemptTimeoutMs: number;
}>;

/**
 * Validate one delivery offered for enqueue and resolve its effective policy.
 *
 * The unknown-outcome policy and the external idempotency evidence are
 * validated together here, so a record with `retry-with-idempotency` and no
 * `externalIdempotencyKey` can never exist: recovery never has to decide what
 * to do with a retry it cannot make safely.
 *
 * @throws {ApplicationDeliveryValidationError} When any field is missing,
 * oversized, out of range, or the policy lacks its evidence.
 */
export async function validateDeliveryInput(
  input: ApplicationDeliveryInput,
  policy: ResolvedOutboxPolicy,
): Promise<ValidatedDeliveryInput> {
  if (typeof input !== 'object' || input === null) {
    throw new ApplicationDeliveryValidationError('delivery must be an object.');
  }
  const { payload, digest } = await validatePayload(input.payload, policy.maxInlinePayloadBytes);
  const unknownOutcomePolicy = requirePolicy(
    input.unknownOutcomePolicy ?? policy.unknownOutcomePolicy,
    'unknownOutcomePolicy',
  );
  const externalIdempotencyKey = optionalIdentityOf(
    input.externalIdempotencyKey,
    'externalIdempotencyKey',
    MAX_APPLICATION_DELIVERY_IDEMPOTENCY_KEY_BYTES,
  );
  if (unknownOutcomePolicy === 'retry-with-idempotency' && externalIdempotencyKey === undefined) {
    throw new ApplicationDeliveryValidationError(
      "unknownOutcomePolicy 'retry-with-idempotency' requires externalIdempotencyKey: without stable external idempotency evidence a retry after an unknown outcome could duplicate the effect.",
    );
  }
  return {
    destinationRef: requireIdentity(
      input.destinationRef,
      'destinationRef',
      MAX_APPLICATION_IDENTITY_BYTES,
    ),
    credentialRef: optionalIdentityOf(
      input.credentialRef,
      'credentialRef',
      MAX_APPLICATION_IDENTITY_BYTES,
    ),
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
      MAX_APPLICATION_DELIVERY_IDEMPOTENCY_KEY_BYTES,
    ),
    externalIdempotencyKey,
    unknownOutcomePolicy,
    causation: validateCausation(input.causation),
    availableAfterMs: requireNonNegativeInteger(
      input.availableAfterMs ?? 0,
      'availableAfterMs',
      MAX_DURATION_MS,
    ),
    maxAttempts: requirePositiveInteger(
      input.maxAttempts ?? policy.maxAttempts,
      'maxAttempts',
      MAX_APPLICATION_DELIVERY_ATTEMPTS,
    ),
    visibilityTimeoutMs: requirePositiveInteger(
      input.visibilityTimeoutMs ?? policy.visibilityTimeoutMs,
      'visibilityTimeoutMs',
      MAX_DURATION_MS,
    ),
    attemptTimeoutMs: requirePositiveInteger(
      input.attemptTimeoutMs ?? policy.attemptTimeoutMs,
      'attemptTimeoutMs',
      MAX_TIMER_DELAY_MS,
    ),
  };
}

/** A transport outcome with every caller-supplied field validated and snapshotted. */
export type ValidatedOutcome =
  | { readonly status: 'acknowledged'; readonly evidence: JSONValue | undefined }
  | {
      readonly status: 'retryable';
      readonly failure: ApplicationDeliveryFailure;
      readonly retryAfterMs: number | undefined;
    }
  | { readonly status: 'rejected'; readonly failure: ApplicationDeliveryFailure }
  | {
      readonly status: 'unknown';
      readonly failure: {
        readonly reason: 'unknown-outcome';
        readonly message?: string | undefined;
      };
    };

/**
 * Validate what a transport reported before it becomes durable evidence.
 *
 * A malformed outcome — not an object, an unknown status, `NaN` for
 * `retryAfterMs`, a `Map` as evidence — is not a caller mistake the outbox can
 * refuse: the send may already have happened. It is therefore mapped to
 * `unknown` with a diagnostic message, so the delivery follows the unknown-
 * outcome policy instead of being retried on the strength of nothing.
 */
export function validateOutcome(outcome: unknown): ValidatedOutcome {
  try {
    return readOutcome(outcome);
  } catch (error) {
    if (error instanceof ApplicationDeliveryValidationError) {
      return {
        status: 'unknown',
        failure: {
          reason: 'unknown-outcome',
          message: `The transport adapter returned a malformed outcome: ${error.message}`,
        },
      };
    }
    throw error;
  }
}

function readOutcome(outcome: unknown): ValidatedOutcome {
  if (typeof outcome !== 'object' || outcome === null || !('status' in outcome)) {
    throw new ApplicationDeliveryValidationError('outcome must be an object with a status.');
  }
  const candidate = outcome as Partial<Record<keyof ApplicationDeliveryOutcome, unknown>> & {
    readonly evidence?: unknown;
    readonly details?: unknown;
    readonly retryAfterMs?: unknown;
    readonly message?: unknown;
  };
  switch (candidate.status) {
    case 'acknowledged':
      return {
        status: 'acknowledged',
        evidence: validateDurableJSONValue(candidate.evidence, 'evidence'),
      };
    case 'retryable':
      return {
        status: 'retryable',
        failure: validateFailureEvidence('retryable', candidate.message, candidate.details),
        retryAfterMs:
          candidate.retryAfterMs === undefined
            ? undefined
            : requireNonNegativeInteger(candidate.retryAfterMs, 'retryAfterMs', MAX_DURATION_MS),
      };
    case 'rejected':
      return {
        status: 'rejected',
        failure: validateFailureEvidence('application', candidate.message, candidate.details),
      };
    case 'unknown':
      return {
        status: 'unknown',
        failure: {
          reason: 'unknown-outcome',
          message: optionalIdentityOf(
            candidate.message,
            'message',
            MAX_DELIVERY_FAILURE_MESSAGE_BYTES,
          ),
        },
      };
    default:
      throw new ApplicationDeliveryValidationError(
        "outcome.status must be 'acknowledged', 'retryable', 'rejected', or 'unknown'.",
      );
  }
}
