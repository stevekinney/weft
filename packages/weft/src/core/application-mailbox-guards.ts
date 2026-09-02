/**
 * Field-level guards for the durable application command mailbox (WFT-84):
 * durable JSON metadata, failure records, injected clock readings, generated
 * identifiers, wait budgets, and bounded listing limits.
 *
 * Split from `application-mailbox-validation.ts` only to keep both files under
 * this repository's file-size ceiling; everything here is re-exported from there,
 * so callers keep one import path.
 *
 * Every guard rejects at the boundary that owns the contract rather than letting
 * a bad value reach durable storage — a record the decoder cannot read back
 * would surface much later as corruption on an unrelated read.
 *
 * @module core/application-mailbox-guards
 */

import type { ApplicationCommandFailure } from './application-mailbox-types.ts';
import { decode, encode } from './codec.ts';
import { isJSONValue, type JSONValue } from './json.ts';
import { WeftError } from './weft-error.ts';
/** Maximum bytes in any opaque identity component (namespace, resource, caller, target, kind). */
export const MAX_APPLICATION_IDENTITY_BYTES = 256;
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

export function byteLengthOf(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function requireIdentity(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApplicationCommandValidationError(`${field} must be a non-empty string.`);
  }
  // `TextEncoder` silently replaces a lone surrogate with U+FFFD, so a byte-length
  // check alone accepts strings that `encodeURIComponent` later rejects — and that
  // rejection would surface as a raw `URIError` from key construction rather than
  // as this module's own diagnostic.
  if (!isWellFormedString(value)) {
    throw new ApplicationCommandValidationError(
      `${field} must be well-formed Unicode: it contains an unpaired surrogate that cannot be encoded into a storage key.`,
    );
  }
  if (byteLengthOf(value) > maxBytes) {
    throw new ApplicationCommandValidationError(
      `${field} must encode to at most ${maxBytes} bytes.`,
    );
  }
  return value;
}

/** Whether a string contains no unpaired surrogate. */
export function isWellFormedString(value: string): boolean {
  return value.isWellFormed();
}

export function optionalIdentityOf(
  value: unknown,
  field: string,
  maxBytes: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requireIdentity(value, field, maxBytes);
}

