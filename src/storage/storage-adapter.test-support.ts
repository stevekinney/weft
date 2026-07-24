/**
 * Shared test-only storage adapter fixtures used by the typed-storage and
 * scoped-storage suites. Both suites prove their wrappers behave correctly
 * against (a) a core-five adapter that omits every optional method (forcing the
 * derived fallbacks) and (b) a full adapter that forwards the optional surface
 * and tracks disposal. This module is the single source of truth for those
 * fixtures so the two suites stay in lockstep.
 *
 * The storage conformance runners are public through
 * `@lostgradient/weft/storage/testing`; this module keeps the additional
 * adapter fixtures internal. The `.test-support.ts` suffix is excluded by
 * `tsconfig.build.json` so those fixtures never ship in `dist/`.
 */

import type { Storage, StorageCapabilities } from './interface.ts';
import { MemoryStorage } from './memory.ts';
export {
  assertCapabilitiesShape,
  bytes,
  collect,
  decodeText,
} from './storage-test-primitives.test-support.ts';
export {
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from './testing.ts';
export type {
  BasicStorageContractOptions,
  BinaryAndLargeScanConformanceOptions,
  CapabilityConformanceOptions,
  ConcurrentConditionalBatchConformanceOptions,
} from './testing.ts';

/**
 * A `linearizable`/`snapshot` capability profile with every boolean enabled —
 * the shape a single-process, fully-featured adapter (like `MemoryStorage`)
 * reports. Test doubles that delegate to a real backend can reuse this.
 */
export function fullStorageCapabilities(): StorageCapabilities {
  return {
    persistence: 'ephemeral',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  };
}

/**
 * A conservative capability profile for a minimal adapter that omits the
 * optional surface: no compare-and-swap and no bounded range delete. Used by
 * {@link createCoreStorageAdapter} so it doubles as the gate-failure fixture.
 */
export function coreStorageCapabilities(): StorageCapabilities {
  return {
    persistence: 'ephemeral',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: false,
    boundedRangeDelete: false,
  };
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
    capabilities: coreStorageCapabilities,
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
  /** Storage exposing every optional method available on `MemoryStorage`. */
  readonly storage: Storage;
  /** The underlying `MemoryStorage`, for asserting raw on-disk keys. */
  readonly inner: MemoryStorage;
  /** True once the adapter's `[Symbol.dispose]` ran. */
  readonly wasDisposed: () => boolean;
};

/**
 * A full `Storage` adapter backed by a real `MemoryStorage` that forwards every
 * optional method available on that backend and flips a disposal flag observable
 * via `wasDisposed()`.
 */
export function createFullStorageAdapter(): FullStorageAdapter {
  const storage = new MemoryStorage();
  let disposed = false;

  return {
    storage: {
      capabilities: storage.capabilities.bind(storage),
      get: storage.get.bind(storage),
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
      scan: storage.scan.bind(storage),
      batch: storage.batch.bind(storage),
      conditionalBatch: storage.conditionalBatch.bind(storage),
      has: storage.has?.bind(storage),
      deletePrefix: storage.deletePrefix?.bind(storage),
      deleteRange: storage.deleteRange?.bind(storage),
      keys: storage.keys?.bind(storage),
      count: storage.count?.bind(storage),
      scoped: storage.scoped?.bind(storage),
      [Symbol.dispose]: () => {
        disposed = true;
        storage[Symbol.dispose]();
      },
    } satisfies Storage,
    inner: storage,
    wasDisposed: () => disposed,
  };
}
