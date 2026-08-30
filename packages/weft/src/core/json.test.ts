import { describe, expect, it } from 'bun:test';

import { isJSONValue, normalizeJSONValue, type JSONValue } from './json.ts';

describe('isJSONValue', () => {
  it('accepts JSON primitives', () => {
    expect(isJSONValue('a')).toBe(true);
    expect(isJSONValue(0)).toBe(true);
    expect(isJSONValue(true)).toBe(true);
    expect(isJSONValue(false)).toBe(true);
    expect(isJSONValue(null)).toBe(true);
  });

  it('rejects non-finite numbers', () => {
    expect(isJSONValue(Number.NaN)).toBe(false);
    expect(isJSONValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJSONValue(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('rejects negative zero instead of silently normalizing it to positive zero', () => {
    expect(isJSONValue(-0)).toBe(false);
    expect(isJSONValue({ value: -0 })).toBe(false);
  });

  it('rejects unsupported primitive types', () => {
    expect(isJSONValue(undefined)).toBe(false);
    expect(isJSONValue(BigInt(1))).toBe(false);
    expect(isJSONValue(Symbol('s'))).toBe(false);
    expect(isJSONValue(() => 1)).toBe(false);
  });

  it('walks plain arrays and objects', () => {
    expect(isJSONValue([1, 'two', { three: 3 }, [4, null]])).toBe(true);
    expect(isJSONValue({ count: 1, tags: ['ready'] })).toBe(true);
  });

  it('rejects objects with non-plain prototypes', () => {
    expect(isJSONValue(new Date())).toBe(false);
    expect(isJSONValue(new Map())).toBe(false);
    expect(isJSONValue(new Set())).toBe(false);
    expect(isJSONValue(new Error('boom'))).toBe(false);
  });

  it('rejects nested non-JSON values', () => {
    expect(isJSONValue({ outer: { inner: undefined } })).toBe(false);
    expect(isJSONValue([{ ok: 1 }, () => null])).toBe(false);
  });

  it('detects cyclic arrays', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(isJSONValue(cycle)).toBe(false);
  });

  it('detects cyclic objects', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(isJSONValue(cycle)).toBe(false);
  });

  it('accepts an object with null prototype', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value['k'] = 1;
    expect(isJSONValue(value)).toBe(true);
  });
});

describe('normalizeJSONValue', () => {
  it('passes through already-safe values', () => {
    const value: JSONValue = { count: 1, tags: ['ready'] };
    expect(normalizeJSONValue(value)).toEqual(value);
  });

  it('replaces undefined with null', () => {
    expect(normalizeJSONValue(undefined)).toBeNull();
  });

  it('flattens errors into name/message records', () => {
    expect(normalizeJSONValue(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
  });

  it('stringifies bigints', () => {
    expect(normalizeJSONValue(BigInt(123))).toBe('123');
  });

  it('falls back to symbol descriptions, then null', () => {
    expect(normalizeJSONValue(Symbol('label'))).toBe('label');
    expect(normalizeJSONValue(Symbol())).toBeNull();
  });

  it('uses JSON.stringify to coerce serializable objects', () => {
    const date = new Date('2026-05-11T00:00:00Z');
    // Date#toJSON exists, so normalize routes through stringify and parse.
    expect(normalizeJSONValue(date)).toBe(date.toISOString());
  });

  it('returns null for values that JSON.stringify cannot represent', () => {
    expect(normalizeJSONValue(() => 1)).toBeNull();
  });

  it('returns null for circular structures', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(normalizeJSONValue(cycle)).toBeNull();
  });

  it('drops non-finite numbers via stringify (becomes null)', () => {
    expect(normalizeJSONValue(Number.NaN)).toBeNull();
    expect(normalizeJSONValue(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
