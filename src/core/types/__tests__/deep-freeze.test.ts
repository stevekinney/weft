import { describe, expect, it } from 'bun:test';

import { deepFreeze } from '../deep-freeze.ts';

describe('deepFreeze', () => {
  it('returns primitives unchanged', () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze('foo')).toBe('foo');
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
  });

  it('freezes a plain object', () => {
    const value = deepFreeze({ a: 1, b: 2 });
    expect(Object.isFrozen(value)).toBe(true);
    expect(() => {
      (value as { a: number }).a = 99;
    }).toThrow(TypeError);
  });

  it('freezes nested objects', () => {
    const value = deepFreeze({ outer: { inner: { value: 1 } } });
    expect(Object.isFrozen(value.outer)).toBe(true);
    expect(Object.isFrozen(value.outer.inner)).toBe(true);
    expect(() => {
      value.outer.inner.value = 99;
    }).toThrow(TypeError);
  });

  it('freezes arrays and their contents', () => {
    const value = deepFreeze([{ a: 1 }, { a: 2 }]);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value[0])).toBe(true);
    expect(() => {
      value.push({ a: 3 });
    }).toThrow(TypeError);
    expect(() => {
      (value[0] as { a: number }).a = 99;
    }).toThrow(TypeError);
  });

  it('does not freeze functions', () => {
    const fn = (): number => 42;
    const value = deepFreeze({ fn });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.fn)).toBe(false);
  });

  it('is idempotent on already-frozen values', () => {
    const inner = Object.freeze({ value: 1 });
    expect(() => deepFreeze({ inner })).not.toThrow();
  });

  it('handles deeply nested retry-style options', () => {
    const value = deepFreeze({
      retry: { backoff: { initialInterval: 100, multiplier: 2 } },
    });
    expect(() => {
      (value.retry.backoff as { initialInterval: number }).initialInterval = 999;
    }).toThrow(TypeError);
  });
});
