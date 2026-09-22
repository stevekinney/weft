import { compareStrings } from '../src/server/json-schema-utilities.ts';
import { canonicalKey, renderNode, type TypeNode } from './operation-client-schema.ts';

/**
 * Hoist a repeated object shape into a named alias only when it appears at least
 * twice. Below this it is unique and aliasing would only add indirection.
 */
const MINIMUM_OCCURRENCES = 2;

/**
 * Object shapes with at least this many fields are always worth a named alias
 * once they repeat. Smaller shapes (e.g. a single-field `{ key: string }`) are
 * left inline unless they repeat unusually often (see {@link FREQUENT_OCCURRENCES}).
 */
const LARGE_FIELD_COUNT = 3;

/**
 * The minimum field count and occurrence count under which a small (2-field)
 * shape still earns an alias. Keeps trivial 1-field objects inline while
 * de-duplicating genuinely repeated small records.
 */
const SMALL_FIELD_COUNT = 2;
const FREQUENT_OCCURRENCES = 3;

/** Number of PascalCased field-name fragments folded into a readable alias hint. */
const HINT_FIELD_LIMIT = 3;
/** Maximum length of the readable hint portion of an alias name. */
const HINT_MAX_LENGTH = 24;

export type AliasSelection = {
  readonly aliasNameByKey: ReadonlyMap<string, string>;
  readonly nodeByKey: ReadonlyMap<string, TypeNode>;
};

/**
 * Select which structural shapes to hoist into aliases. Prunes to a fixed point
 * so that every surviving alias is referenced at least twice across the emitted
 * alias bodies and operation entries. Returns both the name map and the original
 * nodes so declarations render without round-tripping through the string key.
 */
export function selectAliases(roots: ReadonlyArray<TypeNode>): AliasSelection {
  const counts = new Map<string, { count: number; node: TypeNode }>();
  for (const root of roots) collectCounts(root, counts);

  let candidates = new Map<string, TypeNode>();
  for (const [key, { count, node }] of counts) {
    if (isHoistWorthy(node, count)) candidates.set(key, node);
  }

  // Prune aliases referenced fewer than twice once substitution is applied.
  // Dropping a parent can lower a child's reference count, so iterate to a fixed
  // point. References are counted structurally over the node graph (not by text
  // matching), so the count is exact. The loop strictly shrinks `candidates`
  // each iteration until it stabilizes, so it terminates in at most
  // `candidates.size` rounds.
  for (;;) {
    const aliasKeys = new Set(candidates.keys());
    const references = countAliasReferences(aliasKeys, roots);
    const survivors = new Map<string, TypeNode>();
    for (const [key, node] of candidates) {
      if ((references.get(key) ?? 0) >= MINIMUM_OCCURRENCES) survivors.set(key, node);
    }
    if (survivors.size === candidates.size) break;
    candidates = survivors;
  }

  return { aliasNameByKey: assignAliasNames(candidates), nodeByKey: candidates };
}

/** Increment the occurrence count for `node` and recurse into its children. */
function collectCounts(
  node: TypeNode,
  counts: Map<string, { count: number; node: TypeNode }>,
): void {
  const key = canonicalKey(node);
  const existing = counts.get(key);
  if (existing) existing.count += 1;
  else counts.set(key, { count: 1, node });

  if (node.kind === 'array') collectCounts(node.element, counts);
  else if (node.kind === 'union') for (const member of node.members) collectCounts(member, counts);
  else if (node.kind === 'object')
    for (const field of node.fields) collectCounts(field.value, counts);
}

export function isHoistWorthy(node: TypeNode, count: number): boolean {
  if (node.kind !== 'object') return false;
  if (count < MINIMUM_OCCURRENCES) return false;
  const fieldCount = node.fields.length;
  if (fieldCount >= LARGE_FIELD_COUNT) return true;
  return fieldCount >= SMALL_FIELD_COUNT && count >= FREQUENT_OCCURRENCES;
}

/**
 * Assign a stable, readable, content-derived name to each candidate shape.
 * `hashFn` is injectable so the collision guard can be exercised in tests;
 * it defaults to the real FNV-1a hash.
 */
export function assignAliasNames(
  candidates: ReadonlyMap<string, TypeNode>,
  hashFn: (value: string) => string = fnv1a,
): Map<string, string> {
  const aliasNameByKey = new Map<string, string>();
  const keyByName = new Map<string, string>();
  // Deterministic assignment order so names never depend on Map insertion order.
  const sortedEntries = [...candidates.entries()].toSorted(([left], [right]) =>
    compareStrings(left, right),
  );
  for (const [key, node] of sortedEntries) {
    const name = aliasNameFor(node, hashFn);
    const existing = keyByName.get(name);
    if (existing !== undefined && existing !== key) {
      throw new Error(`alias name collision: ${name} for ${existing} and ${key}`);
    }
    keyByName.set(name, key);
    aliasNameByKey.set(key, name);
  }
  return aliasNameByKey;
}

