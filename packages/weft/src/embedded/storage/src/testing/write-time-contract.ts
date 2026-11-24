/**
 * The write-time contract a storage adapter that records when each key was last written must
 * satisfy, through its optional `stat` and `scanWithMetadata` methods.
 *
 * @module storage/testing/write-time-contract
 */

import { describe, expect, it } from 'bun:test';

import { storageScanWithMetadata, storageStat } from '../entry-metadata.ts';
import { type Storage, storageConditionalBatch } from '../interface.ts';
import { scopedStorage } from '../scoped-storage.ts';
import { bytes, collect, decodeText } from './storage-test-primitives.test-support.ts';

/**
 * Options for {@link runStorageWriteTimeContract}.
 *
 * @example
 * ```ts
 * import type { StorageWriteTimeContractOptions } from '@lostgradient/storage/testing';
 * import type { Storage } from '@lostgradient/storage';
 *
 * declare function openRecordingStorage(now: () => number): Storage;
 *
 * const options: StorageWriteTimeContractOptions = { create: openRecordingStorage };
 * void options;
 * ```
 */
export type StorageWriteTimeContractOptions = {
  /**
   * Construct a fresh, empty adapter that reads each write's time from `now`, in milliseconds
   * since the Unix epoch.
   */
  readonly create: (now: () => number) => Storage | Promise<Storage>;
};

/** A clock the contract moves by hand. */
function manualClock(start: number): { now: () => number; set(value: number): void } {
  let current = start;
  return {
    now: () => current,
    set(value) {
      current = value;
    },
  };
}

/**
 * Register the write-time contract: a put, a batch put and an applied conditional batch put stamp
 * the key with the clock's reading, an overwrite moves it, a delete removes it, a rejected
 * conditional batch leaves it, and a metadata scan and a scoped view report the same times as
 * `stat`.
 *
 * @example
 * ```ts
 * import { runStorageWriteTimeContract } from '@lostgradient/storage/testing';
 * import type { Storage } from '@lostgradient/storage';
 *
 * // An adapter that records write times reads them from the contract's clock.
 * declare function openRecordingStorage(now: () => number): Storage;
 *
 * runStorageWriteTimeContract('RecordingStorage', { create: openRecordingStorage });
 * ```
 */
export function runStorageWriteTimeContract(
  name: string,
  options: StorageWriteTimeContractOptions,
): void {
  const { create } = options;

  describe(`${name} write-time contract`, () => {
    it('stamps a put with the clock and answers null for an absent key', async () => {
      const clock = manualClock(1_000);
      using storage = await create(clock.now);
      expect(typeof storage.stat).toBe('function');
      expect(typeof storage.scanWithMetadata).toBe('function');

      await storage.put('memory:goals', bytes('a'));

      expect(await storageStat(storage, 'memory:goals')).toEqual({ updatedAt: 1_000 });
      expect(await storageStat(storage, 'memory:absent')).toBeNull();
    });

    it('moves the time on an overwrite and drops it with a delete', async () => {
      const clock = manualClock(1_000);
      using storage = await create(clock.now);
      await storage.put('log:server', bytes('first'));

      clock.set(2_500);
      await storage.put('log:server', bytes('second'));
      expect(await storageStat(storage, 'log:server')).toEqual({ updatedAt: 2_500 });

      await storage.delete('log:server');
      expect(await storageStat(storage, 'log:server')).toBeNull();
    });

    it('stamps every put of a batch with one reading and removes its deletes', async () => {
      const clock = manualClock(1_000);
      using storage = await create(clock.now);
      await storage.put('batch:gone', bytes('seed'));
      await storage.put('batch:kept', bytes('seed'));

      clock.set(3_000);
      await storage.batch([
        { type: 'put', key: 'batch:a', value: bytes('a') },
        { type: 'put', key: 'batch:b', value: bytes('b') },
        { type: 'delete', key: 'batch:gone' },
      ]);

      expect(await storageStat(storage, 'batch:a')).toEqual({ updatedAt: 3_000 });
      expect(await storageStat(storage, 'batch:b')).toEqual({ updatedAt: 3_000 });
      expect(await storageStat(storage, 'batch:kept')).toEqual({ updatedAt: 1_000 });
      expect(await storageStat(storage, 'batch:gone')).toBeNull();
    });

    it('stamps an applied conditional batch and leaves a rejected one alone', async () => {
      const clock = manualClock(1_000);
      using storage = await create(clock.now);
      await storage.put('cas:key', bytes('v1'));

      clock.set(4_000);
      const rejected = await storageConditionalBatch(
        storage,
        [{ key: 'cas:key', expectedValue: bytes('stale') }],
        [{ type: 'put', key: 'cas:key', value: bytes('mine') }],
      );
      expect(rejected).toBe(false);
      expect(await storageStat(storage, 'cas:key')).toEqual({ updatedAt: 1_000 });

      clock.set(5_000);
      const applied = await storageConditionalBatch(
        storage,
        [{ key: 'cas:key', expectedValue: bytes('v1') }],
        [{ type: 'put', key: 'cas:key', value: bytes('v2') }],
      );
      expect(applied).toBe(true);
      expect(await storageStat(storage, 'cas:key')).toEqual({ updatedAt: 5_000 });
    });

    it('reports each entry’s time in a metadata scan, honoring the scan options', async () => {
      const clock = manualClock(1_000);
      using storage = await create(clock.now);
      for (const [index, key] of ['p:a', 'p:b', 'p:c', 'p:d'].entries()) {
        clock.set(1_000 + index);
        await storage.put(key, bytes(key));
      }
      await storage.put('other:x', bytes('x'));

      const all = await collect(storageScanWithMetadata(storage, 'p:'));
      expect(all.map(([key, value, metadata]) => [key, decodeText(value), metadata])).toEqual([
        ['p:a', 'p:a', { updatedAt: 1_000 }],
        ['p:b', 'p:b', { updatedAt: 1_001 }],
        ['p:c', 'p:c', { updatedAt: 1_002 }],
        ['p:d', 'p:d', { updatedAt: 1_003 }],
      ]);

      const page = await collect(
        storageScanWithMetadata(storage, 'p:', { gt: 'p:a', limit: 2, reverse: true }),
      );
      expect(page.map(([key, , metadata]) => [key, metadata.updatedAt])).toEqual([
        ['p:d', 1_003],
        ['p:c', 1_002],
      ]);

      const one = await collect(
        storageScanWithMetadata(storage, '', { gte: 'p:b', lte: 'p:b', limit: 1 }),
      );
      expect(one.map(([key, , metadata]) => [key, metadata.updatedAt])).toEqual([['p:b', 1_001]]);
    });

    it('reports the same times through a scoped view, under the view’s keys', async () => {
      const clock = manualClock(7_000);
      using storage = await create(clock.now);
      const scoped = scopedStorage(storage, 'tenant');
      await scoped.put('memory:goals', bytes('g'));

      expect(await storageStat(scoped, 'memory:goals')).toEqual({ updatedAt: 7_000 });
      expect(await storageStat(storage, 'tenant:memory:goals')).toEqual({ updatedAt: 7_000 });
      const entries = await collect(storageScanWithMetadata(scoped, 'memory:'));
      expect(entries.map(([key, , metadata]) => [key, metadata.updatedAt])).toEqual([
        ['memory:goals', 7_000],
      ]);
    });
  });
}
