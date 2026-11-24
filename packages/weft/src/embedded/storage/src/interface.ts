import { requireStorageCapability, type StorageCapabilities } from './capabilities.ts';
import type { DeleteRangeOptions } from './delete-range.ts';
import {
  storageCountCore,
  storageDeletePrefixCore,
  storageHasCore,
  storageKeysCore,
} from './derived-operations.ts';
import type { StorageEntryMetadata, StorageScanEntryWithMetadata } from './entry-metadata.ts';
/**
 * A single KV operation in a batch.
 *
 * Either a put (write `value` at `key`) or a delete (remove `key`). The `type`
 * discriminant selects the variant; delete operations carry no value.
 */
export type BatchOperation =
  { type: 'put'; key: string; value: Uint8Array } | { type: 'delete'; key: string };

/**
 * Maximum number of operations or conditions accepted by one storage batch call.
 *
 * @example
 * ```ts
 * import { MAX_BATCH_OPERATIONS } from '@lostgradient/storage';
 *
 * console.log(MAX_BATCH_OPERATIONS); // 10000
 * ```
 */
export const MAX_BATCH_OPERATIONS = 10_000;

/**
 * Maximum `limit` accepted by raw storage scan administration routes.
 *
 * @example
 * ```ts
 * import { MAX_SCAN_LIMIT } from '@lostgradient/storage';
 *
 * console.log(MAX_SCAN_LIMIT); // 10000
 * ```
 */
export const MAX_SCAN_LIMIT = 10_000;

/**
 * Batch input category named by {@link StorageBatchOperationLimitExceededError}.
 *
 * @example
 * ```ts
 * import type { StorageBatchOperationLimitTarget } from '@lostgradient/storage';
 *
 * const target: StorageBatchOperationLimitTarget = 'batch operations';
 * void target;
 * ```
 */
export type StorageBatchOperationLimitTarget =
  'batch operations' | 'conditionalBatch conditions' | 'conditionalBatch operations';

/**
 * Error thrown before a storage batch exceeds {@link MAX_BATCH_OPERATIONS}.
 *
 * @example
 * ```ts
 * import { StorageBatchOperationLimitExceededError } from '@lostgradient/storage';
 *
 * const error = new StorageBatchOperationLimitExceededError('batch operations', 10001);
 * console.log(error.cap); // 10000
 * ```
 */
export class StorageBatchOperationLimitExceededError extends Error {
  readonly code = 'StorageBatchOperationLimitExceededError' as const;
  readonly cap = MAX_BATCH_OPERATIONS;
  readonly count: number;
  readonly target: StorageBatchOperationLimitTarget;

  constructor(target: StorageBatchOperationLimitTarget, count: number) {
    super(`${target} count ${count} exceeds MAX_BATCH_OPERATIONS (${MAX_BATCH_OPERATIONS}).`);
    this.name = 'StorageBatchOperationLimitExceededError';
    this.target = target;
    this.count = count;
  }
}

/**
 * Throw when a storage batch target exceeds {@link MAX_BATCH_OPERATIONS}.
 *
 * @example
 * ```ts
 * import { assertStorageBatchOperationCount } from '@lostgradient/storage';
 *
 * assertStorageBatchOperationCount('batch operations', 1);
 * ```
 */
export function assertStorageBatchOperationCount(
  target: StorageBatchOperationLimitTarget,
  count: number,
): void {
  if (count > MAX_BATCH_OPERATIONS) {
    throw new StorageBatchOperationLimitExceededError(target, count);
  }
}

/**
 * A key/value precondition for {@link Storage.conditionalBatch}.
 *
 * The batch commits only when every listed key currently matches the expected
 * value. Use `null` to require that the key is absent.
 */
export interface ConditionalBatchCondition {
  key: string;
  expectedValue: Uint8Array | null;
}

/**
 * Options for range scans.
 *
 * @example
 * ```ts
 * import { MemoryStorage, type ScanOptions } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * const options: ScanOptions = { limit: 10, reverse: true };
 * for await (const [key, value] of storage.scan('wf:', options)) {
 *   console.log(key);
 * }
 * ```
 */
export interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string;
  lt?: string;
  gte?: string;
  lte?: string;
}

