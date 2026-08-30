/**
 * Characterization tests for `LMDBStorage.scan` bounds behaviour.
 *
 * These tests pin the exact observable behaviour of the `scan` method's
 * gt/gte/lt/lte filtering, reverse iteration, limit, and prefix boundary
 * handling so that any refactor must keep byte-identical output.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { createDiskBackedTestFixture } from '../testing/storage-backends.test-support.ts';
import { LMDBStorage } from './lmdb';

/** Encode a string as Uint8Array. */
function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Collect all entries from an async iterable into an array. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) {
    results.push(item);
  }
  return results;
}

/** Collect only the keys from a scan. */
async function scanKeys(
  storage: LMDBStorage,
  prefix: string,
  options?: Parameters<LMDBStorage['scan']>[1],
): Promise<string[]> {
  const entries = await collect(storage.scan(prefix, options));
  return entries.map(([key]) => key);
}

describe('LMDBStorage.scan — bounds characterization', () => {
  const fixtureCleanups: Array<() => void> = [];

  function createStorage(): LMDBStorage {
    const fixture = createDiskBackedTestFixture({
      prefix: 'lmdb-scan-char-test',
      recursive: true,
    });
    fixtureCleanups.push(fixture.cleanup);
    return new LMDBStorage(fixture.path);
  }

  afterEach(() => {
    for (const cleanup of fixtureCleanups) {
      cleanup();
    }
    fixtureCleanups.length = 0;
  });

  it('empty prefix: returns all keys in lexicographic order', async () => {
    const storage = createStorage();
    await storage.put('alpha', encode('a'));
    await storage.put('beta', encode('b'));
    await storage.put('gamma', encode('c'));

    const keys = await scanKeys(storage, '');
    expect(keys).toEqual(['alpha', 'beta', 'gamma']);
    storage[Symbol.dispose]();
  });

  it('empty prefix with reverse: returns all keys in reverse order', async () => {
    const storage = createStorage();
    await storage.put('alpha', encode('a'));
    await storage.put('beta', encode('b'));
    await storage.put('gamma', encode('c'));

    const keys = await scanKeys(storage, '', { reverse: true });
    expect(keys).toEqual(['gamma', 'beta', 'alpha']);
    storage[Symbol.dispose]();
  });

  it('empty storage: scan yields nothing', async () => {
    const storage = createStorage();
    const keys = await scanKeys(storage, 'p:');
    expect(keys).toEqual([]);
    storage[Symbol.dispose]();
  });

  it('prefix with no matching keys: yields nothing', async () => {
    const storage = createStorage();
    await storage.put('other:a', encode('a'));
    await storage.put('other:b', encode('b'));

    const keys = await scanKeys(storage, 'p:');
    expect(keys).toEqual([]);
    storage[Symbol.dispose]();
  });

  it('key that is exactly the prefix-end boundary is excluded', async () => {
    // resolvePrefixRangeEnd('p:') returns 'p;' (charCode + 1).
    // A key equal to that boundary must not appear in scan('p:').
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p;', encode('boundary')); // exactly prefixEnd

    const keys = await scanKeys(storage, 'p:');
    expect(keys).toEqual(['p:a']);
    storage[Symbol.dispose]();
  });

  it('forward scan with gt: excludes key equal to bound', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const keys = await scanKeys(storage, 'p:', { gt: 'p:a' });
    expect(keys).toEqual(['p:b', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('forward scan with gt: excludes keys at and below bound', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const keys = await scanKeys(storage, 'p:', { gt: 'p:b' });
    expect(keys).toEqual(['p:c']);
    storage[Symbol.dispose]();
  });

  it('forward scan with gte: includes key equal to bound', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const keys = await scanKeys(storage, 'p:', { gte: 'p:b' });
    expect(keys).toEqual(['p:b', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('forward scan with lt: excludes key equal to bound', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const keys = await scanKeys(storage, 'p:', { lt: 'p:c' });
    expect(keys).toEqual(['p:a', 'p:b']);
    storage[Symbol.dispose]();
  });

  it('forward scan with lte: includes key equal to bound', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const keys = await scanKeys(storage, 'p:', { lte: 'p:b' });
    expect(keys).toEqual(['p:a', 'p:b']);
    storage[Symbol.dispose]();
  });

  it('forward scan with gt + lt: both bounds exclusive', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const keys = await scanKeys(storage, 'p:', { gt: 'p:a', lt: 'p:d' });
    expect(keys).toEqual(['p:b', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('forward scan with gte + lte: both bounds inclusive', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const keys = await scanKeys(storage, 'p:', { gte: 'p:b', lte: 'p:c' });
    expect(keys).toEqual(['p:b', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('forward scan with limit zero: yields nothing', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));

    const keys = await scanKeys(storage, 'p:', { limit: 0 });
    expect(keys).toEqual([]);
    storage[Symbol.dispose]();
  });

  it('forward scan with limit: yields at most N entries from the start', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const keys = await scanKeys(storage, 'p:', { limit: 2 });
    expect(keys).toEqual(['p:a', 'p:b']);
    storage[Symbol.dispose]();
  });

  it('reverse scan: returns keys in reverse lexicographic order', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const keys = await scanKeys(storage, 'p:', { reverse: true });
    expect(keys).toEqual(['p:c', 'p:b', 'p:a']);
    storage[Symbol.dispose]();
  });

  it('reverse scan with limit: yields at most N entries from the end', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const keys = await scanKeys(storage, 'p:', { reverse: true, limit: 2 });
    expect(keys).toEqual(['p:d', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('reverse scan with gt: excludes keys at and below the bound', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const keys = await scanKeys(storage, 'p:', { reverse: true, gt: 'p:b' });
    expect(keys).toEqual(['p:d', 'p:c']);
    storage[Symbol.dispose]();
  });

  it('reverse scan with lte: includes key equal to bound', async () => {
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const keys = await scanKeys(storage, 'p:', { reverse: true, lte: 'p:c' });
    expect(keys).toEqual(['p:c', 'p:b', 'p:a']);
    storage[Symbol.dispose]();
  });

  it('reverse scan past prefix does not bleed into adjacent prefix', async () => {
    // Keys just above the prefix boundary (e.g. 'p;') must not appear in reverse scan.
    const storage = createStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p;', encode('adjacent')); // starts at prefixEnd, not under 'p:'

    const keys = await scanKeys(storage, 'p:', { reverse: true });
    expect(keys).toEqual(['p:b', 'p:a']);
    storage[Symbol.dispose]();
  });

  it('scan values are fresh Uint8Array copies', async () => {
    const storage = createStorage();
    const original = encode('hello');
    await storage.put('p:a', original);

    const entries = await collect(storage.scan('p:'));
    expect(entries).toHaveLength(1);
    const [, value] = entries[0]!;

    // Mutating the returned value must not affect a subsequent read.
    value[0] = 0xff;
    const re = await storage.get('p:a');
    expect(re).toEqual(original);
    storage[Symbol.dispose]();
  });
});
