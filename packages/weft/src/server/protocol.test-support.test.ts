/**
 * COR-1283: `records()`'s "not an object array" guard — only exercised
 * elsewhere via well-formed fixtures.
 */
import { describe, expect, it } from 'bun:test';

import { records } from './protocol.test-support.ts';

describe('records', () => {
  it('returns the array unchanged when every element is a record', () => {
    const value = [{ a: 1 }, { b: 2 }];
    expect(records(value, 'items')).toBe(value);
  });

  it('throws when the value is not an array', () => {
    expect(() => records({ a: 1 }, 'items')).toThrow('expected items to be an object array');
  });

  it('throws when the array contains a non-record element', () => {
    expect(() => records([{ a: 1 }, 'not-a-record'], 'items')).toThrow(
      'expected items to be an object array',
    );
  });
});
