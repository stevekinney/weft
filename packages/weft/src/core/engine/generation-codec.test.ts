import { describe, expect, it } from 'bun:test';

import { decodeGeneration, encodeGeneration } from './generation-codec.ts';

describe('generation-codec (WFT-153)', () => {
  it('round-trips a generation through encode/decode', () => {
    expect(decodeGeneration(encodeGeneration(1))).toBe(1);
    expect(decodeGeneration(encodeGeneration(42))).toBe(42);
  });

  it('rejects bytes of the wrong length as malformed (null)', () => {
    expect(decodeGeneration(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('rejects generation `0` as outside the valid range', () => {
    expect(decodeGeneration(encodeGeneration(0))).toBeNull();
  });
});
