/**
 * What a storage backend knows about a key beyond its value: today, when the key was last
 * written. A backend that records write times answers through the optional {@link Storage.stat}
 * and {@link Storage.scanWithMetadata}; every other backend answers "unknown" through the
 * {@link storageStat} and {@link storageScanWithMetadata} dispatchers, which callers use instead
 * of the optional methods.
 *
 * @module storage/entry-metadata
 */

import type { ScanOptions, Storage } from './interface.ts';

/**
 * What a backend knows about one stored key.
 *
 * @example
 * ```ts
 * import type { StorageEntryMetadata } from '@lostgradient/storage';
 *
 * const known: StorageEntryMetadata = { updatedAt: Date.UTC(2026, 10, 2, 16, 45) };
 * const unknown: StorageEntryMetadata = { updatedAt: null };
 * void known;
 * void unknown;
 * ```
 */
export interface StorageEntryMetadata {
  /**
   * When the key was last written (a put, or a put inside a batch or conditional batch), in
   * milliseconds since the Unix epoch, or `null` when the backend does not record write times or
   * the key was written before it began to.
   */
  readonly updatedAt: number | null;
}

/**
 * One entry of a metadata scan: the key, its value, and what the backend knows about it.
 *
 * @example
 * ```ts
 * import type { StorageScanEntryWithMetadata } from '@lostgradient/storage';
 *
 * const entry: StorageScanEntryWithMetadata = ['log:server', new Uint8Array([1]), { updatedAt: null }];
 * void entry;
 * ```
 */
export type StorageScanEntryWithMetadata = [string, Uint8Array, StorageEntryMetadata];

const UNKNOWN_METADATA: StorageEntryMetadata = Object.freeze({ updatedAt: null });

/**
 * Read what the backend knows about `key`: its metadata, or `null` when the key is absent. A
 * backend without {@link Storage.stat} answers `{ updatedAt: null }` for a present key.
 *
 * @example
 * ```ts
 * import { MemoryStorage, storageStat } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await storage.put('memory:goals', new Uint8Array([1]));
 * console.log(await storageStat(storage, 'memory:goals')); // { updatedAt: null }
 * console.log(await storageStat(storage, 'absent')); // null
 * ```
 */
export async function storageStat(
  storage: Pick<Storage, 'get' | 'has' | 'stat'>,
  key: string,
): Promise<StorageEntryMetadata | null> {
  if (storage.stat) {
    return storage.stat(key);
  }

  const present = storage.has ? await storage.has(key) : (await storage.get(key)) !== null;
  return present ? UNKNOWN_METADATA : null;
}

/**
 * Scan `prefix` as {@link Storage.scan} does, with each entry's metadata beside its value. A
 * backend without {@link Storage.scanWithMetadata} answers `{ updatedAt: null }` for every entry.
 *
 * @example
 * ```ts
 * import { MemoryStorage, storageScanWithMetadata } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await storage.put('memory:goals', new Uint8Array([1]));
 * for await (const [key, , metadata] of storageScanWithMetadata(storage, 'memory:')) {
 *   console.log(key, metadata.updatedAt); // 'memory:goals' null
 * }
 * ```
 */
export function storageScanWithMetadata(
  storage: Pick<Storage, 'scan' | 'scanWithMetadata'>,
  prefix: string,
  options?: ScanOptions,
): AsyncIterable<StorageScanEntryWithMetadata> {
  if (storage.scanWithMetadata) {
    return storage.scanWithMetadata(prefix, options);
  }

  return scanWithUnknownMetadata(storage, prefix, options);
}

async function* scanWithUnknownMetadata(
  storage: Pick<Storage, 'scan'>,
  prefix: string,
  options?: ScanOptions,
): AsyncIterable<StorageScanEntryWithMetadata> {
  for await (const [key, value] of storage.scan(prefix, options)) {
    yield [key, value, UNKNOWN_METADATA];
  }
}
