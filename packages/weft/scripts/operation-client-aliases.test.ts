import { describe, expect, it } from 'bun:test';

import { createCatalogSnapshot } from '../src/server/operation-catalog-snapshot.ts';
import {
  aliasNameFor,
  assignAliasNames,
  isHoistWorthy,
  selectAliases,
} from './operation-client-aliases.ts';
import { canonicalKey, type TypeNode } from './operation-client-schema.ts';

import { generatedSourcesText } from './operation-client-test-support.ts';
const object = (...names: string[]): TypeNode => ({
  kind: 'object',
  fields: names.map((name) => ({
    name,
    optional: false,
    value: { kind: 'primitive', text: 'string' },
  })),
});

const nestedPair = (): { inner: TypeNode; outer: TypeNode } => {
  const inner: TypeNode = {
    kind: 'object',
    fields: [
      { name: 'p', optional: false, value: { kind: 'primitive', text: 'string' } },
      { name: 'q', optional: false, value: { kind: 'primitive', text: 'string' } },
      { name: 'r', optional: false, value: { kind: 'primitive', text: 'string' } },
    ],
  };
  const outer: TypeNode = {
    kind: 'object',
    fields: [
      { name: 'a', optional: false, value: inner },
      { name: 'b', optional: false, value: { kind: 'primitive', text: 'string' } },
      { name: 'c', optional: false, value: { kind: 'primitive', text: 'string' } },
    ],
  };
  return { inner, outer };
};

const primitiveNode = (text: string): TypeNode => ({ kind: 'primitive', text });

describe('alias selection thresholds', () => {
  it('does not alias the 1-field key object in real output', async () => {
    const source = await generatedSourcesText(createCatalogSnapshot());
    // The attribute element { gt, gte, key, lt, lte, value } is aliased, but a
    // bare { readonly "key": string } object must never become its own alias.
    expect(source).not.toMatch(/type Shared\w+ = \{ readonly "key": string; \};/);
  });

  it('hoists a >=3-field object that repeats twice', () => {
    expect(isHoistWorthy(object('a', 'b', 'c'), 2)).toBe(true);
  });

  it('never hoists a 1-field object no matter how often it repeats', () => {
    expect(isHoistWorthy(object('key'), 2)).toBe(false);
    expect(isHoistWorthy(object('key'), 9)).toBe(false);
  });

  it('hoists a 2-field object only when it repeats at least three times', () => {
    expect(isHoistWorthy(object('a', 'b'), 2)).toBe(false);
    expect(isHoistWorthy(object('a', 'b'), 3)).toBe(true);
  });

  it('never hoists non-object nodes', () => {
    expect(isHoistWorthy({ kind: 'primitive', text: 'string' }, 9)).toBe(false);
    expect(
      isHoistWorthy({ kind: 'array', element: { kind: 'primitive', text: 'string' } }, 9),
    ).toBe(false);
  });
});

