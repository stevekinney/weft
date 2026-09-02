/**
 * Direct unit tests for `buildSchemaAliasTable`. Two of its branches — the
 * hash-collision throw and the tsType-disagreement skip — are unreachable
 * through real schema input (`canonicalJsonStringify` and
 * `jsonSchemaToTypeScript` are both pure functions of the same schema, so
 * two occurrences sharing a canonical key always agree on `tsType`, and a
 * real FNV-1a hash collision between two distinct canonical keys is
 * astronomically unlikely). This is the only way to reach either branch.
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
    const occurrences: SchemaFragmentOccurrence[] = [
      { canonicalKey: 'k1', tsType: '{ "a": string; }' },
    ];
    const table = buildSchemaAliasTable(occurrences);
    expect(table.size).toBe(0);
  });

  it('hoists a schema that recurs at least twice with a non-trivial type', () => {
    const occurrences: SchemaFragmentOccurrence[] = [
      { canonicalKey: 'k1', tsType: '{ "a": string; }' },
      { canonicalKey: 'k1', tsType: '{ "a": string; }' },
    ];
    const table = buildSchemaAliasTable(occurrences);
    expect(table.size).toBe(1);
    const entry = table.get('k1');
    expect(entry).toBeDefined();
    expect(entry?.tsType).toBe('{ "a": string; }');
    expect(entry?.alias.startsWith(ALIAS_PREFIX)).toBe(true);
  });

  it.each([...TRIVIAL_TYPESCRIPT_TYPES])(
    'never aliases the trivial type %p even when it recurs many times',
    (tsType) => {
      const occurrences: SchemaFragmentOccurrence[] = Array.from({ length: 5 }, () => ({
        canonicalKey: 'trivial-key',
        tsType,
      }));
      const table = buildSchemaAliasTable(occurrences);
      expect(table.size).toBe(0);
    },
  );

  it('never aliases a recurring bare literal type (single-entry enum/const)', () => {
    for (const literal of ['"fixed"', '42', '-1.5', 'true', 'false', 'null']) {
      const occurrences: SchemaFragmentOccurrence[] = [
        { canonicalKey: `literal-${literal}`, tsType: literal },
        { canonicalKey: `literal-${literal}`, tsType: literal },
      ];
      const table = buildSchemaAliasTable(occurrences);
      expect(table.size).toBe(0);
    }
  });

  it('produces a stable, deterministic alias name for the same canonical key across two calls (real hashString)', () => {
    const occurrences: SchemaFragmentOccurrence[] = [
      { canonicalKey: 'shared-key', tsType: '{ "x": number; }' },
      { canonicalKey: 'shared-key', tsType: '{ "x": number; }' },
    ];
    const first = buildSchemaAliasTable(occurrences).get('shared-key');
    const second = buildSchemaAliasTable(occurrences).get('shared-key');
    expect(first?.alias).toBeDefined();
    expect(first?.alias).toBe(second?.alias);
  });

  it('assigns aliases independent of grouping/Map iteration order (first-occurrence order)', () => {
    const forward: SchemaFragmentOccurrence[] = [
      { canonicalKey: 'a', tsType: '{ "a": string; }' },
      { canonicalKey: 'a', tsType: '{ "a": string; }' },
      { canonicalKey: 'b', tsType: '{ "b": number; }' },
      { canonicalKey: 'b', tsType: '{ "b": number; }' },
    ];
    const reversed: SchemaFragmentOccurrence[] = [
      { canonicalKey: 'b', tsType: '{ "b": number; }' },
      { canonicalKey: 'b', tsType: '{ "b": number; }' },
      { canonicalKey: 'a', tsType: '{ "a": string; }' },
      { canonicalKey: 'a', tsType: '{ "a": string; }' },
    ];
    const forwardTable = buildSchemaAliasTable(forward);
    const reversedTable = buildSchemaAliasTable(reversed);
    expect(forwardTable.get('a')?.alias).toBe(reversedTable.get('a')?.alias);
    expect(forwardTable.get('b')?.alias).toBe(reversedTable.get('b')?.alias);
  });

  it('skips a group whose members share a canonical key but disagree on emitted TypeScript text (defensive, unreachable through real schema input)', () => {
    // Synthetically construct two occurrences with the same canonicalKey
    // but different tsType — impossible from a real
    // canonicalJsonStringify/jsonSchemaToTypeScript pairing, but this is
    // the only way to exercise the disagreement-skip branch directly.
    const occurrences: SchemaFragmentOccurrence[] = [
      { canonicalKey: 'disagreement-key', tsType: '{ "a": string; }' },
      { canonicalKey: 'disagreement-key', tsType: '{ "a": number; }' },
    ];
    const table = buildSchemaAliasTable(occurrences);
    expect(table.has('disagreement-key')).toBe(false);
    expect(table.size).toBe(0);
  });

  it('throws CodegenEmitError on a synthetic alias-name collision between two distinct canonical keys', () => {
    // Force both groups to hash to the same alias via an injectable hash
    // function — a real hashString collision between two distinct
    // canonical keys is astronomically unlikely, so this seam is the only
    // way to reach the collision-throw branch.
    const occurrences: SchemaFragmentOccurrence[] = [
      { canonicalKey: 'key-one', tsType: '{ "a": string; }' },
      { canonicalKey: 'key-one', tsType: '{ "a": string; }' },
      { canonicalKey: 'key-two', tsType: '{ "b": number; }' },
      { canonicalKey: 'key-two', tsType: '{ "b": number; }' },
    ];
    expect(() => buildSchemaAliasTable(occurrences, { hash: () => 'same' })).toThrow(
      CodegenEmitError,
    );
    expect(() => buildSchemaAliasTable(occurrences, { hash: () => 'same' })).toThrow(
      /schema alias collision/i,
    );
  });

  it('does not throw when an injected hash produces the same alias for the same canonical key repeated', () => {
    const occurrences: SchemaFragmentOccurrence[] = [
      { canonicalKey: 'only-key', tsType: '{ "a": string; }' },
      { canonicalKey: 'only-key', tsType: '{ "a": string; }' },
      { canonicalKey: 'only-key', tsType: '{ "a": string; }' },
    ];
    const table = buildSchemaAliasTable(occurrences, { hash: () => 'constant' });
    expect(table.size).toBe(1);
    expect(table.get('only-key')?.alias).toBe(`${ALIAS_PREFIX}constant`);
  });

  it('returns an empty table for an empty occurrence list', () => {
    expect(buildSchemaAliasTable([]).size).toBe(0);
  });
});
