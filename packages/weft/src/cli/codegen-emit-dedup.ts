/**
 * Schema-deduplication for `weft codegen`'s generated `.d.ts`.
 *
 * `codegen-emit-registry.ts` walks every active workflow's `inputSchema`/
 * `outputSchema` in a fixed, deterministic order (workflows sorted by name,
 * then input before output) and hands this module the resulting sequence of
 * {@link SchemaFragmentOccurrence}s — each fragment's independently-emitted
 * TypeScript text (`jsonSchemaToTypeScript`). {@link buildSchemaAliasTable}
 * groups those by that emitted text and decides, for each group, whether the
 * repeated type is worth hoisting into a single shared `type` alias
 * referenced from every entry that uses it, rather than repeating the same
 * TypeScript text inline at every call site.
 *
 * Grouping by the emitted TypeScript text itself — not by a normalization of
 * the source JSON Schema — is deliberate: two JSON Schema fragments that
 * differ only in an order-insensitive construct (`required: ['a', 'b']` vs
 * `required: ['b', 'a']`; `properties` key order) render to byte-identical
 * TypeScript through `jsonSchemaToTypeScript` (which sorts object keys), so
 * grouping by a JSON-level canonical key would miss deduplicating them even
 * though they are exactly the same type a consumer would want aliased
 * together. Grouping by the rendered text instead means "these occurrences
 * produce the same alias" and "these occurrences are the same TypeScript
 * type" are the same question, answered once, so there is no JSON-vs-text
 * disagreement to reconcile: any two occurrences landing in the same group
 * are equal by construction (`Map` keys are compared by value), not merely
 * expected to agree.
 *
 * A schema only qualifies for hoisting when it recurs (count >= 2) and the
 * emitted type is not trivial — hoisting `unknown` or `string` behind an
 * opaque alias name would only make the generated file harder to read for
 * zero benefit, and would trivially "dedupe" every schema-less workflow
 * (`inputSchema` undefined → emitted type `unknown`) into a shared alias the
 * moment two workflows both lack an input schema, which is the common case,
 * not an edge case.
 *
 * @module cli/codegen-emit-dedup
 */

import { hashString } from '../runtime/portable.ts';
import { CodegenEmitError } from './codegen-emit-keywords.ts';

export { CodegenEmitError } from './codegen-emit-keywords.ts';

/** One schema fragment's independently-emitted TypeScript text. */
export type SchemaFragmentOccurrence = {
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
  firstIndex: number;
};

function groupOccurrences(
  occurrences: readonly SchemaFragmentOccurrence[],
): ReadonlyMap<string, SchemaGroup> {
  const groups = new Map<string, SchemaGroup>();
  occurrences.forEach((occurrence, index) => {
    const existing = groups.get(occurrence.tsType);
    if (existing === undefined) {
      groups.set(occurrence.tsType, { count: 1, firstIndex: index });
    } else {
      existing.count += 1;
    }
  });
  return groups;
}

/**
 * Group a fixed, deterministically-ordered sequence of schema occurrences
 * by their emitted TypeScript text and decide which recurring, non-trivial
 * types should be hoisted into a shared `type` alias.
 *
 * Returns a map keyed by `tsType` (not by alias) so a caller emitting one
 * workflow entry's `input`/`output` field can look up "does this schema's
 * emitted type have a hoisted alias?" directly, without a second reverse
 * index — the caller computes the same `jsonSchemaToTypeScript` text it
 * would otherwise emit inline, and either finds an alias or emits that text.
 *
 * Alias names are deterministic: `ALIAS_PREFIX` plus a hash of the emitted
 * type text (FNV-1a via {@link hashString} by default, injectable via
 * `options.hash` for testing). A real hash collision between two different
 * emitted types is astronomically unlikely but not impossible, so it is
 * checked and throws {@link CodegenEmitError} rather than silently letting
 * one type's alias declaration shadow another's — `codegen.ts` already
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
  const orderedTypes = [...groups.keys()].toSorted(
    (a, b) => groups.get(a)!.firstIndex - groups.get(b)!.firstIndex,
  );

  const aliasOwners = new Map<string, string>();
  const table = new Map<string, SchemaAliasEntry>();

  for (const tsType of orderedTypes) {
    const group = groups.get(tsType)!;
    if (group.count < 2) continue;
    if (isTrivialTsType(tsType)) continue;

    const alias = `${ALIAS_PREFIX}${hash(tsType)}`;
    const owner = aliasOwners.get(alias);
    if (owner !== undefined && owner !== tsType) {
      throw new CodegenEmitError(
        `codegen: schema alias collision: emitted-type hashes ${JSON.stringify(hash(owner))} and ${JSON.stringify(hash(tsType))} both resolved to alias "${alias}"`,
      );
    }
    aliasOwners.set(alias, tsType);
    table.set(tsType, { alias, tsType });
  }

  return table;
}
