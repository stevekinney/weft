import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOperationClientSources,
  OPERATION_CLIENT_DIRECTORY,
} from './generate-operation-client.ts';

import {
  createCatalogSnapshot,
  stringifyCatalogSnapshot,
} from '../src/server/operation-catalog-snapshot.ts';
import { MAX_BATCH_OPERATIONS, MAX_SCAN_LIMIT } from '../src/storage/interface.ts';
import { assignAliasNames } from './operation-client-aliases.ts';
import { canonicalKey, schemaToNode } from './operation-client-schema.ts';

import {
  generatedSourcesText,
  snapshotOperation,
  snapshotTestOperation,
} from './operation-client-test-support.ts';
function compareAliasEntries(first: [string, string], second: [string, string]): number {
  return first[0] < second[0] ? -1 : 1;
}

describe('createOperationClientSources — generated output', () => {
  it('carries raw storage operation caps in the catalog schemas', () => {
    expect(snapshotOperation('weft.storage.scan').inputSchema).toMatchObject({
      properties: { limit: { maximum: MAX_SCAN_LIMIT } },
    });
    expect(snapshotOperation('weft.storage.batch').inputSchema).toMatchObject({
      properties: { operations: { maxItems: MAX_BATCH_OPERATIONS } },
    });
    expect(snapshotOperation('weft.storage.conditionalbatch').inputSchema).toMatchObject({
      properties: { conditions: { maxItems: MAX_BATCH_OPERATIONS } },
    });
    expect(snapshotOperation('weft.storage.conditionalbatch').inputSchema).toMatchObject({
      properties: { operations: { maxItems: MAX_BATCH_OPERATIONS } },
    });
  });

  it('stringifies catalog snapshots with a trailing newline', () => {
    const snapshot = createCatalogSnapshot();
    const serialized = stringifyCatalogSnapshot(snapshot);

    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized)).toEqual(snapshot);
  });

  it('serializes parameterized selector access in the catalog snapshot', () => {
    const operation = snapshotOperation('weft.workflows.events');

    expect(operation.parameterizedAccess).toEqual({
      discriminator: 'selector',
      defaultValue: 'events',
      variants: [
        { value: 'events', access: { kind: 'scoped', scopes: ['events:read'] } },
        { value: 'tokens', access: { kind: 'scoped', scopes: ['streams:read'] } },
      ],
    });
  });

  it('serializes and sorts every scope-bearing catalog access shape', () => {
    const snapshot = createCatalogSnapshot([
      snapshotTestOperation('weft.test.scoped', {
        kind: 'scoped',
        scopes: { kind: 'allOf', scopes: ['workflows:read', 'events:read'] },
      }),
      snapshotTestOperation('weft.test.optional', {
        kind: 'optionalAuth',
        authenticatedScopes: { kind: 'anyOf', scopes: ['workflows:read', 'events:read'] },
      }),
      snapshotTestOperation('weft.test.alternatives', {
        kind: 'scopedAlternatives',
        alternatives: [
          { kind: 'allOf', scopes: ['workflows:read', 'events:read'] },
          { kind: 'anyOf', scopes: ['streams:read'] },
        ],
      }),
    ]);

    expect(snapshot.operations.map(({ name, access }) => ({ name, access }))).toEqual([
      {
        name: 'weft.test.alternatives',
        access: {
          kind: 'scopedAlternatives',
          alternatives: [['events:read', 'workflows:read'], ['streams:read']],
        },
      },
      {
        name: 'weft.test.optional',
        access: { kind: 'optionalAuth', scopes: ['events:read', 'workflows:read'] },
      },
      {
        name: 'weft.test.scoped',
        access: { kind: 'scoped', scopes: ['events:read', 'workflows:read'] },
      },
    ]);
  });

  it('is deterministic across runs', async () => {
    const snapshot = createCatalogSnapshot();
    const first = await createOperationClientSources(snapshot);
    const second = await createOperationClientSources(snapshot);
    expect([...first]).toEqual([...second]);
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

    expect([...forward.entries()].toSorted(compareAliasEntries)).toEqual(
      [...reverse.entries()].toSorted(compareAliasEntries),
    );
  });

  it('hoists the date-range shape into exactly one alias', async () => {
    const source = await generatedSourcesText(createCatalogSnapshot());
    const rangeDeclarations = [
      ...source.matchAll(
        /type (Shared\w+) = \{\s*readonly gt\?: number;\s*readonly gte\?: number;\s*readonly lt\?: number;\s*readonly lte\?: number;\s*\};/g,
      ),
    ];
    expect(rangeDeclarations).toHaveLength(1);
  });

  it('routes bulk.cancel, bulk.delete, and bulk.retryfailed inputs through the same alias', async () => {
    const source = await generatedSourcesText(createCatalogSnapshot());
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
    const source = await generatedSourcesText(createCatalogSnapshot());
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
    const source = await generatedSourcesText(createCatalogSnapshot());
    for (const [, name] of source.matchAll(/type (Shared\w+) = /g)) {
      expect(source).not.toContain(`type ${name} = ${name};`);
    }
  });

  it('references every alias at least twice (no single-use aliases)', async () => {
    const source = await generatedSourcesText(createCatalogSnapshot());
    const names = [...source.matchAll(/type (Shared\w+) = /g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const declarationsAndUses = source.replace(/import type \{[^}]+\} from '[^']+';/g, '');
      const occurrences = declarationsAndUses.match(new RegExp(`\\b${name}\\b`, 'g')) ?? [];
      // declaration + at least two non-declaration references
      expect(occurrences.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('generates the complete checked-in client through the CLI into an isolated directory', async () => {
    const sources = await createOperationClientSources(createCatalogSnapshot());
    const directory = await mkdtemp(join(tmpdir(), 'weft-operation-client-'));
    try {
      // Check drift without rewriting the source checkout as part of a test.
      for (const [fileName, source] of sources) {
        expect(await Bun.file(join(OPERATION_CLIENT_DIRECTORY, fileName)).text()).toBe(source);
      }
      const result = Bun.spawn({
        cmd: ['bun', 'scripts/generate-operation-client.ts', '--output-directory', directory],
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await result.exited;
      const stdout = await new Response(result.stdout).text();
      const stderr = await new Response(result.stderr).text();
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      for (const [fileName, source] of sources) {
        expect(stdout).toContain(`wrote ${join(directory, fileName)}`);
        expect(await Bun.file(join(directory, fileName)).text()).toBe(source);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe('snapshotOperation', () => {
  it('throws when no catalog operation matches the given name', () => {
    expect(() => snapshotOperation('not-a-real-operation-name')).toThrow(
      'Missing operation snapshot not-a-real-operation-name',
    );
  });
});
