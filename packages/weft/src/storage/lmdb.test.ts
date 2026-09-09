import { afterEach, describe, expect, it } from 'bun:test';
import * as lmdb from 'lmdb';

import { createDiskBackedTestFixture } from '../testing/storage-backends.test-support.ts';
import { LMDBStorage } from './lmdb';
import {
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

/**
 * Wraps the real `lmdb.open` so a test can assert what options a
 * `LMDBStorage` constructed it with, while still delegating to the real LMDB
 * environment for actual reads/writes. `LMDBStorage`'s third constructor
 * parameter is an undocumented test-only seam—`mock.module('lmdb', ...)` is
 * process-wide and irreversible under Bun (see `node-sqlite-loader.ts`), so
 * this avoids mocking the module entirely.
 */
function createCapturingOpen(): {
  open: typeof lmdb.open;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const open = ((options: Record<string, unknown>) => {
    calls.push(options);
    return lmdb.open(options as never);
  }) as typeof lmdb.open;
  return { open, calls };
}

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

  it('relaxed durability opens with noSync and noMetaSync, and still round-trips a batch write', async () => {
    const fixture = createDiskBackedTestFixture({ prefix: 'lmdb-relaxed', recursive: true });
    fixtureCleanups.push(fixture.cleanup);
    const { open, calls } = createCapturingOpen();

    const storage = new LMDBStorage(fixture.path, { durability: 'relaxed' }, open);

    await storage.batch([{ type: 'put', key: 'relaxed:key', value: encode('relaxed-value') }]);
    expect(await storage.get('relaxed:key')).toEqual(encode('relaxed-value'));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: fixture.path, noSync: true, noMetaSync: true });

    storage[Symbol.dispose]();
  });

  it('opens with full sync when no durability option is given (neither flag set)', () => {
    const fixture = createDiskBackedTestFixture({ prefix: 'lmdb-full', recursive: true });
    fixtureCleanups.push(fixture.cleanup);
    const { open, calls } = createCapturingOpen();

    const storage = new LMDBStorage(fixture.path, undefined, open);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.['noSync']).toBeUndefined();
    expect(call?.['noMetaSync']).toBeUndefined();

    storage[Symbol.dispose]();
  });

  it('rejects a durability value that is not "full" or "relaxed"', () => {
    expect(() => new LMDBStorage('unused-path', { durability: 'eventual' as never })).toThrow(
      'LMDBStorage durability must be "full" or "relaxed", received "eventual".',
    );
  });
});
