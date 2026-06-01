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
import { storageDeletePrefix, storageHas, storageKeys, type Storage } from './interface';

/**
 * String-valued key/value store layered on top of a Weft {@link Storage}.
 *
 * Matches the structural shape downstream consumers commonly require
 * from a string `KeyValueStore` backend: `get`/`set`/`delete` over
 * UTF-8 text, a `list(prefix)` that materializes keys into an array,
 * and optional `has`, `deletePrefix`, and `close` helpers.
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
  /** Dispose the underlying storage. */
  close(): Promise<void>;
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
export function textValueStore(storage: Storage): TextValueStore {
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
    async close(): Promise<void> {
      // Weft `Storage extends Disposable`, so `Symbol.dispose` is synchronous by
      // contract. The `async` wrapper exists only so the wrapped surface returns
      // `Promise<void>` like the `KeyValueStore` shape expects. If a Weft backend
      // is ever promoted to `AsyncDisposable`, switch to awaiting `Symbol.asyncDispose`.
      storage[Symbol.dispose]();
    },
  };
}
