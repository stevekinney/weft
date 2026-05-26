import { describe, expect, it } from 'bun:test';

import {
  storageCountCore,
  storageDeletePrefixCore,
  storageHasCore,
  storageKeysCore,
} from './derived-operations.ts';
import type { ScanOptions, Storage } from './interface.ts';
import { MemoryStorage } from './memory.ts';

/**
 * A storage adapter that implements the required primitives via MemoryStorage
 * but whose optional fast-path methods all THROW. If a `*Core` helper ever
 * dispatches to an optional method instead of computing the result from
 * `get`/`scan`/`batch`, the throw surfaces as a test failure. This pins the
 * non-dispatching contract positively — a core-only fake (no optional methods)
 * could not, since there would be nothing to accidentally call.
 */
function createTrapStorage(): Storage {
  const storage = new MemoryStorage();

  return {
    capabilities: storage.capabilities.bind(storage),
    get: storage.get.bind(storage),
    put: storage.put.bind(storage),
    delete: storage.delete.bind(storage),
    scan: storage.scan.bind(storage),
    batch: storage.batch.bind(storage),
    has: () => {
      throw new Error('optional has() must not be called by a *Core helper');
    },
    keys: () => {
      throw new Error('optional keys() must not be called by a *Core helper');
    },
    count: () => {
      throw new Error('optional count() must not be called by a *Core helper');
    },
    deletePrefix: () => {
      throw new Error('optional deletePrefix() must not be called by a *Core helper');
    },
    [Symbol.dispose]: storage[Symbol.dispose].bind(storage),
  };
}

describe('derived-operations *Core helpers', () => {
  it('storageHasCore checks existence via get(), ignoring optional has()', async () => {
    const storage = createTrapStorage();
    await storage.put('jobs:1', new Uint8Array([1]));

    expect(await storageHasCore(storage, 'jobs:1')).toBe(true);
    expect(await storageHasCore(storage, 'jobs:missing')).toBe(false);
  });

  it('storageKeysCore projects scan() entries, ignoring optional keys()', async () => {
    const storage = createTrapStorage();
    await storage.put('jobs:1', new Uint8Array([1]));
    await storage.put('jobs:2', new Uint8Array([2]));
    await storage.put('logs:1', new Uint8Array([3]));

    expect(await Array.fromAsync(storageKeysCore(storage, 'jobs:'))).toEqual(['jobs:1', 'jobs:2']);
    expect(await Array.fromAsync(storageKeysCore(storage, 'missing:'))).toEqual([]);
  });

  it('storageKeysCore preserves scan ordering, reverse, and limit', async () => {
    const storage = createTrapStorage();
    for (const suffix of ['a', 'b', 'c', 'd']) {
      await storage.put(`jobs:${suffix}`, new Uint8Array([1]));
    }

    const reverseOptions: ScanOptions = { reverse: true };
    expect(await Array.fromAsync(storageKeysCore(storage, 'jobs:', reverseOptions))).toEqual([
      'jobs:d',
      'jobs:c',
      'jobs:b',
      'jobs:a',
    ]);

    const limitOptions: ScanOptions = { limit: 2 };
    expect(await Array.fromAsync(storageKeysCore(storage, 'jobs:', limitOptions))).toEqual([
      'jobs:a',
      'jobs:b',
    ]);
  });

  it('storageCountCore counts via scan(), ignoring optional count()', async () => {
    const storage = createTrapStorage();
    await storage.put('jobs:1', new Uint8Array([1]));
    await storage.put('jobs:2', new Uint8Array([2]));
    await storage.put('logs:1', new Uint8Array([3]));

    expect(await storageCountCore(storage, 'jobs:')).toBe(2);
    expect(await storageCountCore(storage, 'missing:')).toBe(0);
  });

  it('storageDeletePrefixCore batch-deletes matching keys, ignoring optional deletePrefix()', async () => {
    const storage = createTrapStorage();
    await storage.put('jobs:1', new Uint8Array([1]));
    await storage.put('jobs:2', new Uint8Array([2]));
    await storage.put('other:1', new Uint8Array([3]));

    expect(await storageDeletePrefixCore(storage, 'jobs:')).toBe(2);
    expect(await storage.get('jobs:1')).toBeNull();
    expect(await storage.get('jobs:2')).toBeNull();
    expect(await storage.get('other:1')).not.toBeNull();
  });

  it('storageDeletePrefixCore returns 0 and skips batch() when nothing matches', async () => {
    const storage = createTrapStorage();
    await storage.put('other:1', new Uint8Array([1]));

    expect(await storageDeletePrefixCore(storage, 'missing:')).toBe(0);
    expect(await storage.get('other:1')).not.toBeNull();
  });
});
