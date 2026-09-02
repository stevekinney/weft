/**
 * Schema-deduplication for `weft codegen`'s generated `.d.ts`.
 *
 * `codegen-emit-registry.ts` walks every active workflow's `inputSchema`/
 * `outputSchema` in a fixed, deterministic order (workflows sorted by name,
 * then input before output) and hands this module the resulting sequence of
 * {@link SchemaFragmentOccurrence}s — each fragment's normalization key
 * (`canonicalJsonStringify` of the raw JSON Schema) paired with its
 * independently-emitted TypeScript text (`jsonSchemaToTypeScript`).
 * {@link buildSchemaAliasTable} groups those by canonical key and decides,
 * for each group, whether the repeated schema is worth hoisting into a
 * single shared `type` alias referenced from every entry that uses it,
 * rather than repeating the same TypeScript text inline at every call site.
 *
 * A schema only qualifies for hoisting when it recurs (count >= 2), its
 * canonical key and emitted TypeScript text agree across every occurrence
 * (see the module doc on `TRIVIAL_TYPESCRIPT_TYPES` and the "disagreement"
 * branch below for why that can never actually diverge for real schema
 * input, and why the check still exists), and the emitted type is not
 * trivial — hoisting `unknown` or `string` behind an opaque alias name
 * would only make the generated file harder to read for zero benefit, and
 * would trivially "dedupe" every schema-less workflow (`inputSchema`
 * undefined → canonical key `null`, emitted type `unknown`) into a shared
 * alias the moment two workflows both lack an input schema, which is the
 * common case, not an edge case.
 *
 * @module cli/codegen-emit-dedup
 */

import { hashString } from '../runtime/portable.ts';
import { CodegenEmitError } from './codegen-emit-keywords.ts';

export { CodegenEmitError } from './codegen-emit-keywords.ts';

/** One schema fragment's normalization key and independently-emitted TypeScript text. */
export type SchemaFragmentOccurrence = {
  canonicalKey: string;
  tsType: string;
};

/** A hoisted schema's alias name and the TypeScript type it aliases. */
export type SchemaAliasEntry = {
  alias: string;
  tsType: string;
};

/**
 * Emitted TypeScript type expressions that are never worth hoisting behind
 * an alias, no matter how many times they recur: bare primitives and the
 * handful of compound "no meaningful shape" forms `jsonSchemaToTypeScript`
 * produces for an absent, empty, or fully-open/closed schema.
 */
export const TRIVIAL_TYPESCRIPT_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'unknown',
  'never',
  'Record<string, never>',
  'Record<string, unknown>',
  'Array<unknown>',
]);

// A bare literal type (from a single-entry `enum`/`const`): a quoted
// string, an integer or decimal number, or `true`/`false`/`null`. These
// are just as cheap to repeat inline as a bare primitive, so they are
// treated as trivial too even though they aren't literal `ReadonlySet`
// members.
const LITERAL_TOKEN_PATTERN = /^(-?[0-9]+(\.[0-9]+)?|true|false|null|"[^"\\]*")$/;

function isTrivialTsType(tsType: string): boolean {
  return TRIVIAL_TYPESCRIPT_TYPES.has(tsType) || LITERAL_TOKEN_PATTERN.test(tsType);
}

/** Options for {@link buildSchemaAliasTable}, injectable for deterministic testing. */
export type BuildSchemaAliasTableOptions = {
  /** Alias-name hash function. Defaults to {@link hashString} (FNV-1a). */
  hash?: (key: string) => string;
};

/** Prefix for every generated schema alias name — distinctive and double-underscored so it never collides with a real consumer type name. */
export const ALIAS_PREFIX = '__WeftSchema_';

type SchemaGroup = {
  count: number;
  distinctTsTypes: ReadonlySet<string>;
  tsType: string;
  firstIndex: number;
};

