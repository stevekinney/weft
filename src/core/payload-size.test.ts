import { describe, expect, it } from 'bun:test';

import { decode, encode } from './codec.ts';
import {
  PayloadSizeExceededError,
  assertPayloadWithinLimit,
  encodePayloadWithinLimit,
  type PayloadKind,
} from './payload-size.ts';

describe('assertPayloadWithinLimit', () => {
  it('allows a payload smaller than the limit', () => {
    expect(() => assertPayloadWithinLimit('small', 1024, 'workflow input')).not.toThrow();
  });

  it('allows a payload exactly at the limit', () => {
    const value = 'x'.repeat(50);
    const exactBytes = encode(value).byteLength;
    expect(() => assertPayloadWithinLimit(value, exactBytes, 'signal payload')).not.toThrow();
  });

  it('rejects a payload one byte over the limit', () => {
    const value = 'x'.repeat(50);
    const exactBytes = encode(value).byteLength;
    expect(() => assertPayloadWithinLimit(value, exactBytes - 1, 'activity result')).toThrow(
      PayloadSizeExceededError,
    );
  });

  it('attaches the kind, serialized size, and limit to the error', () => {
    const value = { data: 'y'.repeat(200) };
    const serializedBytes = encode(value).byteLength;
    const limit = 10;
    try {
      assertPayloadWithinLimit(value, limit, 'activity result');
      throw new Error('expected assertPayloadWithinLimit to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadSizeExceededError);
      const typed = error as PayloadSizeExceededError;
      expect(typed.code).toBe('PayloadSizeExceededError');
      expect(typed.payloadKind).toBe('activity result');
      expect(typed.serializedBytes).toBe(serializedBytes);
      expect(typed.maxBytes).toBe(limit);
      expect(typed.message).toContain('activity result');
      expect(typed.message).toContain(String(serializedBytes));
      expect(typed.message).toContain(String(limit));
    }
  });

  it('does not throw and does not encode when the limit is null (disabled)', () => {
    // Prove the disabled path never encodes: a getter records whether it was
    // read. encode() would read the property, so an unread getter means the
    // helper short-circuited before touching the value.
    let read = false;
    const value = {
      get probe() {
        read = true;
        return 1;
      },
    };
    expect(() => assertPayloadWithinLimit(value, null, 'workflow input')).not.toThrow();
    expect(read).toBe(false);
  });

  it.each<PayloadKind>(['workflow input', 'signal payload', 'activity result', 'finalizer state'])(
    'names the payload kind %p in the rejection message',
    (kind) => {
      try {
        assertPayloadWithinLimit('over the tiny limit', 1, kind);
        throw new Error('expected throw');
      } catch (error) {
        expect((error as PayloadSizeExceededError).payloadKind).toBe(kind);
        expect((error as PayloadSizeExceededError).message).toContain(kind);
      }
    },
  );
});

describe('encodePayloadWithinLimit', () => {
  it('returns the encoded bytes when within the limit (single encode reused by caller)', () => {
    const value = { hello: 'world' };
    const bytes = encodePayloadWithinLimit(value, 1024, 'signal payload');
    expect(bytes).toBeInstanceOf(Uint8Array);
    // The returned bytes are the real encoding, decodable back to the value.
    expect(decode(bytes)).toEqual(value);
    // ...and byte-identical to a direct encode().
    expect(bytes).toEqual(encode(value));
  });

  it('allows a payload exactly at the limit', () => {
    const value = 'x'.repeat(40);
    const exactBytes = encode(value).byteLength;
    expect(() => encodePayloadWithinLimit(value, exactBytes, 'signal payload')).not.toThrow();
  });

  it('throws PayloadSizeExceededError one byte over the limit', () => {
    const value = 'x'.repeat(40);
    const exactBytes = encode(value).byteLength;
    expect(() => encodePayloadWithinLimit(value, exactBytes - 1, 'signal payload')).toThrow(
      PayloadSizeExceededError,
    );
  });

  it('still encodes (and returns bytes) when the limit is null', () => {
    const value = { a: 1 };
    const bytes = encodePayloadWithinLimit(value, null, 'workflow input');
    expect(decode(bytes)).toEqual(value);
  });
});
