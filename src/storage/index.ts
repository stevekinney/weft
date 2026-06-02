/**
 * Storage submodule — zero-native-dependency entry point.
 *
 * Exports the `Storage` interface, `KEYS` key-encoding helpers,
 * and `MemoryStorage`. These have no native dependencies and are
 * safe to import in any environment including browsers.
 *
 * For backends or wrappers that have runtime dependencies, use the
 * per-backend subpaths:
 *
 * ```ts
 * import { CompressedStorage } from '@lostgradient/weft/storage/compressed'; // requires node:zlib / Bun
 * import { SQLiteStorage }     from '@lostgradient/weft/storage/sqlite';     // Bun or Node SQLite
 * import { LMDBStorage }       from '@lostgradient/weft/storage/lmdb';       // peer: lmdb
 * import { TursoStorage }      from '@lostgradient/weft/storage/turso';      // peer: @libsql/client
 * import { IndexedDBStorage }  from '@lostgradient/weft/storage/indexeddb';  // browser-only
 * import { WebExtensionStorage } from '@lostgradient/weft/storage/web-extension'; // extension-only
 * import { HTTPStorage }       from '@lostgradient/weft/storage/http';       // remote storage
 * ```
 *
 * @module @lostgradient/weft/storage
 */
import { storageDeleteRange } from './delete-range';
import {
  assertDurableStorageForRecovery,
  KEYS,
  requireStorageCapability,
  storageConditionalBatch,
  storageValuesEqual,
  WEFT_RESERVED_KEY_PREFIXES,
} from './interface';
import { MemoryStorage } from './memory';
import { resolveStorage } from './resolve';
import { ScopedStorage, scopedStorage } from './scoped-storage';
import { copyTextKeyValueRowsToStorage } from './text-value-import';
import { textValueStore } from './text-value-store';
import { jsonCodec, msgpackCodec, withCodec } from './typed-storage';

// Bun 1.3.13 minifier workaround: pure re-export barrels
// (`export { X } from './m'`) emit invalid JavaScript with undeclared
// identifiers in `dist/`. Loading the bundle from Node throws
// `Export 'B' is not defined in module`. Rebinding each value to a
// local const before re-exporting forces the bundler to keep the
// reference live. Mirrors the same workaround in `src/testing/index.ts`.
// Remove this workaround once Bun ships the fix and CI proves a clean
// build with direct re-exports.
/**
 * Re-exported {@link jsonCodec}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { jsonCodec } from '@lostgradient/weft/storage';
 * const codec = jsonCodec();
 * void codec;
 * ```
 */
const exportedJsonCodec = jsonCodec;

/**
 * Re-exported {@link assertDurableStorageForRecovery}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { assertDurableStorageForRecovery } from '@lostgradient/weft/storage';
 * import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';
 *
 * await using storage = new SQLiteStorage('./weft.db');
 * assertDurableStorageForRecovery(storage);
 * ```
 */
const exportedAssertDurableStorageForRecovery = assertDurableStorageForRecovery;

/**
 * Re-exported {@link copyTextKeyValueRowsToStorage}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { MemoryStorage, copyTextKeyValueRowsToStorage } from '@lostgradient/weft/storage';
 *
 * await using storage = new MemoryStorage();
 * const result = await copyTextKeyValueRowsToStorage({
 *   storage,
 *   rows: [{ key: 'session:1', value: 'active' }],
 *   targetPrefix: 'app:my-service',
 * });
 * void result;
 * ```
 */
const exportedCopyTextKeyValueRowsToStorage = copyTextKeyValueRowsToStorage;

/**
 * Re-exported {@link KEYS}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { KEYS } from '@lostgradient/weft/storage';
 * const key = KEYS.workflow('wf-1');
 * void key;
 * ```
 */
const exportedKeys = KEYS;

/**
 * Re-exported {@link MemoryStorage}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft/storage';
 * await using storage = new MemoryStorage();
 * void storage;
 * ```
 */
const exportedMemoryStorage = MemoryStorage;

/**
 * Re-exported {@link msgpackCodec}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { msgpackCodec } from '@lostgradient/weft/storage';
 * const codec = msgpackCodec();
 * void codec;
 * ```
 */
const exportedMsgpackCodec = msgpackCodec;

/**
 * Re-exported {@link resolveStorage}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { resolveStorage } from '@lostgradient/weft/storage';
 * const storage = await resolveStorage({ type: 'memory' });
 * void storage;
 * ```
 */
const exportedResolveStorage = resolveStorage;

/**
 * Re-exported {@link ScopedStorage}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { MemoryStorage, ScopedStorage } from '@lostgradient/weft/storage';
 * await using base = new MemoryStorage();
 * const scoped = new ScopedStorage(base, 'scope:');
 * void scoped;
 * ```
 */