function groupOccurrences(
  occurrences: readonly SchemaFragmentOccurrence[],
): ReadonlyMap<string, SchemaGroup> {
  const groups = new Map<string, { count: number; tsTypes: Set<string>; firstIndex: number }>();
  occurrences.forEach((occurrence, index) => {
    let group = groups.get(occurrence.canonicalKey);
    if (group === undefined) {
      group = { count: 0, tsTypes: new Set(), firstIndex: index };
      groups.set(occurrence.canonicalKey, group);
    }
    group.count += 1;
    group.tsTypes.add(occurrence.tsType);
  });

  const result = new Map<string, SchemaGroup>();
  for (const [canonicalKey, group] of groups) {
    result.set(canonicalKey, {
      count: group.count,
      distinctTsTypes: group.tsTypes,
      tsType: group.tsTypes.values().next().value ?? 'unknown',
      firstIndex: group.firstIndex,
    });
  }
  return result;
}

/**
 * Group a fixed, deterministically-ordered sequence of schema occurrences
 * by their normalization key and decide which recurring, non-trivial
 * schemas should be hoisted into a shared `type` alias.
 *
 * Returns a map keyed by `canonicalKey` (not by alias) so a caller emitting
 * one workflow entry's `input`/`output` field can look up "does this
 * schema's canonical key have a hoisted alias?" directly, without a second
 * reverse index.
 *
 * A group whose members share a `canonicalKey` but disagree on emitted
 * TypeScript text is skipped entirely — never aliased, never an error. A
 * real `canonicalJsonStringify` key and `jsonSchemaToTypeScript` output are
 * both pure functions of the same input schema, so two occurrences sharing
 * a canonical key always agree on `tsType` in practice; this branch is
 * unreachable through real schema input (see `codegen-emit-dedup.test.ts`
 * for the synthetic coverage) and exists purely as defense-in-depth against
 * ever silently aliasing two schemas that turned out not to mean the same
 * thing — the same "defensive, unreachable-in-practice, directly tested"
 * pattern `compareWorkflowManifests`'s revision tiebreak already
 * establishes elsewhere in this codebase.
 *
 * Alias names are deterministic: `ALIAS_PREFIX` plus a hash of the
 * canonical key (FNV-1a via {@link hashString} by default, injectable via
 * `options.hash` for testing). A real hash collision between two different
 * canonical keys is astronomically unlikely but not impossible, so it is
 * checked and throws {@link CodegenEmitError} rather than silently letting
 * one schema's alias declaration shadow another's — `codegen.ts` already
 * converts that error to `exitCode: 1`.
 */
export function buildSchemaAliasTable(
  occurrences: readonly SchemaFragmentOccurrence[],
  options?: BuildSchemaAliasTableOptions,
): ReadonlyMap<string, SchemaAliasEntry> {
  const hash = options?.hash ?? hashString;
  const groups = groupOccurrences(occurrences);

  // Walk qualifying groups in first-occurrence order so alias assignment
  // (and therefore collision detection) is independent of `Map` iteration
  // quirks and reproducible across runs given the same input sequence.
  const orderedKeys = [...groups.keys()].toSorted(
    (a, b) => groups.get(a)!.firstIndex - groups.get(b)!.firstIndex,
  );

  const aliasOwners = new Map<string, string>();
  const table = new Map<string, SchemaAliasEntry>();

  for (const canonicalKey of orderedKeys) {
    const group = groups.get(canonicalKey)!;
    if (group.count < 2) continue;
    if (group.distinctTsTypes.size !== 1) continue;
    if (isTrivialTsType(group.tsType)) continue;

    const alias = `${ALIAS_PREFIX}${hash(canonicalKey)}`;
    const owner = aliasOwners.get(alias);
    if (owner !== undefined && owner !== canonicalKey) {
      throw new CodegenEmitError(
        `codegen: schema alias collision: canonical key hashes ${JSON.stringify(hash(owner))} and ${JSON.stringify(hash(canonicalKey))} both resolved to alias "${alias}"`,
      );
    }
    aliasOwners.set(alias, canonicalKey);
    table.set(canonicalKey, { alias, tsType: group.tsType });
  }

  return table;
}
