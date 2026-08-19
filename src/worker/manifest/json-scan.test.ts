import { describe, expect, it } from 'bun:test';

import { findDuplicateJsonKey } from './json-scan.ts';
import { MAX_JSON_SCAN_NESTING_DEPTH } from './limits.ts';

describe('findDuplicateJsonKey', () => {
  it('finds a duplicate key in a flat object', () => {
    expect(findDuplicateJsonKey('{"a":1,"a":2}')).toBe('a');
  });

  it('finds a duplicate key in a nested object', () => {
    expect(findDuplicateJsonKey('{"outer":{"b":1,"b":2}}')).toBe('b');
  });

  it('finds a duplicate key inside an array element', () => {
    expect(findDuplicateJsonKey('[{"c":1,"c":2}]')).toBe('c');
  });

  it('returns undefined when every object has unique keys', () => {
    expect(findDuplicateJsonKey('{"a":1,"b":{"a":2},"c":[{"a":3}]}')).toBeUndefined();
  });

  it('does not treat repeated keys in sibling objects as duplicates', () => {
    expect(findDuplicateJsonKey('{"x":{"a":1},"y":{"a":2}}')).toBeUndefined();
  });

  it('does not mistake a string value for a key', () => {
    expect(findDuplicateJsonKey('{"a":"a","b":"a"}')).toBeUndefined();
  });

  it('does not mistake array strings for keys', () => {
    expect(findDuplicateJsonKey('{"tags":["a","a","a"]}')).toBeUndefined();
  });

  it('does not mistake a brace inside a string for an object', () => {
    expect(findDuplicateJsonKey('{"a":"{\\"b\\":1,\\"b\\":2}"}')).toBeUndefined();
  });

  it('treats an escaped quote as string content rather than a terminator', () => {
    expect(findDuplicateJsonKey('{"a\\"b":1,"a\\"b":2}')).toBe('a"b');
  });

  it.each([
    ['backslash', '{"a\\\\b":1,"a\\\\b":2}', 'a\\b'],
    ['solidus', '{"a\\/b":1,"a\\/b":2}', 'a/b'],
    ['backspace', '{"a\\bb":1,"a\\bb":2}', 'a\bb'],
    ['form feed', '{"a\\fb":1,"a\\fb":2}', 'a\fb'],
    ['newline', '{"a\\nb":1,"a\\nb":2}', 'a\nb'],
    ['carriage return', '{"a\\rb":1,"a\\rb":2}', 'a\rb'],
    ['tab', '{"a\\tb":1,"a\\tb":2}', 'a\tb'],
  ])('decodes the %s escape when comparing keys', (_label, text, expected) => {
    expect(findDuplicateJsonKey(text)).toBe(expected);
  });

  it('decodes unicode escapes so differently written keys compare equal', () => {
    expect(findDuplicateJsonKey('{"\\u0061":1,"a":2}')).toBe('a');
  });

  it('ignores whitespace between tokens', () => {
    expect(findDuplicateJsonKey('{\n  "a" : 1,\n  "a" : 2\n}')).toBe('a');
  });

  it.each([
    ['an unterminated string', '{"a'],
    ['a trailing backslash', '{"a\\'],
    ['a truncated unicode escape', '{"a\\u00'],
    ['an invalid unicode escape', '{"a\\uZZZZ":1}'],
    ['a partially invalid unicode escape', '{"a\\u12ZZ":1}'],
    ['an unrecognized escape', '{"a\\qb":1}'],
  ])('reports no duplicate for %s and leaves the diagnosis to JSON.parse', (_label, text) => {
    expect(findDuplicateJsonKey(text)).toBeUndefined();
  });

  it('handles an empty document', () => {
    expect(findDuplicateJsonKey('')).toBeUndefined();
  });

  it('handles a bare scalar document', () => {
    expect(findDuplicateJsonKey('42')).toBeUndefined();
  });

  it('resumes key detection after a nested object closes', () => {
    expect(findDuplicateJsonKey('{"a":{"x":1},"a":2}')).toBe('a');
  });

  it('resumes key detection after a nested array closes', () => {
    expect(findDuplicateJsonKey('{"a":[1,2],"a":3}')).toBe('a');
  });

  it('bails out on structural nesting deeper than the ceiling instead of allocating without bound', () => {
    // Far beyond MAX_JSON_SCAN_NESTING_DEPTH — proves the scan aborts before
    // the open-container stack grows anywhere near this length, rather than
    // allocating one Set per '{' all the way down.
    expect(findDuplicateJsonKey('{'.repeat(1_000_000))).toBeUndefined();
  });

  it('still finds duplicates at nesting exactly at the ceiling', () => {
    const opens = '{"outer":'.repeat(MAX_JSON_SCAN_NESTING_DEPTH - 1);
    const closes = '}'.repeat(MAX_JSON_SCAN_NESTING_DEPTH - 1);
    expect(findDuplicateJsonKey(`${opens}{"a":1,"a":2}${closes}`)).toBe('a');
  });
});