const exportedScopedStorage = ScopedStorage;

/**
 * Re-exported {@link scopedStorage}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { MemoryStorage, scopedStorage } from '@lostgradient/weft/storage';
 * await using base = new MemoryStorage();
 * const scoped = scopedStorage(base, 'scope:');
 * void scoped;
 * ```
 */
const exportedScopedStorageFactory = scopedStorage;

/**
 * Re-exported {@link storageConditionalBatch}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { MemoryStorage, storageConditionalBatch } from '@lostgradient/weft/storage';
 * await using storage = new MemoryStorage();
 * await storageConditionalBatch(storage, [], []);
 * ```
 */
const exportedStorageConditionalBatch = storageConditionalBatch;

/**
 * Re-exported {@link storageDeleteRange}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { MemoryStorage, storageDeleteRange } from '@lostgradient/weft/storage';
 * await using storage = new MemoryStorage();
 * await storage.put('ev:wf:0000000001', new Uint8Array([1]));
 * const deleted = await storageDeleteRange(storage, 'ev:wf:', { lte: 'ev:wf:0000000001' });
 * void deleted;
 * ```
 */
const exportedStorageDeleteRange = storageDeleteRange;

/**
 * Re-exported {@link requireStorageCapability}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { MemoryStorage, requireStorageCapability } from '@lostgradient/weft/storage';
 * await using storage = new MemoryStorage();
 * requireStorageCapability(storage, 'conditionalBatch', 'compare-and-swap');
 * ```
 */
const exportedRequireStorageCapability = requireStorageCapability;

/**
 * Re-exported {@link storageValuesEqual}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { storageValuesEqual } from '@lostgradient/weft/storage';
 * const equal = storageValuesEqual(new Uint8Array([1]), new Uint8Array([1]));
 * void equal;
 * ```
 */
const exportedStorageValuesEqual = storageValuesEqual;

/**
 * Re-exported {@link textValueStore}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
 * await using base = new MemoryStorage();
 * const store = textValueStore(base);
 * void store;
 * ```
 */
const exportedTextValueStore = textValueStore;

/**
 * Re-exported {@link WEFT_RESERVED_KEY_PREFIXES}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { WEFT_RESERVED_KEY_PREFIXES } from '@lostgradient/weft/storage';
 *
 * const key = 'wf:order-123';
 * const isWeftKey = WEFT_RESERVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
 * void isWeftKey;
 * ```
 */
const exportedWeftReservedKeyPrefixes = WEFT_RESERVED_KEY_PREFIXES;

/**
 * Re-exported {@link withCodec}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { jsonCodec, MemoryStorage, withCodec } from '@lostgradient/weft/storage';
 * await using base = new MemoryStorage();
 * const typed = withCodec(base, jsonCodec());
 * void typed;
 * ```
 */
const exportedWithCodec = withCodec;

export type { JSONValue } from '../core/json.ts';
export type { DeleteRangeOptions } from './delete-range';
export type {
  BatchOperation,
  ConditionalBatchCondition,
  GatedStorageCapabilityKey,
  ScanOptions,
  Storage,
  StorageCapabilities,
} from './interface';
export type { StorageConfiguration } from './resolve';
export type {
  CopyTextKeyValueRowsToStorageOptions,
  CopyTextKeyValueRowsToStorageResult,
  TextKeyValueRow,
} from './text-value-import';
export type {
  TextValueStore,
  TextValueStoreBatchOperation,
  TextValueStoreCondition,
  TextValueStoreOptions,
} from './text-value-store';
export type {
  CodecStorageOptions,
  MessagePackValue,
  StorageCodec,
  StorageValueParser,
  TypedBatchOperation,
  TypedConditionalBatchCondition,
  TypedStorage,
} from './typed-storage';
export {
  exportedAssertDurableStorageForRecovery as assertDurableStorageForRecovery,
  exportedCopyTextKeyValueRowsToStorage as copyTextKeyValueRowsToStorage,
  exportedJsonCodec as jsonCodec,
  exportedKeys as KEYS,
  exportedMemoryStorage as MemoryStorage,
  exportedMsgpackCodec as msgpackCodec,
  exportedRequireStorageCapability as requireStorageCapability,
  exportedResolveStorage as resolveStorage,
  exportedScopedStorage as ScopedStorage,
  exportedScopedStorageFactory as scopedStorage,
  exportedStorageConditionalBatch as storageConditionalBatch,
  exportedStorageDeleteRange as storageDeleteRange,
  exportedStorageValuesEqual as storageValuesEqual,
  exportedTextValueStore as textValueStore,
  exportedWeftReservedKeyPrefixes as WEFT_RESERVED_KEY_PREFIXES,
  exportedWithCodec as withCodec,
};
