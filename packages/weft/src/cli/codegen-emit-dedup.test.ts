/**
 * Direct unit tests for `buildSchemaAliasTable`. Its one non-obvious branch
 * — the hash-collision throw — is unreachable through real schema input (a
 * real FNV-1a hash collision between two distinct emitted types is
 * astronomically unlikely). This is the only way to reach it.
 */
import { describe, expect, it } from 'bun:test';

import {
  ALIAS_PREFIX,
  buildSchemaAliasTable,
  CodegenEmitError,
  TRIVIAL_TYPESCRIPT_TYPES,
  type SchemaFragmentOccurrence,
} from './codegen-emit-dedup.ts';

describe('buildSchemaAliasTable', () => {
  it('never aliases a schema that occurs only once', () => {
    const occurrences: SchemaFragmentOccurrence[] = [{ tsType: '{ "a": string; }' }];
    const table = buildSchemaAliasTable(occurrences);
    expect(table.size).toBe(0);
  });

  it('hoists a type that recurs at least twice and is non-trivial', () => {
    const occurrences: SchemaFragmentOccurrence[] = [
      { tsType: '{ "a": string; }' },
      { tsType: '{ "a": string; }' },
    ];
    const table = buildSchemaAliasTable(occurrences);
    expect(table.size).toBe(1);
    const entry = table.get('{ "a": string; }');
    expect(entry).toBeDefined();
    expect(entry?.tsType).toBe('{ "a": string; }');
    expect(entry?.alias.startsWith(ALIAS_PREFIX)).toBe(true);
  });

  it.each([...TRIVIAL_TYPESCRIPT_TYPES])(
    'never aliases the trivial type %p even when it recurs many times',
    (tsType) => {
      const occurrences: SchemaFragmentOccurrence[] = Array.from({ length: 5 }, () => ({
        tsType,
      }));
      const table = buildSchemaAliasTable(occurrences);
      expect(table.size).toBe(0);
    },
  );

  it('never aliases a recurring bare literal type (single-entry enum/const)', () => {
    for (const literal of ['"fixed"', '42', '-1.5', 'true', 'false', 'null']) {
      const occurrences: SchemaFragmentOccurrence[] = [{ tsType: literal }, { tsType: literal }];
      const table = buildSchemaAliasTable(occurrences);
      expect(table.size).toBe(0);
    }
  });

  it('never aliases a recurring bare literal whose string content is JSON.stringify-escaped (quote or backslash)', () => {
    // `JSON.stringify('a"b')` -> `"a\"b"`; `JSON.stringify('a\\b')` -> `"a\\\\b"`. Both are
    // still just as cheap to repeat inline as an unescaped literal, so they must classify as
    // trivial too, not get hoisted into a `__WeftSchema_...` alias.
    for (const literal of [JSON.stringify('a"b'), JSON.stringify('a\\b')]) {
      const occurrences: SchemaFragmentOccurrence[] = [{ tsType: literal }, { tsType: literal }];
      const table = buildSchemaAliasTable(occurrences);
      expect(table.size).toBe(0);
    }
  });

  it('produces a stable, deterministic alias name for the same emitted type across two calls (real hashString)', () => {
    const occurrences: SchemaFragmentOccurrence[] = [
      { tsType: '{ "x": number; }' },
      { tsType: '{ "x": number; }' },
    ];
    const first = buildSchemaAliasTable(occurrences).get('{ "x": number; }');
    const second = buildSchemaAliasTable(occurrences).get('{ "x": number; }');
    expect(first?.alias).toBeDefined();
    expect(first?.alias).toBe(second?.alias);
  });

  it('assigns aliases independent of grouping/Map iteration order (first-occurrence order)', () => {
    const forward: SchemaFragmentOccurrence[] = [
      { tsType: '{ "a": string; }' },
      { tsType: '{ "a": string; }' },
      { tsType: '{ "b": number; }' },
      { tsType: '{ "b": number; }' },
    ];
    const reversed: SchemaFragmentOccurrence[] = [
      { tsType: '{ "b": number; }' },
      { tsType: '{ "b": number; }' },
      { tsType: '{ "a": string; }' },
      { tsType: '{ "a": string; }' },
    ];
    const forwardTable = buildSchemaAliasTable(forward);
    const reversedTable = buildSchemaAliasTable(reversed);
    expect(forwardTable.get('{ "a": string; }')?.alias).toBe(
      reversedTable.get('{ "a": string; }')?.alias,
    );
    expect(forwardTable.get('{ "b": number; }')?.alias).toBe(
      reversedTable.get('{ "b": number; }')?.alias,
    );
  });

  it('throws CodegenEmitError on a synthetic alias-name collision between two distinct emitted types', () => {
    // Force both groups to hash to the same alias via an injectable hash
    // function — a real hashString collision between two distinct emitted
    // types is astronomically unlikely, so this seam is the only way to
    // reach the collision-throw branch.
    const occurrences: SchemaFragmentOccurrence[] = [
      { tsType: '{ "a": string; }' },
      { tsType: '{ "a": string; }' },
      { tsType: '{ "b": number; }' },
      { tsType: '{ "b": number; }' },
    ];
    expect(() => buildSchemaAliasTable(occurrences, { hash: () => 'same' })).toThrow(
      CodegenEmitError,
    );
    expect(() => buildSchemaAliasTable(occurrences, { hash: () => 'same' })).toThrow(
      /schema alias collision/i,
    );
  });

  it('does not throw when an injected hash produces the same alias for the same emitted type repeated', () => {
    const occurrences: SchemaFragmentOccurrence[] = [
      { tsType: '{ "a": string; }' },
      { tsType: '{ "a": string; }' },
      { tsType: '{ "a": string; }' },
    ];
    const table = buildSchemaAliasTable(occurrences, { hash: () => 'constant' });
    expect(table.size).toBe(1);
    expect(table.get('{ "a": string; }')?.alias).toBe(`${ALIAS_PREFIX}constant`);
  });

  it('returns an empty table for an empty occurrence list', () => {
    expect(buildSchemaAliasTable([]).size).toBe(0);
  });
});
