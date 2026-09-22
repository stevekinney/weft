import { describe, expect, it } from 'bun:test';

import type {
  CatalogOperationTypes,
  ClientOperationTypes,
} from '../src/client/generated/operation-client.generated.ts';
import { createCatalogSnapshot } from '../src/server/operation-catalog-snapshot.ts';
import { type StorageCapabilities } from '../src/storage/interface.ts';

import { generatedSourcesText, snapshotOperation } from './operation-client-test-support.ts';
describe('schedule update operation generation', () => {
  it('emits every mutable schedule option in the generated input type', async () => {
    const source = await generatedSourcesText(createCatalogSnapshot());
    const updateScheduleEntry = source.match(
      /'weft\.schedules\.update': \{[\s\S]*?readonly output: null;/,
    )?.[0];

    expect(updateScheduleEntry).toContain('readonly backfill?: unknown;');
    expect(updateScheduleEntry).toContain('readonly description?: unknown;');
    expect(updateScheduleEntry).toContain('readonly jitter?: unknown;');
    expect(updateScheduleEntry).toContain('readonly overlap?: unknown;');
    expect(snapshotOperation('weft.schedules.update').producibleFaults).toContain('InvalidParams');
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

describe('generated catalog — storage capabilities', () => {
  it('keeps the generated output structurally compatible with StorageCapabilities', () => {
    const profile = {
      persistence: 'remote',
      readAfterWrite: 'eventual',
      scanConsistency: 'best-effort',
      atomicBatch: false,
      conditionalBatch: false,
      boundedRangeDelete: false,
    } satisfies StorageCapabilities;
    const generated: CatalogOperationTypes['weft.storage.capabilities']['output'] = profile;
    const roundTrip: StorageCapabilities = generated;

    expect(roundTrip).toEqual(profile);
  });
});

describe('generated client transport coverage', () => {
  it('includes ordinary REST-only unary operations without pretending JSON-RPC supports them', async () => {
    const source = await generatedSourcesText(createCatalogSnapshot());

    expect(source).toContain('export const CLIENT_OPERATION_NAMES = [');
    expect(source).toMatch(
      /CLIENT_OPERATION_NAMES = \[[\s\S]*'weft\.tasks\.diagnostics\.deadletters\.clear'/,
    );
    const catalogNames = source.slice(
      source.indexOf('export const CATALOG_OPERATION_NAMES'),
      source.indexOf('export type CatalogOperationName'),
    );
    expect(catalogNames).not.toContain('weft.tasks.diagnostics.deadletters.clear');
    expect(source).toContain("'weft.tasks.diagnostics.deadletters.clear': {");
    expect(source).toContain("path: '/tasks/diagnostics/dead-letter/:operationId'");
  });

  it('keeps byte and streaming storage operations on the dedicated storage facade', async () => {
    const source = await generatedSourcesText(createCatalogSnapshot());
    const clientNames = source.slice(
      source.indexOf('export const CLIENT_OPERATION_NAMES'),
      source.indexOf('export type ClientOperationName'),
    );

    expect(clientNames).not.toContain('weft.storage.get');
    expect(clientNames).not.toContain('weft.storage.put');
    expect(clientNames).not.toContain('weft.storage.delete');
    expect(clientNames).not.toContain('weft.storage.scan');
    expect(clientNames).not.toContain('weft.storage.batch');
    expect(clientNames).not.toContain('weft.storage.conditionalbatch');
  });

  it('types the REST-only dead-letter clear operation for client call sites', () => {
    type Input = ClientOperationTypes['weft.tasks.diagnostics.deadletters.clear']['input'];
    type Output = ClientOperationTypes['weft.tasks.diagnostics.deadletters.clear']['output'];
    const input: Input = { operationId: 'op-1' };
    const output: Output = { ok: true };
    expect({ input, output }).toEqual({ input: { operationId: 'op-1' }, output: { ok: true } });
  });

  it('types delayed and unadopted-terminal diagnostics without unknown output', () => {
    type Item = ClientOperationTypes['weft.tasks.diagnostics']['output']['items'][number];
    const delayed: Item = {
      kind: 'delayed',
      state: 'queued',
      operationId: 'op-delayed',
      queue: 'payments',
      retryCount: 1,
      requeueCount: 1,
      availableAt: 30_000,
      evidence: ['delayed'],
    };
    const unadopted: Item = {
      kind: 'unadopted-terminal',
      state: 'resolved',
      operationId: 'op-terminal',
      queue: 'payments',
      terminalAt: 1_000,
      adopted: false,
      evidence: ['unadopted'],
    };
    expect([delayed.kind, unadopted.kind]).toEqual(['delayed', 'unadopted-terminal']);
    // @ts-expect-error terminal diagnostics deliberately expose no attempt-count history.
    unadopted.retryCount;
  });
});

describe('type equivalence — aliases are transparent at call sites', () => {
  // These assignments fail `bun run typecheck` if
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
