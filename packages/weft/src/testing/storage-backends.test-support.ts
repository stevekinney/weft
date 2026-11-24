import 'fake-indexeddb/auto';

import {
  MemoryStorage,
  storageHas as storageHasFallback,
  storageKeys,
  type Storage,
} from "../embedded/storage/src/index.ts";
import { BunSQLiteStorage } from "../embedded/storage-bun-sqlite/src/index.ts";
import { IndexedDBStorage } from "../embedded/storage-indexeddb/src/index.ts";
import { sleepForTesting, yieldToEventLoop } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { awakeTurns } from "../../test-support/embedded/testing/src/wait-until.ts";
import type { Engine } from '../core/engine.ts';
import type { WorkflowStatus } from '../core/types.ts';

/**
 * A factory function that creates a fresh storage instance and returns
 * both the storage and a cleanup callback. The cleanup function disposes
 * of the storage and removes any temporary files (for disk-backed backends).
 */
export type StorageFactory = () => {
  storage: Storage;
  cleanup: () => void | Promise<void>;
};

/** Descriptor for a storage backend used in parametrized tests. */
export type StorageBackendDescriptor = {
  name: string;
  factory: StorageFactory;
};

/**
 * All storage backends available for parametrized integration tests.
 *
 * Each entry provides a human-readable name and a factory that creates
 * a fresh, isolated storage instance. When new backends are added to the
 * codebase, add an entry here and every parametrized test suite will
 * automatically cover them.
 */
export const storageBackends: StorageBackendDescriptor[] = [
  {
    name: 'MemoryStorage',
    factory: () => {
      const storage = new MemoryStorage();
      return {
        storage,
        cleanup: () => storage[Symbol.dispose](),
      };
    },
  },
  {
    name: 'BunSQLiteStorage',
    factory: () => {
      const storage = new BunSQLiteStorage(':memory:');
      return {
        storage,
        cleanup: () => storage[Symbol.dispose](),
      };
    },
  },
  {
    name: 'IndexedDBStorage',
    factory: () => {
      const databaseName = `weft-test-${crypto.randomUUID()}`;
      const storage = new IndexedDBStorage(databaseName);
      return {
        storage,
        cleanup: () => {
          storage[Symbol.dispose]();
          // Delete the database to keep fake-indexeddb state isolated across tests. The name is
          // always a string, and fake-indexeddb reports a failed deletion on the returned request
          // rather than by throwing, so there is no synchronous error to swallow here.
          indexedDB.deleteDatabase(databaseName);
        },
      };
    },
  },
];

/**
 * Collect all keys matching a prefix from a `Storage` instance.
 * Works with any backend (unlike MemoryStorage-specific `.keys()`).
 */
export async function collectKeys(storage: Storage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storageKeys(storage, prefix)) {
    keys.push(key);
  }
  return keys;
}

/**
 * Check whether a key exists in storage using only the `Storage` interface.
 * Works with any backend (unlike MemoryStorage-specific `.has()`).
 */
export async function storageHas(storage: Storage, key: string): Promise<boolean> {
  return storageHasFallback(storage, key);
}

/** Drain microtasks so fire-and-forget work completes. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await yieldToEventLoop();
  }
}

export async function waitForWorkflowStatus(
  engine: Engine,
  workflowId: string,
  status: WorkflowStatus,
  options: { hangGuardMilliseconds?: number } = {},
): Promise<void> {
  for await (const _turn of awakeTurns(options)) {
    const state = await engine.get(workflowId);
    if (state?.status === status) {
      return;
    }

    await sleepForTesting(1);
  }

  throw new Error(`Expected workflow "${workflowId}" to reach status "${status}"`);
}

/**
 * Dispose engine first, flush to let async work drain, then clean up storage.
 * This ordering prevents "client closed" errors from backends
 * where async operations may still reference storage after engine disposal.
 */
export async function teardown(
  engine?: Engine,
  storageCleanup?: () => void | Promise<void>,
): Promise<void> {
  engine?.[Symbol.dispose]();
  await flush();
  // Give backend cleanup one more event-loop turn so storage disposal does not race an engine
  // shutdown path that is still unwinding under heavy suite load.
  await flush();
  await storageCleanup?.();
}
