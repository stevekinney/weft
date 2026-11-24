import { type StorageCapabilities } from './capabilities.ts';
import {
  normalizeDeleteRangeOptions,
  storageDeleteRange,
  type DeleteRangeOptions,
} from './delete-range.ts';
import {
  storageScanWithMetadata,
  storageStat,
  type StorageEntryMetadata,
  type StorageScanEntryWithMetadata,
} from './entry-metadata.ts';
import {
  assertStorageBatchOperationCount,
  storageConditionalBatch,
  storageCount,
  storageDeletePrefix,
  storageHas,
  storageKeys,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
} from './interface.ts';

type RangeOptions = Pick<ScanOptions, 'limit' | 'gt' | 'gte' | 'lt' | 'lte'>;

function normalizeScopePrefix(prefix: string): string {
  return prefix.replaceAll(/:+$/g, '');
}

function joinScopePrefixes(leftPrefix: string, rightPrefix: string): string {
  const normalizedLeftPrefix = normalizeScopePrefix(leftPrefix);
  const normalizedRightPrefix = normalizeScopePrefix(rightPrefix);

  if (normalizedLeftPrefix.length === 0) {
    return normalizedRightPrefix;
  }

  if (normalizedRightPrefix.length === 0) {
    return normalizedLeftPrefix;
  }

  return `${normalizedLeftPrefix}:${normalizedRightPrefix}`;
}

/**
 * {@link Storage} decorator that transparently prefixes all keys with a
 * namespace, isolating a logical partition of a shared backing store.
 *
 * Reads and writes pass through to the underlying storage with the scope prefix
 * prepended; keys returned by `scan` and `keys` are stripped back to their
 * unprefixed form.  Use {@link scopedStorage} to construct one without `new`.
 *
 * @example
 * ```ts
 * import { MemoryStorage, ScopedStorage } from '@lostgradient/storage';
 *
 * await using raw = new MemoryStorage();
 * const scopeA = new ScopedStorage(raw, 'scope:a');
 * const scopeB = new ScopedStorage(raw, 'scope:b');
 *
 * await scopeA.put('setting', new TextEncoder().encode('dark'));
 * await scopeB.put('setting', new TextEncoder().encode('light'));
 *
 * // Keys are isolated — scopeA cannot see scopeB's data
 * console.log(await scopeA.has('setting')); // true
 * console.log(await scopeB.get('setting')); // Uint8Array for 'light'
 * ```
 */
export class ScopedStorage implements Storage {
  #storage: Storage;
  #scopePrefix: string;

  constructor(storage: Storage, prefix: string) {
    this.#storage = storage;
    this.#scopePrefix = normalizeScopePrefix(prefix);
  }

  #toInnerKey(key: string): string {
    if (this.#scopePrefix.length === 0) {
      return key;
    }

