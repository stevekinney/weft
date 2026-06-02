/**
 * Native-transaction batch atomicity.
 *
 * Drives the adapter's real `batch()` (its native SQL transaction) and
 * forces a deterministic failure inside the transaction by passing a NULL
 * value to a column declared `BLOB NOT NULL`. Asserts the pre-batch state
 * is intact afterward — including the entries that came *before* the
 * failing index, which must roll back atomically.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { StorageCapabilities } from '../interface.ts';
import {
  availableAdapterSpecs,
  closeIfOpen,
  FixtureScope,
  type OpenedAdapter,
} from './adapter-spec.test-support.ts';

/** Expected capability row per durable adapter exercised by this suite. */
const expectedCapabilitiesBySpec: Record<string, StorageCapabilities> = {
  BunSQLiteStorage: {
    persistence: 'local',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
  NodeSQLiteStorage: {
    persistence: 'local',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: false,
  },
  TursoStorage: {
    persistence: 'local',
    readAfterWrite: 'session',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
};

for (const spec of availableAdapterSpecs()) {
  describe(`batch atomicity — ${spec.name}`, () => {
    let scope: FixtureScope;

    beforeEach(() => {
      scope = new FixtureScope();
    });

    afterEach(() => {
      scope.cleanup();
    });

    it('reports its durable consistency contract through capabilities()', async () => {
      const directory = scope.makeTempDirectory('capabilities');
      const adapter = await spec.open(join(directory, 'weft.db'));
      try {
        const expected = expectedCapabilitiesBySpec[spec.name];
        if (expected === undefined) {
          throw new Error(`No expected capability row for adapter spec "${spec.name}".`);
        }
        expect(adapter.storage.capabilities()).toEqual(expected);
        // The batch-atomicity proof below exercises the atomicBatch contract
        // these durable adapters all declare true.
        expect(adapter.storage.capabilities().atomicBatch).toBe(true);
      } finally {
        await closeIfOpen(adapter);
      }
    });

    it('a failing entry inside batch() rolls back all entries in the same transaction', async () => {
      let writer: OpenedAdapter | undefined;
      let reader: OpenedAdapter | undefined;
      try {
        const directory = scope.makeTempDirectory('batch-atomicity');
        const databasePath = join(directory, 'weft.db');

        writer = await spec.open(databasePath);

        // Seed the pre-batch baseline.
        await writer.storage.put('before:1', new Uint8Array([1]));
        await writer.storage.put('before:2', new Uint8Array([2]));

        // Build a 5-entry batch that fails at index 2.
        const operations = writer.makeFailingBatch(2, 5);
        await expect(writer.storage.batch(operations)).rejects.toBeInstanceOf(Error);

        // The transaction must have rolled back: no `mid:` entries at all,
        // including the ones that came before the failing index.
        await writer.close();
        writer = undefined;

        reader = await spec.open(databasePath);
        expect(await reader.storage.get('before:1')).not.toBeNull();
        expect(await reader.storage.get('before:2')).not.toBeNull();
        for (let index = 0; index < 5; index++) {
          const key = `mid:${index.toString().padStart(6, '0')}`;
          expect(await reader.storage.get(key)).toBeNull();
        }
      } catch (error) {
        scope.markFailed();
        throw error;
      } finally {
        await closeIfOpen(writer);
        await closeIfOpen(reader);
      }
    });
  });
}