describe('selectAliases — prune to fixed point', () => {
  // Both fixed-point tests below share the same nested shape: a 3-field `inner`
  // object embedded as the first field of a 3-field `outer` object. The factory
  // returns a fresh pair so neither test can mutate the other's nodes.

  it('prunes a child whose references collapse into a single alias body', () => {
    // `inner` occurs once inside `outer`; `outer` occurs twice across the roots.
    // By occurrence count both qualify (inner=2 via the two outers, outer=2).
    // But once `outer` is hoisted, `inner` is referenced only from `outer`'s one
    // body — a single reference — so the prune pass drops `inner`, keeping `outer`.
    const { outer } = nestedPair();
    const { aliasNameByKey, nodeByKey } = selectAliases([outer, outer]);
    expect(aliasNameByKey.size).toBe(1);
    expect([...nodeByKey.values()]).toEqual([outer]);
  });

  it('keeps a child alias referenced by a surviving parent and an entry', () => {
    const { inner, outer } = nestedPair();
    // `outer` appears twice (two roots) -> survives -> references `inner` once;
    // `inner` also appears directly as a root -> 2 references total -> survives.
    const { aliasNameByKey } = selectAliases([outer, outer, inner]);
    expect(aliasNameByKey.size).toBe(2);
  });

  it('recovers a deeply nested alias after its parent is pruned', () => {
    // C nests in B nests in A. B is referenced only once (in A's body) so B is
    // pruned; once B inlines into A, C surfaces twice inside A and survives.
    // This exercises the body-discovery walk: it must descend through a pruned
    // parent to keep a grandchild that is genuinely shared.

    const c: TypeNode = {
      kind: 'object',
      fields: [
        { name: 'p', optional: false, value: primitiveNode('number') },
        { name: 'q', optional: false, value: primitiveNode('number') },
        { name: 'r', optional: false, value: primitiveNode('number') },
      ],
    };
    const b: TypeNode = {
      kind: 'object',
      fields: [
        { name: 'm', optional: false, value: c },
        { name: 'n', optional: false, value: c },
        { name: 'o', optional: false, value: primitiveNode('string') },
      ],
    };
    const a: TypeNode = {
      kind: 'object',
      fields: [
        { name: 'a', optional: false, value: b },
        { name: 'b', optional: false, value: primitiveNode('string') },
        { name: 'c', optional: false, value: primitiveNode('string') },
      ],
    };
    const { aliasNameByKey, nodeByKey } = selectAliases([a, a]);
    // Survivors: A (two roots) and C (twice inside A after B inlines). Not B.
    expect(aliasNameByKey.size).toBe(2);
    const survivors = new Set(nodeByKey.values());
    expect(survivors.has(a)).toBe(true);
    expect(survivors.has(c)).toBe(true);
    expect(survivors.has(b)).toBe(false);
  });
});

describe('aliasNameFor — stable naming', () => {
  const rangeNode: TypeNode = {
    kind: 'object',
    fields: [
      { name: 'gt', optional: true, value: { kind: 'primitive', text: 'number' } },
      { name: 'gte', optional: true, value: { kind: 'primitive', text: 'number' } },
      { name: 'lt', optional: true, value: { kind: 'primitive', text: 'number' } },
      { name: 'lte', optional: true, value: { kind: 'primitive', text: 'number' } },
    ],
  };

  it('produces a Shared<hint>_<hash> name with an 8-hex-char hash', () => {
    const name = aliasNameFor(rangeNode);
    expect(name).toMatch(/^SharedGtGteLt_[0-9a-f]{8}$/);
  });

  it('is stable across calls', () => {
    expect(aliasNameFor(rangeNode)).toBe(aliasNameFor(rangeNode));
  });

  it('truncates the readable hint to at most 24 characters', () => {
    const wide: TypeNode = {
      kind: 'object',
      fields: [
        {
          name: 'alphaBravoCharlie',
          optional: false,
          value: { kind: 'primitive', text: 'string' },
        },
        { name: 'deltaEchoFoxtrot', optional: false, value: { kind: 'primitive', text: 'string' } },
        { name: 'golfHotelIndia', optional: false, value: { kind: 'primitive', text: 'string' } },
      ],
    };
    const hint = aliasNameFor(wide)
      .slice('Shared'.length)
      .replace(/_[0-9a-f]{8}$/, '');
    expect(hint.length).toBeLessThanOrEqual(24);
  });
});

describe('assignAliasNames — collision guard', () => {
  it('throws when two distinct shapes resolve to the same alias name', () => {
    const nodeA: TypeNode = {
      kind: 'object',
      fields: [
        { name: 'a', optional: false, value: { kind: 'primitive', text: 'string' } },
        { name: 'b', optional: false, value: { kind: 'primitive', text: 'string' } },
        { name: 'c', optional: false, value: { kind: 'primitive', text: 'string' } },
      ],
    };
    const nodeB: TypeNode = {
      kind: 'object',
      fields: [
        { name: 'a', optional: false, value: { kind: 'primitive', text: 'number' } },
        { name: 'b', optional: false, value: { kind: 'primitive', text: 'number' } },
        { name: 'c', optional: false, value: { kind: 'primitive', text: 'number' } },
      ],
    };
    const candidates = new Map<string, TypeNode>([
      [canonicalKey(nodeA), nodeA],
      [canonicalKey(nodeB), nodeB],
    ]);
    // A constant hash forces both distinct keys to the same name through the
    // real production assignment path.
    expect(() => assignAliasNames(candidates, () => 'deadbeef')).toThrow(/alias name collision/);
  });
});
