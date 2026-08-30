import { describe, expect, it } from 'bun:test';

import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
  storageBackends,
} from '../testing/storage-backends.test-support.ts';
import { BunSQLiteStorage } from './bun-sql.ts';
import { TursoStorage } from './turso.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const conditionalBatchBackends = storageBackends.map((backend) => {
  if (backend.name !== 'TursoStorage') {
    return backend;
  }

  return {
    name: backend.name,
    factory: () => {
      const fixture = createDiskBackedTestFixture({
        prefix: 'turso-conditional-batch',
        suffix: '.db',
        sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
      });
      const storage = new TursoStorage({ url: `file:${fixture.path}` });

      return {
        storage,
        cleanup: () => {
          storage[Symbol.dispose]();
          fixture.cleanup();
        },
      };
    },
  };
});

describe('storage persistence capabilities', () => {
  it('reports MemoryStorage as ephemeral', () => {
    const { storage, cleanup } = storageBackends[0]!.factory();
    try {
      expect(storage.capabilities().persistence).toBe('ephemeral');
    } finally {
      cleanup();
    }
  });

  it('reports BunSQLiteStorage :memory: as ephemeral and file storage as local', () => {
    using inMemory = new BunSQLiteStorage(':memory:');
    const fixture = createDiskBackedTestFixture({
      prefix: 'bun-sqlite-persistence',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const fileStorage = new BunSQLiteStorage(fixture.path);

    try {
      expect(inMemory.capabilities().persistence).toBe('ephemeral');
      expect(fileStorage.capabilities().persistence).toBe('local');
    } finally {
      fileStorage[Symbol.dispose]();
      fixture.cleanup();
    }
  });

  it('reports TursoStorage file::memory: as ephemeral, file URLs as local, and remote URLs as remote', () => {
    using inMemory = new TursoStorage({ url: 'file::memory:' });
    const fixture = createDiskBackedTestFixture({
      prefix: 'turso-persistence',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const local = new TursoStorage({ url: `file:${fixture.path}` });
    const remote = new TursoStorage({ url: 'libsql://example.turso.io' });

    try {
      expect(inMemory.capabilities().persistence).toBe('ephemeral');
      expect(local.capabilities().persistence).toBe('local');
      expect(remote.capabilities().persistence).toBe('remote');
    } finally {
      local[Symbol.dispose]();
      remote[Symbol.dispose]();
      fixture.cleanup();
    }
  });
});

for (const backend of conditionalBatchBackends) {
  describe(`${backend.name} conditional batch`, () => {
    it('commits a batch when every condition matches', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.conditionalBatch).toBeDefined();

        await storage.put('condition:match', encode('before'));

        const committed = await storage.conditionalBatch!(
          [{ key: 'condition:match', expectedValue: encode('before') }],
          [
            { type: 'put', key: 'condition:match', value: encode('after') },
            { type: 'put', key: 'condition:new', value: encode('created') },
          ],
        );

        expect(committed).toBe(true);
        expect(await storage.get('condition:match')).toEqual(encode('after'));
        expect(await storage.get('condition:new')).toEqual(encode('created'));
      } finally {
        cleanup();
      }
    });

    it('does not apply writes when a condition mismatches', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.conditionalBatch).toBeDefined();

        await storage.put('condition:match', encode('before'));

        const committed = await storage.conditionalBatch!(
          [{ key: 'condition:match', expectedValue: encode('stale') }],
          [{ type: 'put', key: 'condition:match', value: encode('after') }],
        );

        expect(committed).toBe(false);
        expect(await storage.get('condition:match')).toEqual(encode('before'));
      } finally {
        cleanup();
      }
    });

    it('treats null expected values as key absence', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.conditionalBatch).toBeDefined();

        const committed = await storage.conditionalBatch!(
          [{ key: 'condition:missing', expectedValue: null }],
          [{ type: 'put', key: 'condition:missing', value: encode('created') }],
        );

        expect(committed).toBe(true);
        expect(await storage.get('condition:missing')).toEqual(encode('created'));
      } finally {
        cleanup();
      }
    });
  });
}
