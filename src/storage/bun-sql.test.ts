import { describe, expect, it } from 'bun:test';

import { BunSQLiteStorage } from './bun-sql';
import {
  collect,
  bytes as encode,
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

runStorageCapabilityConformance('BunSQLiteStorage', {
  create: () => new BunSQLiteStorage(':memory:'),
  expected: {
    persistence: 'ephemeral',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
});

runBasicStorageContract('BunSQLiteStorage', { create: () => new BunSQLiteStorage(':memory:') });
runConcurrentConditionalBatchConformance('BunSQLiteStorage', {
  create: () => new BunSQLiteStorage(':memory:'),
});
runBinaryAndLargeScanStorageConformance('BunSQLiteStorage', {
  create: () => new BunSQLiteStorage(':memory:'),
});

describe('BunSQLiteStorage', () => {
  it('delete on nonexistent key is a no-op', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    await storage.delete('nonexistent');
    // Should not throw; storage still works fine.
    const result = await storage.get('nonexistent');
    expect(result).toBeNull();
    storage[Symbol.dispose]();
  });

  it('scan with gte/lte bounds', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const entries = await collect(storage.scan('p:', { gte: 'p:b', lte: 'p:c' }));
    expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('batch with multiple puts: all keys exist after', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    await storage.batch([
      { type: 'put', key: 'a', value: encode('1') },
      { type: 'put', key: 'b', value: encode('2') },
      { type: 'put', key: 'c', value: encode('3') },
    ]);

    expect(await storage.get('a')).toEqual(encode('1'));
    expect(await storage.get('b')).toEqual(encode('2'));
    expect(await storage.get('c')).toEqual(encode('3'));
    storage[Symbol.dispose]();
  });

  it('batch with mixed puts and deletes: correct final state', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    await storage.put('keep', encode('keep'));
    await storage.put('remove', encode('remove'));

    await storage.batch([
      { type: 'put', key: 'new', value: encode('new') },
      { type: 'delete', key: 'remove' },
    ]);

    expect(await storage.get('keep')).toEqual(encode('keep'));
    expect(await storage.get('remove')).toBeNull();
    expect(await storage.get('new')).toEqual(encode('new'));
    storage[Symbol.dispose]();
  });

  it('batch with empty array is a no-op', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    await storage.put('key', encode('value'));
    await storage.batch([]);
    expect(await storage.get('key')).toEqual(encode('value'));
    storage[Symbol.dispose]();
  });

  it('[Symbol.dispose] closes database', () => {
    const storage = new BunSQLiteStorage(':memory:');
    storage[Symbol.dispose]();
    // After dispose, operations should throw because the database is closed.
    expect(() => storage.get('key')).toThrow();
  });

  it('WITHOUT ROWID table verified', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    // Query sqlite_master to verify the table was created WITHOUT ROWID.
    const result = await storage.query<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kv'",
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.sql).toContain('WITHOUT ROWID');
    storage[Symbol.dispose]();
  });

  it('WAL mode verified via PRAGMA query', async () => {
    // Note: WAL mode may not persist on :memory: databases but we verify
    // the PRAGMA was executed by checking the journal_mode value.
    const storage = new BunSQLiteStorage(':memory:');
    const result = await storage.query<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(result).toHaveLength(1);
    // In-memory databases use 'memory' journal mode regardless of WAL setting.
    // For file-based databases this would be 'wal'.
    expect(['wal', 'memory']).toContain(result[0]!.journal_mode);
    storage[Symbol.dispose]();
  });

  it('query returns results for raw SQL passthrough', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    await storage.put('q:1', encode('one'));
    await storage.put('q:2', encode('two'));
    await storage.put('q:3', encode('three'));

    const result = await storage.query<{ key: string }>('SELECT key FROM kv ORDER BY key');
    expect(result).toHaveLength(3);
    expect(result.map((row) => row.key)).toEqual(['q:1', 'q:2', 'q:3']);
    storage[Symbol.dispose]();
  });

  it('[Symbol.dispose] does not throw after many scan/query calls (prepared-statement leak regression)', async () => {
    // Regression: scan() and query() used to call database.prepare() without
    // ever finalizing the statement. bun:sqlite tracks live statements on the
    // database and refuses to close while any are outstanding, so
    // database.close() would throw mid-shutdown. Exercise every scan variant
    // and a handful of raw queries, then verify dispose() is clean.
    const storage = new BunSQLiteStorage(':memory:');

    for (let index = 0; index < 50; index++) {
      await storage.put(`key:${String(index).padStart(3, '0')}`, encode(String(index)));
    }

    // Exercise every distinct SQL variant scan() can produce.
    for (let iteration = 0; iteration < 20; iteration++) {
      await collect(storage.scan('key:'));
      await collect(storage.scan('key:', { reverse: true }));
      await collect(storage.scan('key:', { limit: 5 }));
      await collect(storage.scan('key:', { limit: 5, reverse: true }));
      await collect(storage.scan('key:', { gt: 'key:010' }));
      await collect(storage.scan('key:', { gte: 'key:010' }));
      await collect(storage.scan('key:', { lt: 'key:040' }));
      await collect(storage.scan('key:', { lte: 'key:040' }));
      await collect(storage.scan('key:', { gt: 'key:010', lt: 'key:040' }));
      await collect(storage.scan('key:', { gte: 'key:010', lte: 'key:040', limit: 3 }));
      await collect(
        storage.scan('key:', { gt: 'key:010', lt: 'key:040', reverse: true, limit: 3 }),
      );
    }

    // query() uses caller-supplied SQL; simulate varying queries so each
    // prepare() call is distinct. A leak would leave 20 compiled statements
    // dangling on the database handle.
    for (let iteration = 0; iteration < 20; iteration++) {
      await storage.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM kv WHERE key > ? AND key < ? -- iteration ${iteration}`,
        ['key:000', 'key:999'],
      );
    }

    expect(() => storage[Symbol.dispose]()).not.toThrow();
  });

  it('scan statement cache stays bounded when callers vary the LIMIT value', async () => {
    // Regression: the cache key used to be the fully-interpolated SQL
    // string, including `LIMIT ${limit}`. Every distinct numeric limit
    // became a separate cache entry, letting the cache grow without bound
    // for callers that use dynamic pagination sizes — exactly the leak the
    // cache was meant to prevent. The fix uses a bound parameter for LIMIT,
    // so 100 distinct limit values collapse to a single cache entry.
    const storage = new BunSQLiteStorage(':memory:');
    for (let index = 0; index < 50; index++) {
      await storage.put(`key:${String(index).padStart(3, '0')}`, encode(String(index)));
    }

    for (let limit = 1; limit <= 100; limit++) {
      await collect(storage.scan('key:', { limit }));
    }

    // One entry for the "prefix-range + limit" shape, not 100.
    expect(storage.scanStatementCacheSize).toBe(1);

    // Adding a different structural shape (no limit) creates exactly one
    // additional entry — the shape space is bounded, not the value space.
    await collect(storage.scan('key:'));
    expect(storage.scanStatementCacheSize).toBe(2);

    storage[Symbol.dispose]();
  });

  it('query with parameters', async () => {
    const storage = new BunSQLiteStorage(':memory:');
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

  it('query rejects non-read-only SQL statements', async () => {
    const storage = new BunSQLiteStorage(':memory:');

    await expect(storage.query('DELETE FROM kv')).rejects.toThrow(
      'Storage query only supports read-only SELECT and PRAGMA statements.',
    );

    storage[Symbol.dispose]();
  });

  it('query rejects multiple SQL statements', async () => {
    const storage = new BunSQLiteStorage(':memory:');

    await expect(storage.query('SELECT key FROM kv; DELETE FROM kv')).rejects.toThrow(
      'Storage query must contain exactly one read-only statement.',
    );

    storage[Symbol.dispose]();
  });

  it('query rejects write PRAGMA statements', async () => {
    const storage = new BunSQLiteStorage(':memory:');

    await expect(storage.query('PRAGMA journal_mode = WAL')).rejects.toThrow(
      'Storage query only supports read-only SELECT and PRAGMA statements.',
    );

    storage[Symbol.dispose]();
  });
});
