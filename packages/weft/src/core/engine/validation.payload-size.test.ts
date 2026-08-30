import { describe, expect, it } from 'bun:test';

import { normalizePayloadSizePolicy } from './validation.ts';

describe('normalizePayloadSizePolicy', () => {
  it('disables when policy is omitted', () => {
    expect(normalizePayloadSizePolicy(undefined, 'options.payloadSize')).toEqual({
      maxBytes: null,
    });
  });

  it('disables when maxBytes is omitted', () => {
    expect(normalizePayloadSizePolicy({}, 'options.payloadSize')).toEqual({ maxBytes: null });
  });

  it('disables when maxBytes is null', () => {
    expect(normalizePayloadSizePolicy({ maxBytes: null }, 'options.payloadSize')).toEqual({
      maxBytes: null,
    });
  });

  it('disables when maxBytes is 0', () => {
    expect(normalizePayloadSizePolicy({ maxBytes: 0 }, 'options.payloadSize')).toEqual({
      maxBytes: null,
    });
  });

  it('keeps a positive safe integer', () => {
    expect(normalizePayloadSizePolicy({ maxBytes: 1_048_576 }, 'options.payloadSize')).toEqual({
      maxBytes: 1_048_576,
    });
  });

  it('throws on a negative value', () => {
    expect(() => normalizePayloadSizePolicy({ maxBytes: -1 }, 'options.payloadSize')).toThrow(
      TypeError,
    );
  });

  it('throws on a non-integer value', () => {
    expect(() => normalizePayloadSizePolicy({ maxBytes: 1.5 }, 'options.payloadSize')).toThrow(
      TypeError,
    );
  });

  it('throws on a non-finite value', () => {
    expect(() =>
      normalizePayloadSizePolicy({ maxBytes: Number.POSITIVE_INFINITY }, 'options.payloadSize'),
    ).toThrow(TypeError);
  });

  it('throws on an unsafe integer', () => {
    expect(() =>
      normalizePayloadSizePolicy({ maxBytes: Number.MAX_SAFE_INTEGER + 1 }, 'options.payloadSize'),
    ).toThrow(TypeError);
  });

  it('throws on a non-number value', () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime guard against wrong types.
      normalizePayloadSizePolicy({ maxBytes: '100' }, 'options.payloadSize'),
    ).toThrow(TypeError);
  });

  it('includes the context in the error message', () => {
    expect(() => normalizePayloadSizePolicy({ maxBytes: -1 }, 'options.payloadSize')).toThrow(
      /options\.payloadSize\.maxBytes/,
    );
  });
});
