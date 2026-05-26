import { describe, expect, it } from 'bun:test';

import { createDiskBackedTestFixture } from '../testing/storage-backends.ts';
import { runStorageCapabilityConformance } from './storage-adapter.test-support.ts';
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
    readAfterWrite: 'session',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
  // Single libSQL connection serializes write transactions; concurrent CAS
  // contention is covered sequentially in conditional-batch.test.ts.
  supportsConcurrentWrites: false,
});

/** Helper to encode a string as Uint8Array. */
function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Helper to decode a Uint8Array to string. */
function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

/** Collect all entries from an async iterable into an array. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) {
    results.push(item);
  }
  return results;
}

describe('TursoStorage', () => {
  it('get on empty storage returns null', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    const result = await storage.get('nonexistent');
    expect(result).toBeNull();
    storage[Symbol.dispose]();
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

  it('put then get returns same bytes', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    const value = encode('hello');
    await storage.put('key', value);
    const result = await storage.get('key');
    expect(result).toEqual(value);
    storage[Symbol.dispose]();
  });

  it('put with same key overwrites previous value', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('key', encode('first'));
    await storage.put('key', encode('second'));
    const result = await storage.get('key');
    expect(decode(result!)).toBe('second');
    storage[Symbol.dispose]();
  });

  it('delete removes key, subsequent get returns null', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('key', encode('value'));
    await storage.delete('key');
    const result = await storage.get('key');
    expect(result).toBeNull();
    storage[Symbol.dispose]();
  });

  it('delete on nonexistent key is a no-op', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.delete('nonexistent');
    const result = await storage.get('nonexistent');
    expect(result).toBeNull();
    storage[Symbol.dispose]();
  });

  it('scan with prefix returns only matching keys, sorted lexicographically', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('wf:b', encode('b'));
    await storage.put('wf:a', encode('a'));
    await storage.put('wf:c', encode('c'));
    await storage.put('other:x', encode('x'));

    const entries = await collect(storage.scan('wf:'));
    expect(entries.map(([key]) => key)).toEqual(['wf:a', 'wf:b', 'wf:c']);
    storage[Symbol.dispose]();
  });

  it('scan with limit returns at most N entries', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const entries = await collect(storage.scan('p:', { limit: 2 }));
    expect(entries).toHaveLength(2);
    expect(entries.map(([key]) => key)).toEqual(['p:a', 'p:b']);
    storage[Symbol.dispose]();
  });

  it('scan with reverse returns in reverse order', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const entries = await collect(storage.scan('p:', { reverse: true }));
    expect(entries.map(([key]) => key)).toEqual(['p:c', 'p:b', 'p:a']);
    storage[Symbol.dispose]();
  });

  it('scan with gt/lt bounds', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const entries = await collect(storage.scan('p:', { gt: 'p:a', lt: 'p:d' }));
    expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('scan with gte/lte bounds', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const entries = await collect(storage.scan('p:', { gte: 'p:b', lte: 'p:c' }));
    expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('scan with empty prefix returns all keys', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('alpha', encode('a'));
    await storage.put('beta', encode('b'));
    await storage.put('gamma', encode('c'));

    const entries = await collect(storage.scan(''));
    expect(entries.map(([key]) => key)).toEqual(['alpha', 'beta', 'gamma']);
    storage[Symbol.dispose]();
  });

  it('batch with multiple puts: all keys exist after', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
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
    const storage = new TursoStorage({ url: 'file::memory:' });
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
    const storage = new TursoStorage({ url: 'file::memory:' });
    await storage.put('key', encode('value'));
    await storage.batch([]);
    expect(await storage.get('key')).toEqual(encode('value'));
    storage[Symbol.dispose]();
  });

  it('[Symbol.dispose] closes client', () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    storage[Symbol.dispose]();
    // After dispose, the underlying client is closed.
    expect(() => storage.get('key')).toThrow();
  });

  it('binary values round-trip correctly', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    const binaryData = new Uint8Array([0, 1, 127, 128, 255, 42, 0, 13, 10]);
    await storage.put('binary', binaryData);
    const result = await storage.get('binary');
    expect(result).toEqual(binaryData);
    storage[Symbol.dispose]();
  });

  it('large key count (1000 entries): scan returns all in correct order', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    const operations = Array.from({ length: 1000 }, (_, index) => ({
      type: 'put' as const,
      key: `item:${String(index).padStart(4, '0')}`,
      value: encode(String(index)),
    }));
    await storage.batch(operations);

    const entries = await collect(storage.scan('item:'));
    expect(entries).toHaveLength(1000);

    for (let index = 0; index < entries.length; index++) {
      expect(entries[index]![0]).toBe(`item:${String(index).padStart(4, '0')}`);
    }
    storage[Symbol.dispose]();
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
