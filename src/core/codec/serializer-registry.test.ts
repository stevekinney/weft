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
    registerSerializer(ValidationError, validationErrorHandlers, { tag: 'ValidationError' });

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
    registerSerializer(ValidationError, validationErrorHandlers, { tag: 'ValidationError' });

    const original = {
      step: 3,
      results: [new ValidationError('bad', [{ path: 'x', code: 'nope' }])],
    };
    const restored = decode(encode(original)) as typeof original;

    expect(restored.step).toBe(3);
    expect(restored.results[0]).toBeInstanceOf(ValidationError);
    expect(restored.results[0]?.issues).toEqual([{ path: 'x', code: 'nope' }]);
  });

  it('decodes by embedded tag, not registration order — order is irrelevant', () => {
    // Regression for the registration-order-id hazard: bytes encoded when types
    // were registered in one order must decode correctly when a later process
    // registers them in a DIFFERENT order. The tag travels in the payload, so
    // decode resolves the right handler regardless of order.
    class Alpha {
      constructor(readonly value: string) {}
    }
    class Beta {
      constructor(readonly count: number) {}
    }
    const alphaHandlers: SerializerHandlers<Alpha> = {
      toJSON: (a) => ({ value: a.value }),
      fromJSON: (d) => new Alpha((d as { value: string }).value),
    };
    const betaHandlers: SerializerHandlers<Beta> = {
      toJSON: (b) => ({ count: b.count }),
      fromJSON: (d) => new Beta((d as { count: number }).count),
    };

    // Process 1: register Alpha THEN Beta, encode an Alpha instance.
    registerSerializer(Alpha, alphaHandlers, { tag: 'alpha' });
    registerSerializer(Beta, betaHandlers, { tag: 'beta' });
    const bytes = encode(new Alpha('hello'));

    // Process 2 (simulated): same tags, registered Beta THEN Alpha — the reverse.
    resetSerializerRegistryForTesting();
    registerSerializer(Beta, betaHandlers, { tag: 'beta' });
    registerSerializer(Alpha, alphaHandlers, { tag: 'alpha' });

    const restored = decode(bytes) as Alpha;
    // Without tag-based decode (positional ids), this would deserialize as Beta.
    expect(restored).toBeInstanceOf(Alpha);
    expect(restored.value).toBe('hello');
  });

  it('preserves undefined fields in a custom serializer result, like the public codec', () => {
    // A custom toJSON() result with an `undefined` field must round-trip with the
    // same semantics as the public encode(): the field is preserved as undefined
    // (via the codec's undefined-sentinel preprocessing), not silently dropped.
    class Boxed {
      constructor(readonly value: unknown) {}
    }
    registerSerializer(
      Boxed,
      {
        toJSON: (boxed) => ({ value: boxed.value }),
        fromJSON: (data) => new Boxed((data as { value: unknown }).value),
      },
      { tag: 'boxed' },
    );

    const restored = decode(encode(new Boxed(undefined))) as Boxed;
    expect(restored).toBeInstanceOf(Boxed);
    // Round-trips as a present-but-undefined field, matching public encode().
    expect('value' in (restored as object)).toBe(true);
    expect(restored.value).toBeUndefined();
  });

  it('leaves a plain Error on the generic name/message/stack encoding', () => {
    // Registering a subclass must not change how a base Error round-trips.
    registerSerializer(ValidationError, validationErrorHandlers, { tag: 'ValidationError' });

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
    registerSerializer(ValidationError, validationErrorHandlers, { tag: 'ValidationError' });
    expect(() =>
      registerSerializer(ValidationError, validationErrorHandlers, { tag: 'ValidationError2' }),
    ).toThrow(/already registered/i);
  });

  it('throws when two constructors share a tag', () => {
    class First extends Error {}
    class Second extends Error {}
    const handlers: SerializerHandlers<Error> = {
      toJSON: (error) => ({ message: error.message }),
      fromJSON: (data) => new Error((data as { message: string }).message),
    };
    registerSerializer(First, handlers, { tag: 'shared' });
    expect(() => registerSerializer(Second, handlers, { tag: 'shared' })).toThrow(/tag/i);
  });

  it('throws on an empty tag', () => {
    expect(() => registerSerializer(ValidationError, validationErrorHandlers, { tag: '' })).toThrow(
      /tag/i,
    );
  });

  it('throws on decoding a tag that has no registered serializer', () => {
    // Encode with a tag registered, then drop the registration and decode: the
    // decoder must fail loudly rather than silently misread.
    class Orphan {
      constructor(readonly v: number) {}
    }
    registerSerializer(
      Orphan,
      { toJSON: (o) => ({ v: o.v }), fromJSON: (d) => new Orphan((d as { v: number }).v) },
      { tag: 'orphan' },
    );
    const bytes = encode(new Orphan(1));
    resetSerializerRegistryForTesting();
    expect(() => decode(bytes)).toThrow(/no serializer registered for tag/i);
  });

  it('measures the post-serializer encoded size at payload-size admission', () => {
    registerSerializer(ValidationError, validationErrorHandlers, { tag: 'ValidationError' });

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
});