/**
 * KV-oriented storage interface. All storage adapters implement this.
 *
 * Required methods are `get`, `put`, `delete`, `scan`, and `batch`. Optional
 * fast paths are `conditionalBatch`, `has`, `deletePrefix`, `deleteRange`,
 * `keys`, `count`, `scoped`, `stat`, `scanWithMetadata`, and `query`. Adapters that omit optional methods
 * get generic fallbacks via `storageHas`, `storageKeys`, `storageCount`,
 * `storageDeletePrefix`, and `storageConditionalBatch` (all from this module),
 * plus `storageDeleteRange` (defined in `delete-range.ts`) and `storageStat` and
 * `storageScanWithMetadata` (defined in `entry-metadata.ts`, which answer "unknown"),
 * all exported from `@lostgradient/storage`. Callers should use those wrappers rather than
 * calling optional methods directly.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/storage';
 * import type { Storage } from '@lostgradient/storage';
 *
 * await using storage: Storage = new MemoryStorage();
 * const encoded = new TextEncoder().encode('hello');
 * await storage.put('my-key', encoded);
 * const value = await storage.get('my-key');
 * console.log(new TextDecoder().decode(value!)); // 'hello'
 * ```
 */
export interface Storage extends Disposable {
  /** Native physical size in bytes, when supported. */
  sizeBytes?(): Promise<number>;
  /**
   * Self-report the backend's consistency and feature guarantees. Required on
   * every adapter so the engine and feature gates can act on an honest,
   * declarative profile rather than duck-typing optional methods. See
   * {@link StorageCapabilities} for the contract each field promises and which
   * fields are runtime-gated versus trusted.
   */
  capabilities(): StorageCapabilities;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;
  conditionalBatch?(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean>;
  has?(key: string): Promise<boolean>;
  deletePrefix?(prefix: string): Promise<number>;
  deleteRange?(prefix: string, options: DeleteRangeOptions): Promise<number>;
  keys?(prefix: string, options?: ScanOptions): AsyncIterable<string>;
  count?(prefix: string): Promise<number>;
  scoped?(prefix: string): Storage;
  /**
   * What the backend knows about `key` (when it was last written), or `null` when the key is
   * absent. Only backends that record write times implement it; call {@link storageStat}, which
   * answers `{ updatedAt: null }` for the rest.
   */
  stat?(key: string): Promise<StorageEntryMetadata | null>;
  /**
   * {@link Storage.scan} with each entry's metadata beside its value, read in the same statement.
   * Only backends that record write times implement it; call {@link storageScanWithMetadata},
   * which answers `{ updatedAt: null }` for the rest.
   */
  scanWithMetadata?(
    prefix: string,
    options?: ScanOptions,
  ): AsyncIterable<StorageScanEntryWithMetadata>;

  /** Optional SQL passthrough for dashboard/debugging. */
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Resolve the exclusive upper bound for a lexicographic prefix scan, or
 * `undefined` for the empty prefix, which matches every key and so has no
 * finite end (a sentinel like `'\xff'` would drop keys that sort past it).
 *
 * @example
 * ```ts
 * import { resolvePrefixRangeEnd } from '@lostgradient/storage';
 *
 * console.log(resolvePrefixRangeEnd('wf:')); // 'wf;'
 * console.log(resolvePrefixRangeEnd('')); // undefined
 * ```
 */
export function resolvePrefixRangeEnd(prefix: string): string | undefined {
  if (prefix.length === 0) return undefined;
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/**
 * Apply gt/gte/lt/lte scan bounds to a single key.
 *
 * @example
 * ```ts
 * import { matchesScanOptions } from '@lostgradient/storage';
 *
 * console.log(matchesScanOptions('wf:b', { gt: 'wf:a', lt: 'wf:c' })); // true
 * console.log(matchesScanOptions('wf:a', { gt: 'wf:a' }));              // false
 * ```
 */
export function matchesScanOptions(key: string, options: ScanOptions = {}): boolean {
  if (options.gt !== undefined && key <= options.gt) {
    return false;
  }

  if (options.gte !== undefined && key < options.gte) {
    return false;
  }

  if (options.lt !== undefined && key >= options.lt) {
    return false;
  }

  if (options.lte !== undefined && key > options.lte) {
    return false;
  }

  return true;
}

/**
 * Compare two storage values for byte-for-byte equality.
 *
 * @example
 * ```ts
 * import { storageValuesEqual } from '@lostgradient/storage';
 *
 * const a = new Uint8Array([1, 2, 3]);
 * const b = new Uint8Array([1, 2, 3]);
 * console.log(storageValuesEqual(a, b)); // true
 * console.log(storageValuesEqual(a, null)); // false
 * ```
 */
export function storageValuesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

/**
 * Check key existence using the adapter method when available or a core fallback otherwise.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/storage';
 * import { storageHas } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await storage.put('my-key', new Uint8Array([1]));
 * console.log(await storageHas(storage, 'my-key'));    // true
 * console.log(await storageHas(storage, 'other-key')); // false
 * ```
 */
export async function storageHas(storage: Storage, key: string): Promise<boolean> {
  if (storage.has) {
    return storage.has(key);
  }

  return storageHasCore(storage, key);
}

/**
 * Iterate keys only, using the adapter shortcut when available or `scan()` as a fallback.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/storage';
 * import { storageKeys } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * for await (const key of storageKeys(storage, 'wf:')) {
 *   console.log(key); // 'wf:abc'
 * }
 * ```
 */
export function storageKeys(
  storage: Storage,
  prefix: string,
  options?: ScanOptions,
): AsyncIterable<string> {
  if (storage.keys) {
    return storage.keys(prefix, options);
  }

  return storageKeysCore(storage, prefix, options);
}

/**
 * Count keys for a prefix using the adapter method when available or iteration otherwise.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/storage';
 * import { storageCount } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await storage.put('wf:1', new Uint8Array([1]));
 * await storage.put('wf:2', new Uint8Array([2]));
 * console.log(await storageCount(storage, 'wf:')); // 2
 * ```
 */
export async function storageCount(storage: Storage, prefix: string): Promise<number> {
  if (storage.count) {
    return storage.count(prefix);
  }

  return storageCountCore(storage, prefix);
}

/**
 * Delete a whole prefix using the adapter method when available or a batched fallback otherwise.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/storage';
 * import { storageDeletePrefix } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await storage.put('wf:a', new Uint8Array([1]));
 * await storage.put('wf:b', new Uint8Array([2]));
 * const deleted = await storageDeletePrefix(storage, 'wf:');
 * console.log(deleted); // 2
 * ```
 */
export async function storageDeletePrefix(storage: Storage, prefix: string): Promise<number> {
  if (storage.deletePrefix) {
    return storage.deletePrefix(prefix);
  }

  return storageDeletePrefixCore(storage, prefix);
}

/**
 * Run a storage batch after enforcing Weft's operation-count guardrail.
 *
 * @example
 * ```ts
 * import { MemoryStorage, storageBatch } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await storageBatch(storage, []);
 * ```
 */
export async function storageBatch(storage: Storage, operations: BatchOperation[]): Promise<void> {
  assertStorageBatchOperationCount('batch operations', operations.length);
  await storage.batch(operations);
}

/**
 * Run a conditional batch or throw when the backend does not support it.
 *
 * Built-in Memory, BunSQLite, NodeSQLite, LMDB, Turso, and IndexedDB backends
 * provide `conditionalBatch`; custom adapters may omit it.
 *
 * @throws {Error} This storage backend does not support conditionalBatch(), which is required for this operation.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/storage';
 * import { storageConditionalBatch } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * const key = 'my-key';
 * // Commit only if key is absent
 * const applied = await storageConditionalBatch(
 *   storage,
 *   [{ key, expectedValue: null }],
 *   [{ type: 'put', key, value: new Uint8Array([1]) }],
 * );
 * console.log(applied); // true
 * ```
 */
export async function storageConditionalBatch(
  storage: Pick<Storage, 'capabilities'> & { conditionalBatch?: Storage['conditionalBatch'] },
  conditions: ConditionalBatchCondition[],
  operations: BatchOperation[],
): Promise<boolean> {
  assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
  assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

  // Trust the declared capability, not method presence: an adapter that has the
  // method but honestly reports conditionalBatch: false (e.g. a remote HTTP
  // backend known to lack CAS) must not silently execute the swap.
  requireStorageCapability(storage, 'conditionalBatch', 'storageConditionalBatch');
  if (typeof storage.conditionalBatch !== 'function') {
    throw new Error(
      'This storage backend reports conditionalBatch capability but does not implement the conditionalBatch() method.',
    );
  }

  return storage.conditionalBatch(conditions, operations);
}
