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
 * import { CompressedStorage } from 'weft/storage/compressed'; // requires node:zlib / Bun
 * import { SQLiteStorage }     from 'weft/storage/sqlite';     // Bun or Node SQLite
 * import { LMDBStorage }       from 'weft/storage/lmdb';       // peer: lmdb
 * import { TursoStorage }      from 'weft/storage/turso';      // peer: @libsql/client
 * import { IndexedDBStorage }  from 'weft/storage/indexeddb';  // browser-only
 * import { WebExtensionStorage } from 'weft/storage/web-extension'; // extension-only
 * import { HTTPStorage }       from 'weft/storage/http';       // remote storage
 * ```
 *
 * @module weft/storage
 */
import {
  KEYS,
  requireStorageCapability,
  storageConditionalBatch,
  storageValuesEqual,
} from './interface';
import { MemoryStorage } from './memory';
import { resolveStorage } from './resolve';
import { ScopedStorage, scopedStorage } from './scoped-storage';
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
 * import { jsonCodec } from 'weft/storage';
 * const codec = jsonCodec();
 * void codec;
 * ```
 */
const exportedJsonCodec = jsonCodec;

/**
 * Re-exported {@link KEYS}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { workflow, KEYS } from 'weft/storage';
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
 * import { MemoryStorage } from 'weft/storage';
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
 * import { msgpackCodec } from 'weft/storage';
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
 * import { resolveStorage } from 'weft/storage';
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
 * import { MemoryStorage, ScopedStorage } from 'weft/storage';
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
 * import { MemoryStorage, scopedStorage } from 'weft/storage';
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
 * import { MemoryStorage, storageConditionalBatch } from 'weft/storage';
 * await using storage = new MemoryStorage();
 * await storageConditionalBatch(storage, [], []);
 * ```
 */
const exportedStorageConditionalBatch = storageConditionalBatch;

/**
 * Re-exported {@link requireStorageCapability}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { MemoryStorage, requireStorageCapability } from 'weft/storage';
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
 * import { storageValuesEqual } from 'weft/storage';
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
 * import { MemoryStorage, textValueStore } from 'weft/storage';
 * await using base = new MemoryStorage();
 * const store = textValueStore(base);
 * void store;
 * ```
 */
const exportedTextValueStore = textValueStore;

/**
 * Re-exported {@link withCodec}. See the original declaration for full docs.
 *
 * @example
 * ```ts
 * import { jsonCodec, MemoryStorage, withCodec } from 'weft/storage';
 * await using base = new MemoryStorage();
 * const typed = withCodec(base, jsonCodec());
 * void typed;
 * ```
 */
const exportedWithCodec = withCodec;

export type { JSONValue } from '../core/json.ts';
export type {
  BatchOperation,
  ConditionalBatchCondition,
  GatedStorageCapabilityKey,
  ScanOptions,
  Storage,
  StorageCapabilities,
} from './interface';
export type { StorageConfiguration } from './resolve';
export type { TextValueStore } from './text-value-store';
export type {
  MessagePackValue,
  StorageCodec,
  StorageValueParser,
  TypedBatchOperation,
  TypedStorage,
} from './typed-storage';
export {
  exportedJsonCodec as jsonCodec,
  exportedKeys as KEYS,
  exportedMemoryStorage as MemoryStorage,
  exportedMsgpackCodec as msgpackCodec,
  exportedRequireStorageCapability as requireStorageCapability,
  exportedResolveStorage as resolveStorage,
  exportedScopedStorage as ScopedStorage,
  exportedScopedStorageFactory as scopedStorage,
  exportedStorageConditionalBatch as storageConditionalBatch,
  exportedStorageValuesEqual as storageValuesEqual,
  exportedTextValueStore as textValueStore,
  exportedWithCodec as withCodec,
};