    return key.length === 0 ? `${this.#scopePrefix}:` : `${this.#scopePrefix}:${key}`;
  }

  #toInnerOperations(operations: BatchOperation[]): BatchOperation[] {
    return operations.map((operation) => {
      if (operation.type === 'put') {
        return {
          type: 'put',
          key: this.#toInnerKey(operation.key),
          value: operation.value,
        };
      }

      return {
        type: 'delete',
        key: this.#toInnerKey(operation.key),
      };
    });
  }

  #toPublicKey(key: string): string {
    if (this.#scopePrefix.length === 0) {
      return key;
    }

    return key.slice(this.#scopePrefix.length + 1);
  }

  #toInnerRangeOptions(options: RangeOptions): RangeOptions {
    const innerOptions: RangeOptions = {};

    if (options.limit !== undefined) innerOptions.limit = options.limit;
    if (options.gt !== undefined) innerOptions.gt = this.#toInnerKey(options.gt);
    if (options.gte !== undefined) innerOptions.gte = this.#toInnerKey(options.gte);
    if (options.lt !== undefined) innerOptions.lt = this.#toInnerKey(options.lt);
    if (options.lte !== undefined) innerOptions.lte = this.#toInnerKey(options.lte);

    return innerOptions;
  }

  #toInnerOptions(options: ScanOptions = {}): ScanOptions {
    const innerOptions: ScanOptions = this.#toInnerRangeOptions(options);
    if (options.reverse !== undefined) innerOptions.reverse = options.reverse;
    return innerOptions;
  }

  #toInnerDeleteRangeOptions(options: DeleteRangeOptions): DeleteRangeOptions {
    return this.#toInnerRangeOptions(options);
  }

  capabilities(): StorageCapabilities {
    // Pure key-rewriting pass-through: every consistency and feature guarantee
    // is exactly the inner store's. Delegate verbatim.
    return this.#storage.capabilities();
  }

  scoped(prefix: string): ScopedStorage {
    return new ScopedStorage(this.#storage, joinScopePrefixes(this.#scopePrefix, prefix));
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.#storage.get(this.#toInnerKey(key));
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.#storage.put(this.#toInnerKey(key), value);
  }

  async delete(key: string): Promise<void> {
    await this.#storage.delete(this.#toInnerKey(key));
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    for await (const [key, value] of this.#storage.scan(
      this.#toInnerKey(prefix),
      this.#toInnerOptions(options),
    )) {
      yield [this.#toPublicKey(key), value];
    }
  }

  /** What the inner store knows about the scoped `key`; "unknown" when it records no write times. */
  async stat(key: string): Promise<StorageEntryMetadata | null> {
    return storageStat(this.#storage, this.#toInnerKey(key));
  }

  /** {@link ScopedStorage.scan} with each entry's metadata from the inner store. */
  async *scanWithMetadata(
    prefix: string,
    options?: ScanOptions,
  ): AsyncIterable<StorageScanEntryWithMetadata> {
    for await (const [key, value, metadata] of storageScanWithMetadata(
      this.#storage,
      this.#toInnerKey(prefix),
      this.#toInnerOptions(options),
    )) {
      yield [this.#toPublicKey(key), value, metadata];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    await this.#storage.batch(this.#toInnerOperations(operations));
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    return storageConditionalBatch(
      this.#storage,
      conditions.map((condition) => ({
        key: this.#toInnerKey(condition.key),
        expectedValue: condition.expectedValue,
      })),
      this.#toInnerOperations(operations),
    );
  }

  async has(key: string): Promise<boolean> {
    return storageHas(this.#storage, this.#toInnerKey(key));
  }

  async deletePrefix(prefix: string): Promise<number> {
    return storageDeletePrefix(this.#storage, this.#toInnerKey(prefix));
  }

  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    // Normalize first (validates, drops reverse), then translate bound keys into
    // the inner namespace. Translating an already-normalized object guarantees a
    // future refactor cannot smuggle `reverse` into the inner delete.
    const inner = this.#toInnerDeleteRangeOptions(normalizeDeleteRangeOptions(options));
    return storageDeleteRange(this.#storage, this.#toInnerKey(prefix), inner);
  }

  async *keys(prefix: string, options?: ScanOptions): AsyncIterable<string> {
    for await (const key of storageKeys(
      this.#storage,
      this.#toInnerKey(prefix),
      this.#toInnerOptions(options),
    )) {
      yield this.#toPublicKey(key);
    }
  }

  async count(prefix: string): Promise<number> {
    return storageCount(this.#storage, this.#toInnerKey(prefix));
  }

  [Symbol.dispose](): void {
    this.#storage[Symbol.dispose]();
  }
}

/**
 * Factory that creates a {@link ScopedStorage} view of `storage` under the
 * given `prefix`.
 *
 * This is an ergonomic alternative to `new ScopedStorage(...)`: it avoids
 * `new` at call sites and reads naturally when storage is being decorated
 * inline. The return type and behavior are identical to constructing
 * `ScopedStorage` directly.
 *
 * @example
 * ```ts
 * import { MemoryStorage, scopedStorage } from '@lostgradient/storage';
 *
 * await using raw = new MemoryStorage();
 *
 * // Give each consumer its own key namespace in the same backing store
 * const scoped = scopedStorage(raw, 'eng:v1');
 * await scoped.put('state', new Uint8Array([1]));
 * console.log(await raw.get('eng:v1:state')); // Uint8Array [ 1 ]
 * ```
 */
export function scopedStorage(storage: Storage, prefix: string): ScopedStorage {
  return new ScopedStorage(storage, prefix);
}