/**
 * Build the alias name `Shared<hint>_<hash>` for an object node: a readable
 * hint drawn from the first sorted field names plus a stable content hash.
 */
export function aliasNameFor(node: TypeNode, hashFn: (value: string) => string = fnv1a): string {
  const fields = node.kind === 'object' ? node.fields : [];
  const hint = fields
    .slice(0, HINT_FIELD_LIMIT)
    .map((field) => toPascalCase(field.name))
    .join('')
    .slice(0, HINT_MAX_LENGTH);
  return `Shared${hint}_${hashFn(canonicalKey(node))}`;
}

/**
 * Count, per alias key, how many substitution sites would reference it once
 * `aliasKeys` are hoisted. Counts are structural — derived by walking the node
 * graph, never by matching rendered text. A reference is a position where a
 * hoisted key appears: a root that is itself an alias, or a child (array
 * element, object field, union member) whose key is hoisted. An alias node's
 * own body does not count as a self-reference (the body inlines its top level).
 */
function countAliasReferences(
  aliasKeys: ReadonlySet<string>,
  roots: ReadonlyArray<TypeNode>,
): Map<string, number> {
  const references = new Map<string, number>();
  for (const key of aliasKeys) references.set(key, 0);

  const bump = (key: string) => references.set(key, (references.get(key) ?? 0) + 1);

  /** Count alias references among the children of `node` (not `node` itself). */
  const countChildren = (node: TypeNode) => {
    if (node.kind === 'array') visitChild(node.element);
    else if (node.kind === 'union') for (const member of node.members) visitChild(member);
    else if (node.kind === 'object') for (const field of node.fields) visitChild(field.value);
  };

  const visitChild = (child: TypeNode) => {
    const key = canonicalKey(child);
    if (aliasKeys.has(key)) {
      // The child collapses to an alias reference; do not descend past it.
      bump(key);
      return;
    }
    countChildren(child);
  };

  // Operation entries: a root that is itself an alias is one reference.
  for (const root of roots) {
    const key = canonicalKey(root);
    if (aliasKeys.has(key)) bump(key);
    else countChildren(root);
  }

  // Alias bodies: each hoisted shape's body contributes references to the
  // nested aliases it substitutes (its own top level is inlined, not a self-ref).
  // The two steps below do DIFFERENT work and must both run for an alias node:
  // `countChildren` records this body's direct alias references (stopping at
  // alias boundaries), while the tail recursion keeps descending to discover and
  // count the bodies of aliases nested deeper. Returning early after
  // `countChildren` would miss grandchild aliases and is a bug, not an
  // optimization. `seen` makes the per-body counting idempotent across roots that
  // share a subtree.
  const seen = new Set<string>();
  const collectBodies = (node: TypeNode) => {
    const key = canonicalKey(node);
    if (aliasKeys.has(key) && !seen.has(key)) {
      seen.add(key);
      countChildren(node);
    }
    if (node.kind === 'array') collectBodies(node.element);
    else if (node.kind === 'union') for (const member of node.members) collectBodies(member);
    else if (node.kind === 'object') for (const field of node.fields) collectBodies(field.value);
  };
  for (const root of roots) collectBodies(root);

  return references;
}

/**
 * Render the `type Shared… = …;` declarations, sorted by alias name. Each body
 * is rendered from its original {@link TypeNode} with its own key suppressed, so
 * nested aliases substitute but the alias never references itself.
 */
export function renderAliasDeclarations(
  aliasNameByKey: ReadonlyMap<string, string>,
  nodeByKey: ReadonlyMap<string, TypeNode>,
): string[] {
  const entries = [...aliasNameByKey.entries()].toSorted(([, left], [, right]) =>
    compareStrings(left, right),
  );
  return entries.map(([key, name]) => {
    const node = nodeByKey.get(key);
    if (node === undefined) throw new Error(`missing node for alias ${name} (${key})`);
    return `type ${name} = ${renderNode(node, aliasNameByKey, key)};`;
  });
}

function toPascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
}

/**
 * 32-bit FNV-1a hash, formatted as 8 lowercase hex characters. Uses `Math.imul`
 * and `>>> 0` normalization to stay within unsigned 32-bit semantics regardless
 * of JavaScript's signed-int behavior.
 */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
