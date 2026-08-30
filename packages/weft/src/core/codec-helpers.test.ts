import { describe, expect, it } from 'bun:test';

import {
  coerceCodecArray,
  coerceCodecRecord,
  decodeCodecDate,
  encodeCodecDate,
} from './codec-helpers.ts';

describe('codec helpers', () => {
  it('coerceCodecRecord returns objects unchanged', () => {
    const value = { source: 'hello', flags: 'gi' };
    expect(coerceCodecRecord(value)).toEqual(value);
  });

  it('coerceCodecRecord falls back to an empty object for non-record values', () => {
    expect(coerceCodecRecord('not-a-record')).toEqual({});
    expect(coerceCodecRecord(null)).toEqual({});
    expect(coerceCodecRecord(['array'])).toEqual({});
  });

  it('coerceCodecArray returns arrays unchanged', () => {
    const value = ['a', 'b'];
    expect(coerceCodecArray(value)).toEqual(value);
  });

  it('coerceCodecArray falls back to an empty array for non-array values', () => {
    expect(coerceCodecArray({ no: 'array' })).toEqual([]);
  });

  it('encodeCodecDate encodes Date values as float64 milliseconds', () => {
    const encoded = encodeCodecDate(new Date('2024-01-02T03:04:05.678Z'));

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded).toHaveLength(8);
  });

  it('encodeCodecDate returns null for non-Date values', () => {
    expect(encodeCodecDate('2024-01-02')).toBeNull();
  });

  it('decodeCodecDate restores the original timestamp', () => {
    const encoded = encodeCodecDate(new Date('2024-01-02T03:04:05.678Z'))!;
    expect(decodeCodecDate(encoded).toISOString()).toBe('2024-01-02T03:04:05.678Z');
  });
});
