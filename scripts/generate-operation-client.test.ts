import { describe, expect, it } from 'bun:test';

import { createCatalogSnapshot } from '../src/cli/operation-catalog-snapshot.ts';
import {
  aliasNameFor,
  assignAliasNames,
  canonicalKey,
  createOperationClientSource,
  renderNode,
  schemaToNode,
  type TypeNode,
} from './generate-operation-client.ts';

const NO_ALIASES = new Map<string, string>();

/** Render a JSON Schema with no alias substitution — the pre-hoist baseline. */
function renderInline(schema: Record<string, unknown>): string {
  return renderNode(schemaToNode(schema), NO_ALIASES);
}

describe('schemaToNode + renderNode — byte-identical baseline', () => {
  // These assertions pin the exact TypeScript text the pre-refactor generator
  // produced for each supported schema feature. Any drift fails here.
  it('renders primitives', () => {
    expect(renderInline({ type: 'string' })).toBe('string');
    expect(renderInline({ type: 'number' })).toBe('number');
    expect(renderInline({ type: 'integer' })).toBe('number');
    expect(renderInline({ type: 'boolean' })).toBe('boolean');
    expect(renderInline({ type: 'null' })).toBe('null');
  });

  it('renders arrays as ReadonlyArray', () => {
    expect(renderInline({ type: 'array', items: { type: 'string' } })).toBe(
      'ReadonlyArray<string>',
    );
    expect(renderInline({ type: 'array' })).toBe('ReadonlyArray<unknown>');
  });

  it('renders type-array unions preserving member order', () => {
    expect(renderInline({ type: ['string', 'number', 'null'] })).toBe('string | number | null');
  });

  it('renders objects with sorted fields and required handling', () => {
    expect(
      renderInline({
        type: 'object',
        properties: { b: { type: 'string' }, a: { type: 'number' } },
        required: ['a'],
      }),
    ).toBe('{ readonly "a": number; readonly "b"?: string; }');
  });

  it('renders a no-properties object as Record<string, unknown>', () => {
    expect(renderInline({ type: 'object' })).toBe('Record<string, unknown>');
  });

  it('renders nested objects', () => {
    expect(
      renderInline({
        type: 'object',
        properties: { range: { type: 'object', properties: { gt: { type: 'number' } } } },
      }),
    ).toBe('{ readonly "range"?: { readonly "gt"?: number; }; }');
  });

  it('collapses unsupported schema features to unknown', () => {
    expect(renderInline({ enum: ['a', 'b'] })).toBe('unknown');
    expect(renderInline({ const: 'x' })).toBe('unknown');
    expect(renderInline({ anyOf: [{ type: 'string' }] })).toBe('unknown');
    expect(renderInline({})).toBe('unknown');
  });
});

describe('createOperationClientSource — generated output', () => {
  it('is deterministic across runs', async () => {
    const snapshot = createCatalogSnapshot();
    const first = await createOperationClientSource(snapshot);
    const second = await createOperationClientSource(snapshot);
    expect(first).toBe(second);
  });

  it('hoists the date-range shape into exactly one alias', async () => {
    const source = await createOperationClientSource(createCatalogSnapshot());
    const rangeDeclarations = [
      ...source.matchAll(
        /type (Shared\w+) = \{\s*readonly gt\?: number;\s*readonly gte\?: number;\s*readonly lt\?: number;\s*readonly lte\?: number;\s*\};/g,
      ),
    ];
    expect(rangeDeclarations).toHaveLength(1);
  });

  it('routes bulk.cancel and bulk.delete inputs through the same alias', async () => {
    const source = await createOperationClientSource(createCatalogSnapshot());
    const cancel = source.match(
      /'weft\.workflows\.bulk\.cancel': \{\s*readonly input: (Shared\w+);/,
    );
    const remove = source.match(
      /'weft\.workflows\.bulk\.delete': \{\s*readonly input: (Shared\w+);/,
    );
    expect(cancel?.[1]).toBeDefined();
    expect(remove?.[1]).toBeDefined();
    expect(cancel?.[1]).toBe(remove?.[1]);
  });

  it('never emits a self-referential alias', async () => {
    const source = await createOperationClientSource(createCatalogSnapshot());
    for (const [, name] of source.matchAll(/type (Shared\w+) = /g)) {
      expect(source).not.toContain(`type ${name} = ${name};`);
    }
  });

  it('references every alias at least twice (no single-use aliases)', async () => {
    const source = await createOperationClientSource(createCatalogSnapshot());
    const names = [...source.matchAll(/type (Shared\w+) = /g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const occurrences = source.match(new RegExp(`\\b${name}\\b`, 'g')) ?? [];
      // declaration + at least two non-declaration references
      expect(occurrences.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('alias selection thresholds', () => {
  it('does not alias the 1-field key object in real output', async () => {
    const source = await createOperationClientSource(createCatalogSnapshot());
    // The attribute element { gt, gte, key, lt, lte, value } is aliased, but a
    // bare { readonly "key": string } object must never become its own alias.
    expect(source).not.toMatch(/type Shared\w+ = \{ readonly "key": string; \};/);
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
