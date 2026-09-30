import { describe, expect, it } from 'bun:test';

import { decodeCursor, encodeCursor } from '@lostgradient/weft';

import * as handlerSurface from './index.ts';

describe('fleet-feed cursor codec public surface', () => {
  it('round-trips a sequence through the bare package specifier', () => {
    for (const sequence of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
      expect(decodeCursor(encodeCursor(sequence))).toBe(sequence);
    }
    expect(decodeCursor('-1')).toBe(-1);
    expect(decodeCursor('not-a-cursor')).toBeNull();
  });

  it('re-exports the same codec from the server handler surface', () => {
    expect(handlerSurface.encodeCursor).toBe(encodeCursor);
    expect(handlerSurface.decodeCursor).toBe(decodeCursor);
  });
});
