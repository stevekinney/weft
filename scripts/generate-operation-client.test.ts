import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CatalogOperationTypes } from '../src/cli/generated/operation-client.generated.ts';
import { createCatalogSnapshot } from '../src/cli/operation-catalog-snapshot.ts';
import { MAX_BATCH_OPERATIONS, MAX_SCAN_LIMIT } from '../src/storage/interface.ts';
import {
  aliasNameFor,
  assignAliasNames,
  canonicalKey,
  createOperationClientSource,
  isHoistWorthy,
  OPERATION_CLIENT_PATH,
  renderNode,
  schemaToNode,
  selectAliases,
  type TypeNode,
} from './generate-operation-client.ts';

const NO_ALIASES = new Map<string, string>();

function snapshotOperation(name: string) {
  const operation = createCatalogSnapshot().operations.find((candidate) => candidate.name === name);
  if (operation === undefined) {
    throw new Error(`Missing operation snapshot ${name}`);
  }
  return operation;
}

/** Render a JSON Schema with no alias substitution — the pre-hoist baseline. */
function renderInline(schema: Record<string, unknown>): string {
  return renderNode(schemaToNode(schema), NO_ALIASES);
}

describe('schemaToNode + renderNode — emitted text contract', () => {
  // These assertions pin the exact TypeScript text the generator emits for each
  // supported schema feature. Snapshot schemas arrive key-sorted, so on the real
  // catalog this matches the pre-refactor `Object.entries` order byte-for-byte;
  // the explicit field sort here is the intentional, enforced invariant.
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

  it('falls back to unknown for unsupported type-array members', () => {
    expect(renderInline({ type: ['string', 123] })).toBe('string | unknown');
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

  it('renders a string enum as a literal union preserving member order', () => {
    expect(renderInline({ type: 'string', enum: ['started', 'signalled'] })).toBe(
      '"started" | "signalled"',
    );
    // A bare string enum (no explicit `type`) is still a literal union.
    expect(renderInline({ enum: ['a', 'b'] })).toBe('"a" | "b"');
  });

  it('escapes string-enum members with literal-sensitive characters', () => {
    // Raw interpolation would emit invalid or wrong TypeScript for these; the
    // generator must produce a properly escaped string literal per member.
    expect(renderInline({ enum: ["can't"] })).toBe('"can\'t"');
    expect(renderInline({ enum: ['a\\b'] })).toBe('"a\\\\b"');
    expect(renderInline({ enum: ['line\nbreak'] })).toBe('"line\\nbreak"');
    expect(renderInline({ enum: ['quote"d'] })).toBe('"quote\\"d"');
  });

  it('collapses unsupported schema features to unknown', () => {
    // Non-string and mixed enums fall through rather than guessing a literal.
    expect(renderInline({ enum: [1, 2] })).toBe('unknown');
    expect(renderInline({ enum: ['a', 2] })).toBe('unknown');
    expect(renderInline({ enum: [] })).toBe('unknown');
    expect(renderInline({ const: 'x' })).toBe('unknown');
    expect(renderInline({ anyOf: [{ type: 'string' }] })).toBe('unknown');
    expect(renderInline({})).toBe('unknown');
  });
});

describe('generated catalog — string enums tighten to literal unions (#466)', () => {
  // Pin the regression: the generated client must surface the startOrSignal
  // discriminant as a literal union, not a widened `string`. Imported from the
  // generated module so a generator regression is caught here, not re-derived.
  it('types startorsignal output.outcome as the literal union', () => {
    type Outcome = CatalogOperationTypes['weft.workflows.startorsignal']['output']['outcome'];
    const started: Outcome = 'started';
    const signalled: Outcome = 'signalled';
    expect([started, signalled]).toEqual(['started', 'signalled']);
    // @ts-expect-error 'string' is too wide; the generated type is the literal union.
    const widened: Outcome = 'not-an-outcome' as string;
    void widened;
  });
});

describe('createOperationClientSource — generated output', () => {
  it('carries raw storage operation caps in the catalog schemas', () => {
    const scanProperties = snapshotOperation('weft.storage.scan').inputSchema[
      'properties'
    ] as Record<string, Record<string, unknown>>;
    expect(scanProperties['limit']['maximum']).toBe(MAX_SCAN_LIMIT);

    const batchProperties = snapshotOperation('weft.storage.batch').inputSchema[
      'properties'
    ] as Record<string, Record<string, unknown>>;
    expect(batchProperties['operations']['maxItems']).toBe(MAX_BATCH_OPERATIONS);

    const conditionalBatchProperties = snapshotOperation('weft.storage.conditionalbatch')
      .inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(conditionalBatchProperties['conditions']['maxItems']).toBe(MAX_BATCH_OPERATIONS);
    expect(conditionalBatchProperties['operations']['maxItems']).toBe(MAX_BATCH_OPERATIONS);
  });

  it('is deterministic across runs', async () => {
    const snapshot = createCatalogSnapshot();
    const first = await createOperationClientSource(snapshot);
    const second = await createOperationClientSource(snapshot);
    expect(first).toBe(second);
  });

  it('canonical keys are independent of property insertion order', () => {
    // Exercises the field-sort defense: two objects with the same fields in
    // different declaration order must dedupe to one alias, never two.
    const forward = schemaToNode({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    });
    const reverse = schemaToNode({
      type: 'object',
      properties: { b: { type: 'number' }, a: { type: 'string' } },
    });
    expect(canonicalKey(forward)).toBe(canonicalKey(reverse));
  });

  it('assigns alias names independent of candidate insertion order', () => {
    const left = schemaToNode({
      type: 'object',
      properties: { gt: { type: 'number' }, lt: { type: 'number' }, eq: { type: 'number' } },
    });
    const right = schemaToNode({
      type: 'object',
      properties: { x: { type: 'string' }, y: { type: 'string' }, z: { type: 'string' } },
    });
    const forward = assignAliasNames(
      new Map([
        [canonicalKey(left), left],
        [canonicalKey(right), right],
      ]),
    );
    const reverse = assignAliasNames(
      new Map([
        [canonicalKey(right), right],
        [canonicalKey(left), left],
      ]),
    );
    const byKey = (first: [string, string], second: [string, string]) =>
      first[0] < second[0] ? -1 : 1;
    expect([...forward.entries()].toSorted(byKey)).toEqual([...reverse.entries()].toSorted(byKey));
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

  it('routes bulk.cancel, bulk.delete, and bulk.retryfailed inputs through the same alias', async () => {
    const source = await createOperationClientSource(createCatalogSnapshot());
    const cancel = source.match(
      /'weft\.workflows\.bulk\.cancel': \{\s*readonly input: (Shared\w+);/,
    );
    const remove = source.match(
      /'weft\.workflows\.bulk\.delete': \{\s*readonly input: (Shared\w+);/,
    );
    const retryFailed = source.match(
      /'weft\.workflows\.bulk\.retryfailed': \{\s*readonly input: (Shared\w+);/,
    );
    expect(cancel?.[1]).toBeDefined();
    expect(remove?.[1]).toBeDefined();
    expect(retryFailed?.[1]).toBeDefined();
    expect(cancel?.[1]).toBe(remove?.[1]);
    expect(cancel?.[1]).toBe(retryFailed?.[1]);
  });

  it('leaves bulk.signal input inline but substitutes its nested aliases', async () => {
    const source = await createOperationClientSource(createCatalogSnapshot());
    // bulk.signal carries extra `name`/`payload` fields, so its whole input is a
    // distinct shape from cancel/delete and is intentionally NOT routed through
    // the shared filter alias. Its nested date-range/attribute shapes still
    // collapse to aliases.
    const signal = source.match(
      /'weft\.workflows\.bulk\.signal': \{\s*readonly input: (\{[^}]*?readonly name: string;[\s\S]*?\});/,
    );
    expect(signal?.[1]).toBeDefined();
    expect(signal?.[1]).toContain('readonly payload?: unknown;');
    // Nested aliases substituted inside the inline signal input.
    expect(signal?.[1]).toMatch(/readonly createdAt\?: Shared\w+;/);
    expect(signal?.[1]).toMatch(/readonly attributes\?: ReadonlyArray<Shared\w+>;/);
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

  it('regenerates the checked-in client from the CLI entrypoint', async () => {
    const expectedSource = await createOperationClientSource(createCatalogSnapshot());
    const directory = await mkdtemp(join(tmpdir(), 'weft-operation-client-'));
    try {
      const snapshotPath = join(directory, 'operation-client.generated.ts.before');
      await Bun.write(snapshotPath, await Bun.file(OPERATION_CLIENT_PATH).text());

      const result = Bun.spawn({
        cmd: ['bun', 'scripts/generate-operation-client.ts'],
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await result.exited;
      const stdout = await new Response(result.stdout).text();
      const stderr = await new Response(result.stderr).text();

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain(`wrote ${OPERATION_CLIENT_PATH}`);
      expect(await Bun.file(OPERATION_CLIENT_PATH).text()).toBe(expectedSource);
      expect(await Bun.file(snapshotPath).text()).toBe(expectedSource);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe('alias selection thresholds', () => {
  const object = (...names: string[]): TypeNode => ({
    kind: 'object',
    fields: names.map((name) => ({
      name,
      optional: false,
      value: { kind: 'primitive', text: 'string' },
    })),
  });

  it('does not alias the 1-field key object in real output', async () => {
    const source = await createOperationClientSource(createCatalogSnapshot());
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
    const prim = (text: string): TypeNode => ({ kind: 'primitive', text });
    const c: TypeNode = {
      kind: 'object',
      fields: [
        { name: 'p', optional: false, value: prim('number') },
        { name: 'q', optional: false, value: prim('number') },
        { name: 'r', optional: false, value: prim('number') },
      ],
    };
    const b: TypeNode = {
      kind: 'object',
      fields: [
        { name: 'm', optional: false, value: c },
        { name: 'n', optional: false, value: c },
        { name: 'o', optional: false, value: prim('string') },
      ],
    };
    const a: TypeNode = {
      kind: 'object',
      fields: [
        { name: 'a', optional: false, value: b },
        { name: 'b', optional: false, value: prim('string') },
        { name: 'c', optional: false, value: prim('string') },
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

describe('type equivalence — aliases are transparent at call sites', () => {
  // These assignments fail `bun run typecheck` (and `bun test`'s tsc pass) if
  // hoisting an inline shape into a named alias ever changes the structural type
  // a consumer sees. The central PR contract is checked at compile time here.
  it('accepts a bulk-filter input literal through the hoisted alias', () => {
    const input: CatalogOperationTypes['weft.workflows.bulk.cancel']['input'] = {
      idPrefix: 'order-',
      limit: 10,
      createdAt: { gt: 1, lte: 2 },
      executionDeadline: { gte: 3 },
      attributes: [{ key: 'region', value: 'us-east' }],
      tags: ['urgent'],
      confirmationToken: 'token',
      dryRun: true,
    };
    expect(input.limit).toBe(10);
  });

  it('keeps bulk.cancel, bulk.delete, and bulk.retryfailed inputs mutually assignable', () => {
    const cancel: CatalogOperationTypes['weft.workflows.bulk.cancel']['input'] = { limit: 1 };
    const remove: CatalogOperationTypes['weft.workflows.bulk.delete']['input'] = cancel;
    const retryFailed: CatalogOperationTypes['weft.workflows.bulk.retryfailed']['input'] = remove;
    const back: CatalogOperationTypes['weft.workflows.bulk.cancel']['input'] = retryFailed;
    expect(back.limit).toBe(1);
  });

  it('exposes the nested date-range alias as the same structural shape', () => {
    const range: NonNullable<
      CatalogOperationTypes['weft.workflows.bulk.signal']['input']['createdAt']
    > = { gt: 1, gte: 2, lt: 3, lte: 4 };
    expect(range.lte).toBe(4);
  });
});
