import { afterEach, describe, expect, it } from 'bun:test';

import { assertPayloadWithinLimit } from '../payload-size.ts';
import { decode, encode } from './api.ts';
import {
  registerSerializer,
  resetSerializerRegistryForTesting,
  type SerializerHandlers,
} from './serializer-registry.ts';

// A structured Error subclass that the generic Error encoder would flatten,
// losing `.issues` — the ZodError / custom-validation-error case in miniature.
class ValidationError extends Error {
  readonly issues: ReadonlyArray<{ path: string; code: string }>;
  constructor(message: string, issues: ReadonlyArray<{ path: string; code: string }>) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

const validationErrorHandlers: SerializerHandlers<ValidationError> = {
  toJSON: (error) => ({ message: error.message, issues: error.issues }),
  fromJSON: (data) => {
    const record = data as {
      message: string;
      issues: ReadonlyArray<{ path: string; code: string }>;
    };
    return new ValidationError(record.message, record.issues);
  },
};

describe('registerSerializer', () => {
  afterEach(() => {
    resetSerializerRegistryForTesting();
  });

  it('round-trips a registered Error subclass with its structured fields', () => {
    registerSerializer(ValidationError, validationErrorHandlers);

    const original = new ValidationError('invalid input', [
      { path: 'email', code: 'invalid_string' },
      { path: 'age', code: 'too_small' },
    ]);
    const restored = decode(encode(original)) as ValidationError;

    expect(restored).toBeInstanceOf(ValidationError);
    expect(restored.name).toBe('ValidationError');
    expect(restored.message).toBe('invalid input');
    // The structured field the generic Error encoder would have dropped.
    expect(restored.issues).toEqual([
      { path: 'email', code: 'invalid_string' },
      { path: 'age', code: 'too_small' },
    ]);
  });

  it('round-trips a registered serializer nested inside an array/object', () => {
    registerSerializer(ValidationError, validationErrorHandlers);

    const original = {
      step: 3,
      results: [new ValidationError('bad', [{ path: 'x', code: 'nope' }])],
    };
    const restored = decode(encode(original)) as typeof original;

    expect(restored.step).toBe(3);
    expect(restored.results[0]).toBeInstanceOf(ValidationError);
    expect(restored.results[0]?.issues).toEqual([{ path: 'x', code: 'nope' }]);
  });

  it('leaves a plain Error on the generic name/message/stack encoding', () => {
    // Registering a subclass must not change how a base Error round-trips.
    registerSerializer(ValidationError, validationErrorHandlers);

    const restored = decode(encode(new Error('plain'))) as Error;
    expect(restored).toBeInstanceOf(Error);
    expect(restored.constructor).toBe(Error);
    expect(restored.message).toBe('plain');
  });

  it('falls back to generic Error encoding for an unregistered subclass', () => {
    class UnregisteredError extends Error {
      readonly code = 'X';
    }
    const restored = decode(encode(new UnregisteredError('oops'))) as Error;
    // No serializer registered: subclass fields are lost, but name/message
    // survive via the generic Error encoder — the documented fallback.
    expect(restored).toBeInstanceOf(Error);
    expect(restored.message).toBe('oops');
    expect((restored as UnregisteredError).code).toBeUndefined();
  });

  it('throws on a second registration for the same constructor', () => {
    registerSerializer(ValidationError, validationErrorHandlers);
    expect(() => registerSerializer(ValidationError, validationErrorHandlers)).toThrow(
      /already registered/i,
    );
  });

  it('measures the post-serializer encoded size at payload-size admission', () => {
    registerSerializer(ValidationError, validationErrorHandlers);

    // A serialized ValidationError with many issues is larger than its message
    // alone; payload-size admission must measure the encoded (post-toJSON) form.
    const manyIssues = Array.from({ length: 200 }, (_unused, index) => ({
      path: `field-${index}`,
      code: 'invalid_string_with_a_longish_code',
    }));
    const error = new ValidationError('validation failed', manyIssues);
    const encodedSize = encode(error).byteLength;

    // A limit just under the encoded size rejects; a limit at/above it admits.
    expect(() => assertPayloadWithinLimit(error, encodedSize - 1, 'activity result')).toThrow();
    expect(() => assertPayloadWithinLimit(error, encodedSize, 'activity result')).not.toThrow();
  });

  it('exhausts the reserved extension-type range with a clear error', () => {
    // Reserved range is 100..127 inclusive (28 slots). Registering past it throws.
    for (let index = 0; index < 28; index++) {
      registerSerializer(class extends Error {}, {
        toJSON: (error) => ({ message: error.message }),
        fromJSON: (data) => new Error((data as { message: string }).message),
      });
    }
    expect(() =>
      registerSerializer(class extends Error {}, {
        toJSON: (error) => ({ message: error.message }),
        fromJSON: (data) => new Error((data as { message: string }).message),
      }),
    ).toThrow(/reserved extension-type range is exhausted/i);
  });
});
