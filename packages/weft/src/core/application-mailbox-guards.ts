/**
 * Field-level guards for the durable application command mailbox (WFT-84).
 *
 * The generic checks — identities, durable JSON metadata, clock readings,
 * generated identifiers, derived instants, wait budgets — live in
 * `application-primitive-guards.ts` and are bound here to the mailbox's own
 * validation error class, so a mailbox caller always sees
 * `ApplicationCommandValidationError`. What remains here is what only the
 * mailbox validates: its backlog and listing ceilings, a claimant's rejection,
 * and a cancellation reason.
 *
 * Everything here is re-exported from `application-mailbox-validation.ts`, so
 * mailbox callers keep one import path.
 *
 * @module core/application-mailbox-guards
 */

import type { ApplicationCommandRejection } from './application-mailbox-contract.ts';
import type { ApplicationCommandFailure } from './application-mailbox-types.ts';
import { createApplicationGuards } from './application-primitive-guards.ts';
import { WeftError } from './weft-error.ts';

export {
  byteLengthOf,
  DEFAULT_WAIT_POLL_INTERVAL_MS,
  isWellFormedString,
  MAX_APPLICATION_IDENTITY_BYTES,
  MAX_DURABLE_METADATA_BYTES,
  MAX_TIMER_DELAY_MS,
} from './application-primitive-guards.ts';

/** Maximum bytes in an idempotency key. */
export const MAX_APPLICATION_IDEMPOTENCY_KEY_BYTES = 256;
/** Maximum bytes in a content-addressed payload reference. */
export const MAX_APPLICATION_PAYLOAD_REFERENCE_BYTES = 2048;
/** Maximum claims allowed for one command. */
export const MAX_APPLICATION_COMMAND_ATTEMPTS = 100;
/** Maximum open commands a mailbox may be configured to hold. */
export const MAX_APPLICATION_MAILBOX_BACKLOG = 1_000_000;
/** Maximum receipts one `list()` call may return. */
export const MAX_APPLICATION_MAILBOX_LIST_LIMIT = 1000;
/** Maximum bytes in a caller-supplied failure message. */
export const MAX_FAILURE_MESSAGE_BYTES = 2048;
/** Maximum bytes in a caller-supplied cancellation reason. */
export const MAX_CANCELLATION_REASON_BYTES = 2048;

/**
 * Thrown when a caller hands the mailbox something it cannot admit: a missing
 * or oversized identity component, an unusable payload, or an out-of-range
 * policy value.
 *
 * This is a caller mistake, not an expected outcome — a full backlog and an
 * idempotency conflict are returned as discriminated results instead.
 *
 * @example
 * ```ts
 * import { ApplicationCommandValidationError } from '@lostgradient/weft';
 *
 * const error = new ApplicationCommandValidationError('caller must be a non-empty string.');
 * console.log(error.code); // 'ApplicationCommandValidationError'
 * ```
 */
export class ApplicationCommandValidationError extends WeftError<'ApplicationCommandValidationError'> {
  constructor(message: string, options?: ErrorOptions) {
    super('ApplicationCommandValidationError', message, options);
  }
}

const guards = createApplicationGuards(ApplicationCommandValidationError);

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
} = guards;

/**
 * The only failure reason a claimant may supply. `attempts-exhausted`,
 * `deadline-exceeded`, and `cancelled` each name a mailbox-owned terminal
 * mechanism and are synthesized by the transition that owns them; accepting one
 * from `reject()` would persist a `rejected` record whose failure claims a
 * different mechanism produced it.
 */
const CALLER_FAILURE_REASONS: ReadonlySet<ApplicationCommandFailure['reason']> = new Set([
  'application',
]);

/**
 * Validate a caller-supplied failure record before it becomes terminal evidence.
 *
 * @throws {ApplicationCommandValidationError} When `details` is not JSON-safe.
 */
export function validateFailure(failure: ApplicationCommandRejection): ApplicationCommandFailure {
  if (typeof failure !== 'object' || failure === null) {
    throw new ApplicationCommandValidationError('failure must be an object.');
  }
  // Read once: a getter could answer the validation with one value and the
  // snapshot with another, committing a record the decoder rejects as corrupt.
  const reason = failure.reason;
  if (!CALLER_FAILURE_REASONS.has(reason)) {
    throw new ApplicationCommandValidationError(
      `failure.reason must be one of ${[...CALLER_FAILURE_REASONS].join(', ')}; attempts-exhausted, deadline-exceeded, and cancelled are assigned by the mailbox.`,
    );
  }
  const details = validateDurableJSONValue(failure.details, 'failure.details');
  return {
    reason,
    message: optionalIdentityOf(failure.message, 'failure.message', MAX_FAILURE_MESSAGE_BYTES),
    details,
  };
}

/**
 * Validate a caller-supplied cancellation reason before it becomes part of a
 * durable record.
 *
 * @throws {ApplicationCommandValidationError} When the reason is oversized or
 * not well-formed.
 */
export function validateCancellationReason(reason: string | undefined): string | undefined {
  return optionalIdentityOf(reason, 'reason', MAX_CANCELLATION_REASON_BYTES);
}

/**
 * Clamp a caller-supplied listing limit into the bounded range.
 */
export function clampListLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ApplicationCommandValidationError('limit must be a positive safe integer.');
  }
  return Math.min(limit, MAX_APPLICATION_MAILBOX_LIST_LIMIT);
}
