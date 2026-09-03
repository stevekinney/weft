/**
 * Field-level guards shared by the durable application primitives (the
 * command mailbox, WFT-84, and the delivery outbox, WFT-85): identity
 * components, durable JSON metadata, injected clock readings, generated
 * identifiers, derived instants, and wait budgets.
 *
 * Every guard rejects at the boundary that owns the contract rather than letting
 * a bad value reach durable storage — a record the decoder cannot read back
 * would surface much later as corruption on an unrelated read.
 *
 * The guards are produced by a factory bound to the primitive's own validation
 * error class, so a mailbox caller sees `ApplicationCommandValidationError` and
 * an outbox caller sees its own, while the checks themselves are written once.
 *
 * @module core/application-primitive-guards
 */

import { decode, encode } from './codec.ts';
import { isJSONValue, type JSONValue } from './json.ts';

/** Maximum bytes in any opaque identity component (namespace, resource, owner, caller, target, kind). */
export const MAX_APPLICATION_IDENTITY_BYTES = 256;

/** Maximum encoded bytes for durable JSON metadata such as an outcome, progress, or failure details. */
export const MAX_DURABLE_METADATA_BYTES = 65_536;

/**
 * The largest delay `setTimeout` schedules faithfully (a signed 32-bit
 * millisecond count). A larger value is clamped to a tick by the runtime, which
 * would turn a rare poll into a tight loop against durable storage.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Default gap between durable polls for the bounded waits. */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 50;

