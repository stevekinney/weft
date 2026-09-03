/**
 * Payload and causation validation shared by the durable application
 * primitives (the command mailbox, WFT-84, and the delivery outbox, WFT-85).
 *
 * Both primitives carry the same inline-or-reference payload and the same
 * causal metadata, bound to the same content digest, so the checks are written
 * once and bound to each primitive's own validation error class.
 *
 * @module core/application-primitive-payload
 */

import type {
  ApplicationCommandCausation,
  ApplicationCommandPayload,
} from './application-mailbox-types.ts';
import { computePayloadDigest, PayloadDigestError } from './application-payload-digest.ts';
import {
  createApplicationGuards,
  MAX_APPLICATION_IDENTITY_BYTES,
  type ApplicationValidationErrorClass,
} from './application-primitive-guards.ts';
import { decode, encode } from './codec.ts';

const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Maximum bytes in a content-addressed payload reference. */
export const MAX_APPLICATION_PAYLOAD_REFERENCE_BYTES = 2048;

/** A validated payload with its digest. */
export type ValidatedPayload = {
  readonly payload: ApplicationCommandPayload;
  readonly digest: string;
};

/** The validator set produced by {@link createPayloadValidators}. */
export type PayloadValidators = {
  readonly validatePayload: (
    payload: unknown,
    maxInlinePayloadBytes: number,
  ) => Promise<ValidatedPayload>;
  readonly validateCausation: (
    causation: ApplicationCommandCausation | undefined,
  ) => ApplicationCommandCausation | undefined;
};

/**
 * Bind the shared payload validators to one primitive's validation error
 * class.
 */
export function createPayloadValidators(
  ValidationError: ApplicationValidationErrorClass,
): PayloadValidators {
  const { requireIdentity, optionalIdentityOf, requireNonNegativeInteger } =
    createApplicationGuards(ValidationError);

  const validateInlinePayload = async (
    payload: object,
    maxInlinePayloadBytes: number,
  ): Promise<ValidatedPayload> => {
    const value: unknown = Reflect.get(payload, 'value');
    // Snapshot BEFORE anything is awaited, then size-check and digest the
    // snapshot. Digesting awaits Web Crypto, so a caller mutating its object
    // during that await would otherwise have the new bytes persisted under the
    // old digest, and the record would fail verification at claim time. Taking
    // the snapshot first makes the digested bytes and the stored bytes the same
    // bytes by construction.
    let encoded: Uint8Array;
    try {
      encoded = encode(value);
    } catch (cause) {
      throw new ValidationError('payload.value is not encodable by the structured-clone codec.', {
        cause,
      });
    }
    if (encoded.byteLength > maxInlinePayloadBytes) {
      throw new ValidationError(
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
        throw new ValidationError(`payload.value cannot be digested: ${cause.message}`, { cause });
      }
      throw cause;
    }
  };

  const validateReferencePayload = (payload: object): ValidatedPayload => {
    const reference = requireIdentity(
      Reflect.get(payload, 'reference'),
      'payload.reference',
      MAX_APPLICATION_PAYLOAD_REFERENCE_BYTES,
    );
    const digest: unknown = Reflect.get(payload, 'digest');
    if (typeof digest !== 'string' || !HEX_DIGEST_PATTERN.test(digest)) {
      throw new ValidationError(
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
  };

  const validatePayload = async (
    payload: unknown,
    maxInlinePayloadBytes: number,
  ): Promise<ValidatedPayload> => {
    if (typeof payload !== 'object' || payload === null || !('form' in payload)) {
      throw new ValidationError('payload must be an inline or reference payload object.');
    }
    const form: unknown = Reflect.get(payload, 'form');
    if (form === 'inline') return validateInlinePayload(payload, maxInlinePayloadBytes);
    if (form !== 'reference') {
      throw new ValidationError("payload.form must be 'inline' or 'reference'.");
    }
    return validateReferencePayload(payload);
  };

  const validateCausation = (
    causation: ApplicationCommandCausation | undefined,
  ): ApplicationCommandCausation | undefined => {
    if (causation === undefined) return undefined;
    // `typeof null === 'object'`, so the null case needs naming or it escapes
    // as a raw TypeError from the field reads below.
    if (typeof causation !== 'object' || causation === null) {
      throw new ValidationError('causation must be an object when present.');
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
  };

  return { validatePayload, validateCausation };
}
