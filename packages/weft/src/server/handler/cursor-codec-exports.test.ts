import { describe, expect, it } from 'bun:test';

import { decodeCursor, encodeCursor } from "../../embedded/backchannel/src/index.ts";

import * as handlerSurface from './index.ts';

describe('fleet-feed cursor codec public surface', () => {
  it('round-trips a sequence through the bare package specifier', () => {
    for (const sequence of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
      expect(decodeCursor(encodeCursor(sequence))).toBe(sequence);
    }
    expect(decodeCursor('-1')).toBe(-1);
    expect(decodeCursor('not-a-cursor')).toBeNull();
  });

  it('leaves the codec to @lostgradient/backchannel: the server handler surface does not export it', () => {
    expect(Reflect.has(handlerSurface, 'encodeCursor')).toBe(false);
    expect(Reflect.has(handlerSurface, 'decodeCursor')).toBe(false);
  });
});