/** The UTF-8 length of a string. */
export function byteLengthOf(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Whether a string contains no unpaired surrogate. */
export function isWellFormedString(value: string): boolean {
  return value.isWellFormed();
}

/** A validation error class a primitive binds its guards to. */
export type ApplicationValidationErrorClass = new (
  message: string,
  options?: ErrorOptions,
) => Error;

/** The guard set produced by {@link createApplicationGuards}. */
export type ApplicationGuards = {
  readonly requireIdentity: (value: unknown, field: string, maxBytes: number) => string;
  readonly optionalIdentityOf: (
    value: unknown,
    field: string,
    maxBytes: number,
  ) => string | undefined;
  readonly requirePositiveInteger: (value: unknown, field: string, maximum: number) => number;
  readonly requireNonNegativeInteger: (value: unknown, field: string, maximum: number) => number;
  readonly validateDurableJSONValue: (value: unknown, field: string) => JSONValue | undefined;
  readonly requireGeneratedIdentifier: (value: string, field: string) => string;
  readonly requireClockInstant: (now: number, source?: string) => number;
  readonly requireDerivedInstant: (instant: number, field: string) => number;
  readonly requireMaintenanceInstant: (now: number) => number;
  readonly requireWaitBudget: (options: {
    readonly timeoutMs?: number | undefined;
    readonly pollIntervalMs?: number | undefined;
  }) => { readonly timeoutMs: number; readonly pollIntervalMs: number };
};

/**
 * Bind the shared guards to one primitive's validation error class.
 *
 * Every guard throws an instance of `ValidationError`, so callers and tests of
 * the mailbox keep matching `ApplicationCommandValidationError` while the
 * outbox matches its own class.
 */
export function createApplicationGuards(
  ValidationError: ApplicationValidationErrorClass,
): ApplicationGuards {
  const requireIdentity = (value: unknown, field: string, maxBytes: number): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ValidationError(`${field} must be a non-empty string.`);
    }
    // `TextEncoder` silently replaces a lone surrogate with U+FFFD, so a
    // byte-length check alone accepts strings that `encodeURIComponent` later
    // rejects — and that rejection would surface as a raw `URIError` from key
    // construction rather than as this module's own diagnostic.
    if (!isWellFormedString(value)) {
      throw new ValidationError(
        `${field} must be well-formed Unicode: it contains an unpaired surrogate that cannot be encoded into a storage key.`,
      );
    }
    if (byteLengthOf(value) > maxBytes) {
      throw new ValidationError(`${field} must encode to at most ${maxBytes} bytes.`);
    }
    return value;
  };

  const optionalIdentityOf = (
    value: unknown,
    field: string,
    maxBytes: number,
  ): string | undefined => {
    if (value === undefined) return undefined;
    return requireIdentity(value, field, maxBytes);
  };

  const requirePositiveInteger = (value: unknown, field: string, maximum: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new ValidationError(`${field} must be a safe integer between 1 and ${maximum}.`);
    }
    return value;
  };

  const requireNonNegativeInteger = (value: unknown, field: string, maximum: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new ValidationError(`${field} must be a safe integer between 0 and ${maximum}.`);
    }
    return value;
  };

  /**
   * Validate and snapshot a caller-supplied JSON value bound for a durable
   * record. The record decoders require `isJSONValue`, so a structured-clone
   * value such as a `Map` or a `Date` would encode cleanly here and then make
   * every later read fail as corrupt persisted data. Round-trip first, then
   * check the snapshot — that is what the decoder will actually see — and bound
   * it, so one settlement or a stream of renewals cannot grow a record without
   * limit.
   */
  const validateDurableJSONValue = (value: unknown, field: string): JSONValue | undefined => {
    if (value === undefined) return undefined;
    let snapshot: unknown;
    let encoded: Uint8Array;
    try {
      encoded = encode(value);
      snapshot = decode(encoded);
    } catch (cause) {
      throw new ValidationError(`${field} is not encodable by the structured-clone codec.`, {
        cause,
      });
    }
    if (!isJSONValue(snapshot)) {
      throw new ValidationError(
        `${field} must be a JSON-safe value: durable records reject anything the record decoder cannot read back.`,
      );
    }
    if (encoded.byteLength > MAX_DURABLE_METADATA_BYTES) {
      throw new ValidationError(
        `${field} encodes to ${encoded.byteLength} bytes, over the ${MAX_DURABLE_METADATA_BYTES}-byte durable metadata ceiling.`,
      );
    }
    return snapshot;
  };

  /**
   * Validate an injected identifier source's output before it reaches a durable
   * key. An empty result would write an index entry the decoder later rejects
   * as corrupt, an unpaired surrogate would escape as a raw `URIError` from key
   * construction, and an unbounded one would build an unbounded storage key.
   */
  const requireGeneratedIdentifier = (value: string, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ValidationError(
        `The configured generateId() returned an empty ${field}; durable keys require a non-empty identifier.`,
      );
    }
    if (!isWellFormedString(value)) {
      throw new ValidationError(
        `The configured generateId() returned a ${field} containing an unpaired surrogate.`,
      );
    }
    if (byteLengthOf(value) > MAX_APPLICATION_IDENTITY_BYTES) {
      throw new ValidationError(
        `The configured generateId() returned a ${field} over ${MAX_APPLICATION_IDENTITY_BYTES} bytes.`,
      );
    }
    return value;
  };

  /**
   * Validate a clock reading. `NaN` makes every comparison false so a retention
   * sweep treats every receipt as expired, and `Infinity` terminalizes open
   * records with an undecodable instant; reject before anything is read or
   * written on the strength of it.
   */
  const requireClockInstant = (now: number, source = 'now()'): number => {
    if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
      throw new ValidationError(
        `The configured ${source} returned ${String(now)}; durable records require a non-negative safe-integer millisecond timestamp.`,
      );
    }
    return now;
  };

  /**
   * Validate a timestamp derived from a clock reading plus a configured
   * duration. Addition can leave the safe-integer range even when both operands
   * are inside it, and the record decoder rejects the result.
   */
  const requireDerivedInstant = (instant: number, field: string): number => {
    if (!Number.isSafeInteger(instant) || instant < 0) {
      throw new ValidationError(
        `${field} computed to ${String(instant)}, outside the safe-integer millisecond range durable records accept.`,
      );
    }
    return instant;
  };

  const requireMaintenanceInstant = (now: number): number => {
    if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
      throw new ValidationError(
        'runMaintenance() requires a non-negative safe-integer timestamp in milliseconds.',
      );
    }
    return now;
  };

  /**
   * Validate a caller-supplied wait budget and poll interval. `NaN` would make
   * every deadline comparison false and turn a bounded wait into an endless one
   * built on `setTimeout(NaN)`; a non-positive poll interval spins; and either
   * value past the timer ceiling would be clamped to a tick by the runtime, so
   * the in-flight budget — scheduled as one timer — is bounded to it too.
   */
  const requireWaitBudget = (options: {
    readonly timeoutMs?: number | undefined;
    readonly pollIntervalMs?: number | undefined;
  }): { readonly timeoutMs: number; readonly pollIntervalMs: number } => {
    const timeoutMs = options.timeoutMs ?? 0;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
      throw new ValidationError(
        `timeoutMs must be a non-negative safe integer of at most ${MAX_TIMER_DELAY_MS} milliseconds, the largest delay a timer can schedule; the in-flight budget is scheduled as one timer.`,
      );
    }
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
    if (
      !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs < 1 ||
      pollIntervalMs > MAX_TIMER_DELAY_MS
    ) {
      throw new ValidationError(
        `pollIntervalMs must be a positive safe integer of at most ${MAX_TIMER_DELAY_MS} milliseconds, the largest delay a timer can schedule.`,
      );
    }
    return { timeoutMs, pollIntervalMs };
  };

  return {
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
  };
}
