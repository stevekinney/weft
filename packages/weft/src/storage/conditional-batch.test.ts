import { describe, expect, it } from 'bun:test';

import { BunSQLiteStorage } from "../embedded/storage-bun-sqlite/src/index.ts";
import {
  createDiskBackedTestFixture,
  describeConditionalBatch,
  sqliteDatabaseSidecarSuffixes,
} from "../embedded/storage/src/testing/index.ts";
import { storageBackends } from '../testing/storage-backends.test-support.ts';

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
});

for (const backend of storageBackends) {
  describeConditionalBatch(backend);
}
