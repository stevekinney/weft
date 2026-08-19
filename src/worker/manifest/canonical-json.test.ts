import { describe, expect, it } from 'bun:test';

import { canonicalJsonStringify } from './canonical-json.ts';

describe('canonicalJsonStringify', () => {
  it('serializes primitives like JSON.stringify', () => {
    expect(canonicalJsonStringify('a')).toBe('"a"');
    expect(canonicalJsonStringify(1)).toBe('1');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(null)).toBe('null');
  });

  it('sorts object keys at the top level', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts object keys at every depth', () => {
    expect(canonicalJsonStringify({ z: { d: 1, c: 2 }, a: 1 })).toBe('{"a":1,"z":{"c":2,"d":1}}');
  });

  it('produces identical output for two objects that differ only in key order', () => {
    expect(canonicalJsonStringify({ a: 1, b: 2 })).toBe(canonicalJsonStringify({ b: 2, a: 1 }));
  });

  it('preserves array order without sorting elements', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serializes arrays of objects with each object canonicalized', () => {
    expect(canonicalJsonStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('drops keys whose value is undefined, matching JSON.stringify', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('serializes a top-level undefined as null', () => {
    expect(canonicalJsonStringify(undefined)).toBe('null');
  });
});
