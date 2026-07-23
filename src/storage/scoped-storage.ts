import {
  normalizeDeleteRangeOptions,
  storageDeleteRange,
  type DeleteRangeOptions,
} from './delete-range.ts';
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
  type StorageCapabilities,
} from './interface.ts';

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
 * import { MemoryStorage, ScopedStorage } from '@lostgradient/weft';
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

  #toInnerOptions(options: ScanOptions = {}): ScanOptions {
    const innerOptions: ScanOptions = {};

    if (options.limit !== undefined) {
      innerOptions.limit = options.limit;
    }

    if (options.reverse !== undefined) {
      innerOptions.reverse = options.reverse;
    }

    if (options.gt !== undefined) {
      innerOptions.gt = this.#toInnerKey(options.gt);
    }

    if (options.gte !== undefined) {
      innerOptions.gte = this.#toInnerKey(options.gte);
    }

    if (options.lt !== undefined) {
      innerOptions.lt = this.#toInnerKey(options.lt);
    }

    if (options.lte !== undefined) {
      innerOptions.lte = this.#toInnerKey(options.lte);
    }

    return innerOptions;
  }

  #toInnerDeleteRangeOptions(options: DeleteRangeOptions): DeleteRangeOptions {
    const innerOptions: DeleteRangeOptions = {};

    if (options.limit !== undefined) {
      innerOptions.limit = options.limit;
    }
    if (options.gt !== undefined) {
      innerOptions.gt = this.#toInnerKey(options.gt);
    }
    if (options.gte !== undefined) {
      innerOptions.gte = this.#toInnerKey(options.gte);
    }
    if (options.lt !== undefined) {
      innerOptions.lt = this.#toInnerKey(options.lt);
    }
    if (options.lte !== undefined) {
      innerOptions.lte = this.#toInnerKey(options.lte);
    }

    return innerOptions;
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
 * import { workflow, Engine, MemoryStorage, scopedStorage } from '@lostgradient/weft';
 *
 * await using raw = new MemoryStorage();
 *
 * // Give each engine its own key namespace in the same backing store
 * await using engine = new Engine({ storage: scopedStorage(raw, 'eng:v1') });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 *
 * const handle = await engine.start('ping', null);
 * console.log(await handle.result()); // 'pong'
 * ```
 */
export function scopedStorage(storage: Storage, prefix: string): ScopedStorage {
  return new ScopedStorage(storage, prefix);
}
