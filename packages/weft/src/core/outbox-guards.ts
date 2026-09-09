/**
 * The delivery outbox's binding of the shared application guards (WFT-85),
 * plus the ceilings and checks only the outbox needs.
 *
 * Every guard throws `ApplicationDeliveryValidationError`, so a caller mistake
 * surfaces as the outbox's own typed diagnostic rather than as the mailbox's.
 *
 * @module core/outbox-guards
 */

import {
  byteLengthOf,
  createApplicationGuards,
  MAX_APPLICATION_IDENTITY_BYTES,
} from './application-primitive-guards.ts';
import type { ApplicationDeliveryFailure } from './outbox-types.ts';
import { WeftError } from './weft-error.ts';

export {
  DEFAULT_WAIT_POLL_INTERVAL_MS,
  MAX_APPLICATION_IDENTITY_BYTES,
  MAX_DURABLE_METADATA_BYTES,
  MAX_TIMER_DELAY_MS,
} from './application-primitive-guards.ts';
export { MAX_APPLICATION_PAYLOAD_REFERENCE_BYTES } from './application-primitive-payload.ts';

/**
 * Maximum bytes in an idempotency key or an external idempotency key. Matches
 * the persisted-identifier ceiling the record decoder enforces, so a key
 * admission accepts can never be one every later read rejects as corrupt.
 */
export const MAX_APPLICATION_DELIVERY_IDEMPOTENCY_KEY_BYTES = MAX_APPLICATION_IDENTITY_BYTES;

/** Maximum attempts any one delivery may be configured for. */
export const MAX_APPLICATION_DELIVERY_ATTEMPTS = 100;

/** Maximum open deliveries any one outbox may be configured for. */
export const MAX_OUTBOX_BACKLOG = 1_000_000;

/** Ceiling on a `list()` limit. */
export const MAX_OUTBOX_LIST_LIMIT = 1000;

/** Maximum bytes in a failure message. */
export const MAX_DELIVERY_FAILURE_MESSAGE_BYTES = 4096;

/** Maximum bytes in a cancellation reason. */
export const MAX_DELIVERY_CANCELLATION_REASON_BYTES = 1024;

/**
 * Thrown when a caller supplies an invalid delivery, option, identifier, or
 * outcome, or calls a disposed outbox.
 *
 * @example
 * ```ts
 * import { ApplicationDeliveryValidationError } from '@lostgradient/weft';
 *
 * const error = new ApplicationDeliveryValidationError('destinationRef must be a non-empty string.');
 * console.log(error.code); // 'ApplicationDeliveryValidationError'
 * ```
 */
export class ApplicationDeliveryValidationError extends WeftError<'ApplicationDeliveryValidationError'> {
  constructor(message: string, options?: ErrorOptions) {
    super('ApplicationDeliveryValidationError', message, options);
  }
}

export const {
  requireIdentity,
  optionalIdentityOf,
  requirePositiveInteger,
  requireNonNegativeInteger,
  validateDurableJSONValue,
  requireGeneratedIdentifier,
  requireClockInstant,
  requireDerivedInstant,
  requireMaintenanceInstant,
  requireWaitBudget,
} = createApplicationGuards(ApplicationDeliveryValidationError);

/**
 * Validate the message and details a transport attached to an outcome before
 * they become durable evidence. The reason is assigned by the outbox from the
 * outcome's status, never taken from the caller.
 *
 * @throws {ApplicationDeliveryValidationError} When `details` is not JSON-safe
 * or `message` is oversized.
 */
export function validateFailureEvidence(
  reason: ApplicationDeliveryFailure['reason'],
  message: unknown,
  details: unknown,
): ApplicationDeliveryFailure {
  return {
    reason,
    message: optionalIdentityOf(message, 'message', MAX_DELIVERY_FAILURE_MESSAGE_BYTES),
    details: validateDurableJSONValue(details, 'details'),
  };
}

/**
 * Bound a diagnostic string the outbox composes itself (an adapter's thrown
 * error, say) to the failure-message ceiling, cutting on a character boundary
 * and keeping the result well-formed, so a misbehaving transport cannot grow
 * a delivery record without limit.
 */
export function boundFailureMessage(text: string): string {
  let bounded = text.toWellFormed();
  while (byteLengthOf(bounded) > MAX_DELIVERY_FAILURE_MESSAGE_BYTES) {
    const excess = byteLengthOf(bounded) - MAX_DELIVERY_FAILURE_MESSAGE_BYTES;
    bounded = bounded.slice(0, -Math.max(1, Math.ceil(excess / 4))).toWellFormed();
  }
  return bounded;
}

/** Validate a caller-supplied cancellation reason before it becomes durable. */
export function validateCancellationReason(reason: string | undefined): string | undefined {
  return optionalIdentityOf(reason, 'reason', MAX_DELIVERY_CANCELLATION_REASON_BYTES);
}

/** Clamp a caller-supplied listing limit into the bounded range. */
export function clampListLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ApplicationDeliveryValidationError('limit must be a positive safe integer.');
  }
  return Math.min(limit, MAX_OUTBOX_LIST_LIMIT);
}

/**
 * Validate a caller-supplied delivery id before it reaches key construction,
 * where an unpaired surrogate would escape as a raw `URIError`.
 */
export function validateDeliveryIdentifier(deliveryId: unknown): string {
  return requireIdentity(deliveryId, 'deliveryId', 256);
}
