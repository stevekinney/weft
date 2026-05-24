/**
 * Shared test-only storage adapter fixtures used by the typed-storage and
 * scoped-storage suites. Both suites prove their wrappers behave correctly
 * against (a) a core-five adapter that omits every optional method (forcing the
 * derived fallbacks) and (b) a full adapter that forwards the optional surface
 * and tracks disposal. This module is the single source of truth for those
 * fixtures so the two suites stay in lockstep.
 *
 * Consumed via deep import and intentionally not re-exported from any package
 * entry point — it is test infrastructure, not part of the package surface. The
 * `.test-support.ts` suffix is excluded by `tsconfig.build.json` so this file
 * never ships in `dist/`.
 */

import type { Storage } from './interface.ts';
import { MemoryStorage } from './memory.ts';

/** Drain an async iterable into an array, preserving order. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

/**
 * A `Storage` exposing ONLY the required core-five operations
 * (get/put/delete/scan/batch) plus dispose, backed by a real `MemoryStorage`.
 * Used to prove wrappers degrade to derived fallbacks when optional methods are
 * absent.
 */
export function createCoreStorageAdapter(): Storage {
  const storage = new MemoryStorage();

  return {
    get: storage.get.bind(storage),
    put: storage.put.bind(storage),
    delete: storage.delete.bind(storage),
    scan: storage.scan.bind(storage),
    batch: storage.batch.bind(storage),
    [Symbol.dispose]: storage[Symbol.dispose].bind(storage),
  };
}

/** Handle returned by {@link createFullStorageAdapter}. */
export type FullStorageAdapter = {
  /** Storage exposing the full optional surface (has/deletePrefix/keys/count). */
  readonly storage: Storage;
  /** The underlying `MemoryStorage`, for asserting raw on-disk keys. */
  readonly inner: MemoryStorage;
  /** True once the adapter's `[Symbol.dispose]` ran. */
  wasDisposed: () => boolean;
};

/**
 * A full `Storage` adapter backed by a real `MemoryStorage` that forwards every
 * optional method and flips a disposal flag observable via `wasDisposed()`.
 */
export function createFullStorageAdapter(): FullStorageAdapter {
  const storage = new MemoryStorage();
  let disposed = false;

  return {
    storage: {
      get: storage.get.bind(storage),
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
      scan: storage.scan.bind(storage),
      batch: storage.batch.bind(storage),
      has: storage.has?.bind(storage),
      deletePrefix: storage.deletePrefix?.bind(storage),
      keys: storage.keys?.bind(storage),
      count: storage.count?.bind(storage),
      [Symbol.dispose]: () => {
        disposed = true;
        storage[Symbol.dispose]();
      },
    } satisfies Storage,
    inner: storage,
    wasDisposed: () => disposed,
  };
}
