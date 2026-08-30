import { describe, expect, it } from 'bun:test';

import { canonicalJson } from './openapi-canonical-json.ts';

describe('canonicalJson', () => {
  it('returns the same canonical string for objects with different key order', () => {
    expect(canonicalJson({ type: 'object', required: ['id'] })).toBe(
      canonicalJson({ required: ['id'], type: 'object' }),
    );
  });

  it('sorts nested object keys recursively', () => {
    const left = { properties: { name: { type: 'string', minLength: 1 } }, type: 'object' };
    const right = { type: 'object', properties: { name: { minLength: 1, type: 'string' } } };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it('returns different strings for different schemas', () => {
    expect(canonicalJson({ type: 'string' })).not.toBe(canonicalJson({ type: 'number' }));
  });

  it('preserves array order', () => {
    expect(canonicalJson({ required: ['id', 'name'] })).not.toBe(
      canonicalJson({ required: ['name', 'id'] }),
    );
  });

  it('round-trips primitive values', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('value')).toBe('"value"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
  });
});
