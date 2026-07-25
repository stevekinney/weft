import { afterEach, describe, expect, it } from 'bun:test';

import { createDiskBackedTestFixture } from '../testing/storage-backends.test-support.ts';
import { LMDBStorage } from './lmdb';
import {
  runBasicStorageContract,
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
  runBasicStorageContract('LMDBStorage', { create: createStorage });

  afterEach(() => {
    for (const cleanup of fixtureCleanups) {
      cleanup();
    }
    fixtureCleanups.length = 0;
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
