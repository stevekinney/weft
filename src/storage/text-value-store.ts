/**
 * Text-value compatibility wrapper.
 *
 * Adapts Weft's `Uint8Array`-keyed {@link Storage} to a generic
 * string-valued key/value interface with an array-returning prefix
 * list. The shape is what downstream consumers that expect a string
 * `KeyValueStore` typically require. The wrapper lives in Weft so
 * that adopting Weft storage does not require any runtime dependency
 * on those consumers.
 *
 * Encoding is UTF-8 with fatal decoding: invalid byte sequences raise
 * `TypeError` rather than silently producing replacement characters,
 * so a string consumer never sees corrupted data masquerading as
 * valid text.
 *
 * @module @lostgradient/weft/storage/text-value-store
 */
import {
  storageConditionalBatch,
  storageDeletePrefix,
  storageHas,
  storageKeys,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from './interface';

/**
 * Options for {@link textValueStore}.
 *
 * @example
 * ```ts
 * import { type TextValueStoreOptions } from '@lostgradient/weft/storage';
 *
 * const options: TextValueStoreOptions = {
 *   disposeUnderlyingStorage: false,
 * };
 * console.log(options.disposeUnderlyingStorage); // false
 * ```
 */
export type TextValueStoreOptions = {
  /**
   * Whether `close()` disposes the wrapped storage. Defaults to `true` so the
   * existing owning-wrapper behavior is preserved. Set `false` when the same
   * storage instance is shared by the Weft engine and application state.
   */
  disposeUnderlyingStorage?: boolean;
};

/**
 * Text compare-and-swap precondition used by
 * {@link ConditionalTextValueStore.conditionalBatch}.
 *
 * @example
 * ```ts
 * import { type TextValueStoreCondition } from '@lostgradient/weft/storage';
 *
 * const condition: TextValueStoreCondition = {
 *   key: 'api-key:1:last-used-at',
 *   expectedValue: '2026-06-01T00:00:00.000Z',
 * };
 * console.log(condition.key); // 'api-key:1:last-used-at'
 * ```
 */
export type TextValueStoreCondition = {
  /** Key whose current text value must match `expectedValue`. */
  key: string;
  /** Required current value, or `null` to require the key to be absent. */
  expectedValue: string | null;
};

/**
 * Text mutation applied by {@link ConditionalTextValueStore.conditionalBatch}.
 *
 * `set` and `put` are synonyms so callers can use the naming convention of
 * their string store while Weft still delegates to raw storage `put`.
 *
 * @example
 * ```ts
 * import { type TextValueStoreBatchOperation } from '@lostgradient/weft/storage';
 *
 * const operation: TextValueStoreBatchOperation = {
 *   type: 'set',
 *   key: 'session:1',
 *   value: 'active',
 * };
 * console.log(operation.type); // 'set'
 * ```
 */
export type TextValueStoreBatchOperation =
  | { type: 'set'; key: string; value: string }
  | { type: 'put'; key: string; value: string }
  | { type: 'delete'; key: string };

/**
 * String-valued key/value store layered on top of a Weft {@link Storage}.
 *
 * Matches the structural shape downstream consumers commonly require
 * from a string `KeyValueStore` backend: `get`/`set`/`delete` over
 * UTF-8 text, a `list(prefix)` that materializes keys into an array,
 * and `has`, `deletePrefix`, and `close` helpers. All members are
 * required — a conforming `TextValueStore` always provides them, so
 * consumers can call `has`/`deletePrefix` without an optional-chaining
 * fallback.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { textValueStore, type TextValueStore } from '@lostgradient/weft/storage/text-value-store';
 *
 * await using base = new MemoryStorage();
 * const store: TextValueStore = textValueStore(base);
 * await store.set('greeting', 'hello');
 * console.log(await store.get('greeting')); // 'hello'
 * ```
 */
export type TextValueStore = {
  /** Read the UTF-8 text stored at `key`, or `null` if absent. */
  get(key: string): Promise<string | null>;
  /** Write `value` as UTF-8 bytes at `key`. */
  set(key: string, value: string): Promise<void>;
  /** Delete `key`. No-op when absent. */
  delete(key: string): Promise<void>;
  /**
   * Materialize every key matching `prefix` into a stable array.
   * The array reflects the underlying storage's natural scan order.
   * For very large prefixes prefer streaming via the underlying
   * `Storage` directly.
   */
  list(prefix: string): Promise<string[]>;
  /** Check whether `key` exists. */
  has(key: string): Promise<boolean>;
  /** Delete every key under `prefix`. Returns the number deleted. */
  deletePrefix(prefix: string): Promise<number>;
  /** Close the wrapper, disposing the underlying storage unless configured otherwise. */
  close(): Promise<void>;
};

/**
 * Text store returned by {@link textValueStore}. It keeps the base
 * {@link TextValueStore} shape source-compatible for external implementations
 * while exposing compare-and-swap on Weft's wrapper.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft/storage';
 * import { type ConditionalTextValueStore, textValueStore } from '@lostgradient/weft/storage/text-value-store';
 *
 * await using storage = new MemoryStorage();
 * const store: ConditionalTextValueStore = textValueStore(storage);
 * const committed = await store.conditionalBatch(
 *   [{ key: 'session:1', expectedValue: null }],
 *   [{ type: 'set', key: 'session:1', value: 'open' }],
 * );
 * console.log(committed); // true
 * ```
 */
export type ConditionalTextValueStore = TextValueStore & {
  /** Apply a compare-and-swap batch over UTF-8 text values. */
  conditionalBatch(
    conditions: TextValueStoreCondition[],
    operations: TextValueStoreBatchOperation[],
  ): Promise<boolean>;
};

const textEncoder = new TextEncoder();
// Module-level singleton is safe: every `decode()` call uses `stream: false` (the
// default), so no internal buffer state persists between calls. If a caller ever
// needs streaming decode, construct a fresh `TextDecoder` per stream.
//
// `ignoreBOM: true` preserves a leading U+FEFF as data rather than silently
// stripping it. Without this flag, the default `ignoreBOM: false` makes
// `decode()` discard a leading BOM, so a string that starts with `﻿`
// loses that character on a set→get round-trip. Combined with `fatal: true`,
// the wrapper either round-trips bytes verbatim or raises `TypeError`.
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Wrap a Weft {@link Storage} so it satisfies the {@link TextValueStore}
 * shape. The wrapper holds no state of its own — every call delegates
 * to `storage` after UTF-8 encoding or decoding.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { textValueStore } from '@lostgradient/weft/storage/text-value-store';
 *
 * await using base = new MemoryStorage();
 * const store = textValueStore(base);
 * await store.set('greeting', 'hello 🌍');
 * console.log(await store.get('greeting')); // 'hello 🌍'
 * console.log(await store.list(''));         // ['greeting']
 * ```
 */
export function textValueStore(
  storage: Storage,
  options: TextValueStoreOptions = {},
): ConditionalTextValueStore {
  const disposeUnderlyingStorage = options.disposeUnderlyingStorage ?? true;

  const encodeCondition = (condition: TextValueStoreCondition): ConditionalBatchCondition => ({
    key: condition.key,
    expectedValue:
      condition.expectedValue === null ? null : textEncoder.encode(condition.expectedValue),
  });

  const encodeOperation = (operation: TextValueStoreBatchOperation): BatchOperation => {
    if (operation.type === 'delete') {
      return operation;
    }

    return {
      type: 'put',
      key: operation.key,
      value: textEncoder.encode(operation.value),
    };
  };

  return {
    async get(key: string): Promise<string | null> {
      const bytes = await storage.get(key);
      if (bytes === null) {
        return null;
      }
      return textDecoder.decode(bytes);
    },
    async set(key: string, value: string): Promise<void> {
      await storage.put(key, textEncoder.encode(value));
    },
    async delete(key: string): Promise<void> {
      await storage.delete(key);
    },
    async list(prefix: string): Promise<string[]> {
      const keys: string[] = [];
      for await (const key of storageKeys(storage, prefix)) {
        keys.push(key);
      }
      return keys;
    },
    async has(key: string): Promise<boolean> {
      return storageHas(storage, key);
    },
    async deletePrefix(prefix: string): Promise<number> {
      return storageDeletePrefix(storage, prefix);
    },
    async conditionalBatch(
      conditions: TextValueStoreCondition[],
      operations: TextValueStoreBatchOperation[],
    ): Promise<boolean> {
      return storageConditionalBatch(
        storage,
        conditions.map(encodeCondition),
        operations.map(encodeOperation),
      );
    },
    async close(): Promise<void> {
      if (!disposeUnderlyingStorage) {
        return;
      }
      // Weft `Storage extends Disposable`, so `Symbol.dispose` is synchronous by
      // contract. The `async` wrapper exists only so the wrapped surface returns
      // `Promise<void>` like the `KeyValueStore` shape expects. If a Weft backend
      // is ever promoted to `AsyncDisposable`, switch to awaiting `Symbol.asyncDispose`.
      storage[Symbol.dispose]();
    },
  };
}