export function requirePositiveInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ApplicationCommandValidationError(
      `${field} must be a safe integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

export function requireNonNegativeInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new ApplicationCommandValidationError(
      `${field} must be a safe integer between 0 and ${maximum}.`,
    );
  }
  return value;
}

/** Maximum encoded bytes for `outcome`, `progress`, or `failure.details`. */
export const MAX_DURABLE_METADATA_BYTES = 65_536;

/** Maximum bytes in a caller-supplied failure message. */
export const MAX_FAILURE_MESSAGE_BYTES = 2048;

const FAILURE_REASONS: ReadonlySet<ApplicationCommandFailure['reason']> = new Set([
  'application',
  'attempts-exhausted',
  'deadline-exceeded',
  'cancelled',
]);

/**
 * Validate and snapshot a caller-supplied JSON value bound for a durable record.
 *
 * The record decoder requires `isJSONValue`, so a structured-clone value such as
 * a `Map` or a `Date` would encode cleanly here and then make every later
 * `receipt()`, `list()`, and maintenance read fail as corrupt persisted data.
 * Rejecting it at the boundary that owns the contract keeps that failure where
 * the caller can act on it.
 *
 * @throws {ApplicationCommandValidationError} When the value is not JSON-safe.
 */
export function validateDurableJSONValue<TField extends string>(
  value: unknown,
  field: TField,
): JSONValue | undefined {
  if (value === undefined) return undefined;
  // Round-trip first, then check. Snapshotting defends against a caller mutating
  // the object after this returns, and checking the snapshot rather than the
  // input is what the decoder will actually see: a `Map` or `Date` encodes and
  // decodes cleanly as itself and only then fails the JSON contract.
  let snapshot: unknown;
  let encoded: Uint8Array;
  try {
    encoded = encode(value);
    snapshot = decode(encoded);
  } catch (cause) {
    throw new ApplicationCommandValidationError(
      `${field} is not encodable by the structured-clone codec.`,
      { cause },
    );
  }
  if (!isJSONValue(snapshot)) {
    throw new ApplicationCommandValidationError(
      `${field} must be a JSON-safe value: durable records reject anything the record decoder cannot read back.`,
    );
  }
  // Bounded, like every other field on the record. An unbounded value here would
  // let one settlement or a stream of renewals grow a command record without
  // limit, and every later read pays for it.
  if (encoded.byteLength > MAX_DURABLE_METADATA_BYTES) {
    throw new ApplicationCommandValidationError(
      `${field} encodes to ${encoded.byteLength} bytes, over the ${MAX_DURABLE_METADATA_BYTES}-byte durable metadata ceiling.`,
    );
  }
  return snapshot;
}

/**
 * Validate a caller-supplied failure record before it becomes terminal evidence.
 *
 * @throws {ApplicationCommandValidationError} When `details` is not JSON-safe.
 */
export function validateFailure(failure: ApplicationCommandFailure): ApplicationCommandFailure {
  if (typeof failure !== 'object' || failure === null) {
    throw new ApplicationCommandValidationError('failure must be an object.');
  }
  if (!FAILURE_REASONS.has(failure.reason)) {
    throw new ApplicationCommandValidationError(
      `failure.reason must be one of ${[...FAILURE_REASONS].join(', ')}.`,
    );
  }
  const details = validateDurableJSONValue(failure.details, 'failure.details');
  return {
    reason: failure.reason,
    message: optionalIdentityOf(failure.message, 'failure.message', MAX_FAILURE_MESSAGE_BYTES),
    details,
  };
}

/**
 * Validate an injected identifier source's output before it reaches a durable key.
 *
 * `generateId` is caller-supplied. An empty result would write a delivery-index
 * entry the decoder later rejects as corrupt, and an unbounded one would build an
 * unbounded storage key.
 *
 * @throws {ApplicationCommandValidationError} When the generator returns an
 * empty or oversized identifier.
 */
export function requireGeneratedIdentifier(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApplicationCommandValidationError(
      `The configured generateId() returned an empty ${field}; durable keys require a non-empty identifier.`,
    );
  }
  // The same Unicode rule as caller identities: a lone surrogate would pass the
  // length check and then escape as a raw `URIError` from key construction.
  if (!isWellFormedString(value)) {
    throw new ApplicationCommandValidationError(
      `The configured generateId() returned a ${field} containing an unpaired surrogate.`,
    );
  }
  if (byteLengthOf(value) > MAX_APPLICATION_IDENTITY_BYTES) {
    throw new ApplicationCommandValidationError(
      `The configured generateId() returned a ${field} over ${MAX_APPLICATION_IDENTITY_BYTES} bytes.`,
    );
  }
  return value;
}

/**
 * Validate an explicit maintenance instant.
 *
 * A malformed scheduler value is destructive rather than merely wrong: `NaN`
 * makes every comparison false so the retention sweep treats every receipt as
 * expired, and `Infinity` terminalizes open commands with an undecodable
 * `terminalAt`. Reject it before maintenance reads or writes anything.
 *
 * @throws {ApplicationCommandValidationError} When the instant is not a
 * non-negative safe integer.
 */
export function requireClockInstant(now: number, source = 'now()'): number {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
    throw new ApplicationCommandValidationError(
      `The configured ${source} returned ${String(now)}; durable records require a non-negative safe-integer millisecond timestamp.`,
    );
  }
  return now;
}

/**
 * Validate a timestamp derived from a clock reading plus a configured duration.
 *
 * Addition can leave the safe-integer range even when both operands are inside
 * it, and the record decoder rejects the result — so an `admitted` receipt would
 * name a command that blocks the FIFO as corrupt.
 *
 * @throws {ApplicationCommandValidationError} When the sum is not a
 * non-negative safe integer.
 */
export function requireDerivedInstant(instant: number, field: string): number {
  if (!Number.isSafeInteger(instant) || instant < 0) {
    throw new ApplicationCommandValidationError(
      `${field} computed to ${String(instant)}, outside the safe-integer millisecond range durable records accept.`,
    );
  }
  return instant;
}

export function requireMaintenanceInstant(now: number): number {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
    throw new ApplicationCommandValidationError(
      'runMaintenance() requires a non-negative safe-integer timestamp in milliseconds.',
    );
  }
  return now;
}

/**
 * Validate a caller-supplied wait budget and poll interval.
 *
 * `NaN` would make every deadline comparison false and turn a bounded wait into
 * an endless one built on `setTimeout(NaN)`; `Infinity` does the same more
 * obviously. A non-positive poll interval spins.
 *
 * @throws {ApplicationCommandValidationError} When either value is out of range.
 */
export function requireWaitBudget(options: {
  readonly timeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
}): { readonly timeoutMs: number; readonly pollIntervalMs: number } {
  const timeoutMs = options.timeoutMs ?? 0;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new ApplicationCommandValidationError(
      'timeoutMs must be a non-negative safe integer in milliseconds.',
    );
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new ApplicationCommandValidationError(
      'pollIntervalMs must be a positive safe integer in milliseconds.',
    );
  }
  return { timeoutMs, pollIntervalMs };
}

/** Default gap between durable polls for the bounded waits. */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 50;

/** Maximum bytes in a caller-supplied cancellation reason. */
export const MAX_CANCELLATION_REASON_BYTES = 2048;

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
