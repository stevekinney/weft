import { createClient } from '@libsql/client';
import { describe, expect, it } from 'bun:test';

import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from '../testing/storage-backends.test-support.ts';
import { SQLITE_UPSERT_VALUE_BY_KEY } from './sqlite-key-value-queries.ts';
import {
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';
import { TursoStorage } from './turso';

runStorageCapabilityConformance('TursoStorage', {
  // Local libSQL file mode on a real on-disk database so concurrent
  // conditionalBatch transactions share state (a `file::memory:` DB isolates
  // per connection). The adapter honestly reports the `session` floor that also
  // covers the remote-primary configuration.
  create: () => {
    const fixture = createDiskBackedTestFixture({ prefix: 'turso-capabilities', suffix: '.db' });
    return new TursoStorage({ url: `file:${fixture.path}` });
  },
  expected: {
    persistence: 'local',
    readAfterWrite: 'session',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
});

runBinaryAndLargeScanStorageConformance('TursoStorage', {
  create: () => new TursoStorage({ url: 'file::memory:' }),
});

function createFileBackedTursoStorage(prefix: string): {
  readonly storage: TursoStorage;
  readonly url: string;
  readonly cleanup: () => void;
} {
  const fixture = createDiskBackedTestFixture({
    prefix,
    suffix: '.db',
    sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
  });
  const url = `file:${fixture.path}`;
  const storage = new TursoStorage({ url });

  return {
    storage,
    url,
    cleanup: () => {
      storage[Symbol.dispose]();
      fixture.cleanup();
    },
  };
}

/** Helper to encode a string as Uint8Array. */
function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Helper to decode a Uint8Array to string. */
function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

describe('TursoStorage', () => {
  runBasicStorageContract('TursoStorage', {
    create: () => new TursoStorage({ url: 'file::memory:' }),
  });

  it('allows only one competing file-backed conditionalBatch caller to win', async () => {
    const first = createFileBackedTursoStorage('turso-cas-contention');
    const second = new TursoStorage({ url: first.url });

    try {
      await first.storage.put('cas:counter', encode('start'));
      const condition = [{ key: 'cas:counter', expectedValue: encode('start') }];

      const [firstCommitted, secondCommitted] = await Promise.all([
        first.storage.conditionalBatch(condition, [
          { type: 'put', key: 'cas:counter', value: encode('first') },
        ]),
        second.conditionalBatch(condition, [
          { type: 'put', key: 'cas:counter', value: encode('second') },
        ]),
      ]);

      expect([firstCommitted, secondCommitted].filter(Boolean)).toHaveLength(1);
      expect(decode((await first.storage.get('cas:counter'))!)).toBe(
        firstCommitted ? 'first' : 'second',
      );
    } finally {
      second[Symbol.dispose]();
      first.cleanup();
    }
  });

  it('throws on SQLITE_BUSY contention instead of returning the precondition-mismatch false result', async () => {
    const fixture = createFileBackedTursoStorage('turso-busy-vs-cas');
    const locker = createClient({ url: fixture.url });

    try {
      await fixture.storage.put('cas:key', encode('current'));
      const preconditionMismatch = await fixture.storage.conditionalBatch(
        [{ key: 'cas:key', expectedValue: encode('stale') }],
        [{ type: 'put', key: 'cas:key', value: encode('incorrect') }],
      );
      expect(preconditionMismatch).toBe(false);

      const transaction = await locker.transaction('write');
      try {
        await transaction.execute({
          sql: SQLITE_UPSERT_VALUE_BY_KEY,
          args: ['lock:holder', encode('held')],
        });

        await expect(
          fixture.storage.conditionalBatch(
            [{ key: 'busy:key', expectedValue: null }],
            [{ type: 'put', key: 'busy:key', value: encode('committed') }],
          ),
        ).rejects.toThrow(/SQLITE_BUSY|busy|exhausted/i);
      } finally {
        await transaction.rollback().catch(() => {});
      }

      expect(await fixture.storage.get('busy:key')).toBeNull();
    } finally {
      locker.close();
      fixture.cleanup();
    }
  });

  it('initializes the key-value table before the first operation', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });

    await storage.put('init:key', encode('value'));

    const result = await storage.query<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kv'",
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.sql).toContain('WITHOUT ROWID');
    storage[Symbol.dispose]();
  });

  it('[Symbol.dispose] closes client', () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    storage[Symbol.dispose]();
    // After dispose, the underlying client is closed.
    expect(() => storage.get('key')).toThrow();
  });

  it('query returns results for raw SQL passthrough', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('q:1', encode('one'));
    await storage.put('q:2', encode('two'));
    await storage.put('q:3', encode('three'));

    const result = await storage.query<{ key: string }>('SELECT key FROM kv ORDER BY key');
    expect(result).toHaveLength(3);
    expect(result.map((row) => row.key)).toEqual(['q:1', 'q:2', 'q:3']);
    storage[Symbol.dispose]();
  });

  it('query with parameters', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('a', encode('1'));
    await storage.put('b', encode('2'));

    const result = await storage.query<{ key: string; value: Uint8Array }>(
      'SELECT key, value FROM kv WHERE key = ?',
      ['a'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe('a');
    storage[Symbol.dispose]();
  });

  it('query allows read-only PRAGMA statements', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });

    const result = await storage.query<{ journal_mode: string }>('PRAGMA journal_mode');

    expect(result).toHaveLength(1);
    expect(['wal', 'memory']).toContain(result[0]!.journal_mode);
    storage[Symbol.dispose]();
  });

  it('query rejects non-read-only SQL statements', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });

    await expect(storage.query('DELETE FROM kv')).rejects.toThrow(
      'Storage query only supports read-only SELECT and PRAGMA statements.',
    );

    storage[Symbol.dispose]();
  });

  it('query rejects multiple SQL statements', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });

    await expect(storage.query('SELECT key FROM kv; DELETE FROM kv')).rejects.toThrow(
      'Storage query must contain exactly one read-only statement.',
    );

    storage[Symbol.dispose]();
  });

  it('query rejects write PRAGMA statements', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });

    await expect(storage.query('PRAGMA journal_mode = WAL')).rejects.toThrow(
      'Storage query only supports read-only SELECT and PRAGMA statements.',
    );

    storage[Symbol.dispose]();
  });

  it('accepts authToken in configuration', () => {
    const storage = new TursoStorage({
      url: 'file::memory:',
      authToken: 'test-token',
    });
    // Should construct without error.
    storage[Symbol.dispose]();
  });
});
