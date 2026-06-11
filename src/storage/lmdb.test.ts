import { afterEach, describe, expect, it } from 'bun:test';

import { createDiskBackedTestFixture } from '../testing/storage-backends.test-support.ts';
import { LMDBStorage } from './lmdb';
import {
  runBinaryAndLargeScanStorageConformance,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

runStorageCapabilityConformance('LMDBStorage', {
  create: () =>
    new LMDBStorage(createDiskBackedTestFixture({ prefix: 'lmdb-caps', recursive: true }).path),
  expected: {
    persistence: 'local',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: false,
  },
  // LMDB serializes writers (single write transaction); concurrent CAS contention
  // is not a supported access pattern, so skip that case. The mismatch case still runs.
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

describe('LMDBStorage', () => {
  const fixtureCleanups: Array<() => void> = [];

  function createStorage(): LMDBStorage {
    const fixture = createDiskBackedTestFixture({
      prefix: 'lmdb-test',
      recursive: true,
    });
    fixtureCleanups.push(fixture.cleanup);
    return new LMDBStorage(fixture.path);
  }

  runBinaryAndLargeScanStorageConformance('LMDBStorage', { create: createStorage });

  afterEach(() => {
    for (const cleanup of fixtureCleanups) {
      cleanup();
    }
    fixtureCleanups.length = 0;
  });

  it('get on empty storage returns null', async () => {
    const storage = createStorage();
    const result = await storage.get('nonexistent');
    expect(result).toBeNull();
    storage[Symbol.dispose]();
  });

  it('put then get returns same bytes', async () => {
    const storage = createStorage();
    const value = encode('hello');
    await storage.put('key', value);
    const result = await storage.get('key');
    expect(result).toEqual(value);
    storage[Symbol.dispose]();
  });

  it('put with same key overwrites previous value', async () => {
    const storage = createStorage();
    await storage.put('key', encode('first'));
    await storage.put('key', encode('second'));
    const result = await storage.get('key');
    expect(decode(result!)).toBe('second');
    storage[Symbol.dispose]();
  });

  it('delete removes key, subsequent get returns null', async () => {
    const storage = createStorage();
    await storage.put('key', encode('value'));
    await storage.delete('key');
    const result = await storage.get('key');
    expect(result).toBeNull();
    storage[Symbol.dispose]();
  });

  it('delete on nonexistent key is a no-op', async () => {
    const storage = createStorage();
    await storage.delete('nonexistent');
    const result = await storage.get('nonexistent');
    expect(result).toBeNull();
    storage[Symbol.dispose]();
  });

  it('scan with prefix returns only matching keys, sorted lexicographically', async () => {
    const storage = createStorage();
    await storage.put('wf:b', encode('b'));
    await storage.put('wf:a', encode('a'));
    await storage.put('wf:c', encode('c'));
    await storage.put('other:x', encode('x'));

    const entries = await collect(storage.scan('wf:'));
    expect(entries.map(([key]) => key)).toEqual(['wf:a', 'wf:b', 'wf:c']);
    storage[Symbol.dispose]();
  });

  it('scan with limit returns at most N entries', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const entries = await collect(storage.scan('p:', { limit: 2 }));
    expect(entries).toHaveLength(2);
    expect(entries.map(([key]) => key)).toEqual(['p:a', 'p:b']);
    storage[Symbol.dispose]();
  });

  it('scan with reverse returns in reverse order', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const entries = await collect(storage.scan('p:', { reverse: true }));
    expect(entries.map(([key]) => key)).toEqual(['p:c', 'p:b', 'p:a']);
    storage[Symbol.dispose]();
  });

  it('scan with gt/lt bounds', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const entries = await collect(storage.scan('p:', { gt: 'p:a', lt: 'p:d' }));
    expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('scan with gte/lte bounds', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const entries = await collect(storage.scan('p:', { gte: 'p:b', lte: 'p:c' }));
    expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('scan with empty prefix returns all keys', async () => {
    const storage = createStorage();
    await storage.put('alpha', encode('a'));
    await storage.put('beta', encode('b'));
    await storage.put('gamma', encode('c'));

    const entries = await collect(storage.scan(''));
    expect(entries.map(([key]) => key)).toEqual(['alpha', 'beta', 'gamma']);
    storage[Symbol.dispose]();
  });

  it('batch with multiple puts: all keys exist after', async () => {
    const storage = createStorage();
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
    const storage = createStorage();
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
    const storage = createStorage();
    await storage.put('key', encode('value'));
    await storage.batch([]);
    expect(await storage.get('key')).toEqual(encode('value'));
    storage[Symbol.dispose]();
  });

  it('conditionalBatch refreshes the read snapshot before the next read', async () => {
    const storage = createStorage();
    await storage.put('condition:match', encode('before'));

    expect(await storage.get('condition:match')).toEqual(encode('before'));

    const committed = await storage.conditionalBatch(
      [{ key: 'condition:match', expectedValue: encode('before') }],
      [{ type: 'put', key: 'condition:match', value: encode('after') }],
    );

    expect(committed).toBe(true);
    expect(await storage.get('condition:match')).toEqual(encode('after'));
    storage[Symbol.dispose]();
  });

  it('[Symbol.dispose] closes the environment', async () => {
    const storage = createStorage();
    storage[Symbol.dispose]();
    // After dispose, reads should throw because the environment is closed.
    await expect(storage.get('key')).rejects.toThrow('LMDBStorage is closed');
  });

  it('reads are synchronous zero-copy (get returns without awaiting disk)', async () => {
    const storage = createStorage();
    await storage.put('sync-key', encode('sync-value'));

    // Calling get returns a promise wrapping a synchronous LMDB read.
    // The value should be immediately available after the write is flushed.
    const result = await storage.get('sync-key');
    expect(decode(result!)).toBe('sync-value');
    storage[Symbol.dispose]();
  });

  it('refreshes the read snapshot after writes so immediate follow-up scans observe new keys', async () => {
    const storage = createStorage();

    expect(await storage.get('upd:wf-1:missing')).toBeNull();
    expect(await storage.has('upd:wf-1:missing')).toBe(false);
    expect(await collect(storage.scan('upd:'))).toEqual([]);

    await storage.put('upd:wf-1:first', encode('first'));
    expect(await storage.has('upd:wf-1:first')).toBe(true);
    const firstScanEntries = await collect(storage.scan('upd:'));
    expect(firstScanEntries.map(([key]) => key)).toEqual(['upd:wf-1:first']);

    await storage.batch([{ type: 'put', key: 'upd:wf-1:second', value: encode('second') }]);
    expect(await storage.has('upd:wf-1:second')).toBe(true);
    const secondScanEntries = await collect(storage.scan('upd:'));
    expect(secondScanEntries.map(([key]) => key)).toEqual(['upd:wf-1:first', 'upd:wf-1:second']);

    await storage.delete('upd:wf-1:first');
    expect(await storage.has('upd:wf-1:first')).toBe(false);
    const thirdScanEntries = await collect(storage.scan('upd:'));
    expect(thirdScanEntries.map(([key]) => key)).toEqual(['upd:wf-1:second']);

    storage[Symbol.dispose]();
  });

  it('writes are batched asynchronously (put returns a promise)', async () => {
    const storage = createStorage();

    // Issue multiple writes — they should all resolve without error.
    const writes = Array.from({ length: 100 }, (_, index) =>
      storage.put(`batch-key:${index}`, encode(`value-${index}`)),
    );
    await Promise.all(writes);

    // All values should be readable after the batch resolves.
    for (let index = 0; index < 100; index++) {
      const result = await storage.get(`batch-key:${index}`);
      expect(decode(result!)).toBe(`value-${index}`);
    }
    storage[Symbol.dispose]();
  });
});
