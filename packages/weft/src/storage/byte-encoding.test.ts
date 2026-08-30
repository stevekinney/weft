import { afterEach, describe, expect, it } from 'bun:test';

import { decodeBase64ToBytes, encodeBytesToBase64, isRecord } from './byte-encoding.ts';

const originalFromCharCode = String.fromCharCode;

afterEach(() => {
  String.fromCharCode = originalFromCharCode;
});

describe('byte encoding', () => {
  it('round-trips bytes without spreading large chunks into String.fromCharCode', () => {
    let largestArgumentCount = 0;
    let callCount = 0;
    String.fromCharCode = (...bytes: number[]) => {
      callCount += 1;
      largestArgumentCount = Math.max(largestArgumentCount, bytes.length);
      if (bytes.length > 512) {
        throw new RangeError('too many arguments');
      }
      return originalFromCharCode(...bytes);
    };

    const bytes = new Uint8Array(70_000);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }

    const encoded = encodeBytesToBase64(bytes);

    expect(decodeBase64ToBytes(encoded)).toEqual(bytes);
    expect(largestArgumentCount).toBeLessThanOrEqual(512);
    expect(callCount).toBeLessThan(bytes.length / 2);
  });

  it('treats arrays as untrusted JSON values instead of records', () => {
    expect(isRecord({ value: 'ok' })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
});
