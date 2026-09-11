import { requireStorageCapability, type StorageCapabilities } from './capabilities.ts';
import { WORKFLOW_CATALOG_KEYS } from './catalog-keys.ts';
import type { DeleteRangeOptions } from './delete-range.ts';
import {
  storageCountCore,
  storageDeletePrefixCore,
  storageHasCore,
  storageKeysCore,
} from './derived-operations.ts';
import { GENERATION_KEYS } from './generation-keys.ts';
import { LEASE_KEYS } from './lease-keys.ts';
import { MAILBOX_KEYS } from './mailbox-keys.ts';
import { OUTBOX_KEYS } from './outbox-keys.ts';
import { OWNERSHIP_CLAIM_KEYS } from './ownership-keys.ts';
import { SIGNAL_KEYS } from './signal-keys.ts';
import {
  WORKFLOW_LIFECYCLE_KEYS_CORE,
  WORKFLOW_LIFECYCLE_KEYS_EXTENDED,
} from './workflow-lifecycle-keys.ts';
import {
  WORKFLOW_RECORD_KEYS_CORE,
  WORKFLOW_RECORD_KEYS_EXTENDED,
} from './workflow-record-keys.ts';

export { assertDurableStorageForRecovery, requireStorageCapability } from './capabilities.ts';
export type { GatedStorageCapabilityKey, StorageCapabilities } from './capabilities.ts';
export { DEFAULT_SCOPE } from './default-scope.ts';
export { WEFT_RESERVED_KEY_PREFIXES } from './key-prefixes.ts';

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
 * import { MAX_BATCH_OPERATIONS } from '@lostgradient/weft/storage';
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
 * import { MAX_SCAN_LIMIT } from '@lostgradient/weft/storage';
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
 * import type { StorageBatchOperationLimitTarget } from '@lostgradient/weft/storage';
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
 * import { StorageBatchOperationLimitExceededError } from '@lostgradient/weft/storage';
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
 * import { assertStorageBatchOperationCount } from '@lostgradient/weft/storage';
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
 * import { MemoryStorage, type ScanOptions } from '@lostgradient/weft';
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
 * `keys`, `count`, `scoped`, and `query`. Adapters that omit optional methods
 * get generic fallbacks via `storageHas`, `storageKeys`, `storageCount`,
 * `storageDeletePrefix`, and `storageConditionalBatch` (all from this module),
 * plus `storageDeleteRange` (exported from `@lostgradient/weft` / `@lostgradient/weft/storage`, defined in
 * `storage/delete-range.ts`). Callers should use those wrappers rather than
 * calling optional methods directly.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import type { Storage } from '@lostgradient/weft/storage/interface';
 *
 * await using storage: Storage = new MemoryStorage();
 * const encoded = new TextEncoder().encode('hello');
 * await storage.put('my-key', encoded);
 * const value = await storage.get('my-key');
 * console.log(new TextDecoder().decode(value!)); // 'hello'
 * ```
 */
export interface Storage extends Disposable {
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

  /** Optional SQL passthrough for dashboard/debugging. */
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Resolve the exclusive upper bound for a lexicographic prefix scan.
 *
 * @example
 * ```ts
 * import { resolvePrefixRangeEnd } from '@lostgradient/weft/storage/interface';
 *
 * const end = resolvePrefixRangeEnd('wf:');
 * console.log(end); // 'wf;'
 * // Use as an exclusive upper bound in range queries
 * ```
 */
export function resolvePrefixRangeEnd(prefix: string): string {
  return prefix.length > 0
    ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
    : '\xff';
}

/**
 * Apply gt/gte/lt/lte scan bounds to a single key.
 *
 * @example
 * ```ts
 * import { matchesScanOptions } from '@lostgradient/weft/storage/interface';
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
 * import { storageValuesEqual } from '@lostgradient/weft';
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
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { storageHas } from '@lostgradient/weft/storage/interface';
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
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { storageKeys } from '@lostgradient/weft/storage/interface';
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
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { storageCount } from '@lostgradient/weft/storage/interface';
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
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { storageDeletePrefix } from '@lostgradient/weft/storage/interface';
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
 * import { MemoryStorage, storageBatch } from '@lostgradient/weft/storage';
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
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { storageConditionalBatch } from '@lostgradient/weft/storage/interface';
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
  storage: Storage,
  conditions: ConditionalBatchCondition[],
  operations: BatchOperation[],
): Promise<boolean> {
  assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
  assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

  // Trust the declared capability, not method presence: an adapter that has the
  // method but honestly reports conditionalBatch: false (e.g. a remote HTTP
  // backend known to lack CAS) must not silently execute the swap.
  requireStorageCapability(storage, 'conditionalBatch', 'storageConditionalBatch');
  if (!storage.conditionalBatch) {
    throw new Error(
      'This storage backend reports conditionalBatch capability but does not implement the conditionalBatch() method.',
    );
  }

  return storage.conditionalBatch(conditions, operations);
}

export {
  decodeStorageKeyComponent,
  encodeStorageKeyComponent,
  formatSortableStorageTimestamp,
  tryDecodeStorageKeyComponent,
} from './key-encoding.ts';

/**
 * Key layout constants for hierarchical key encoding. Timestamps are
 * zero-padded to 16 digits for lexicographic ordering.
 *
 * The registry itself is assembled from feature-specific modules — `KEYS` is
 * the spread merge of the workflow record, lifecycle, signal, lease, mailbox,
 * outbox, ownership, and catalog key modules — so this file stays under the
 * repository's default 500-line ceiling (WFT-90). Prefer adding a new key
 * family as its own module spread into `KEYS` (see `ownership-keys.ts`) over
 * growing this file directly.
 *
 * `KEYS` is typed as an explicit intersection of each source module's own
 * `typeof` type rather than left to plain spread inference: TypeScript's
 * declaration emit does not propagate per-member JSDoc through an inferred
 * spread type, so hovering `KEYS.scheduleRunLink` would otherwise lose the
 * documentation on `scheduleRunLink` itself. The intersection keeps each
 * module's per-member docs as the single source of truth while still
 * surfacing them through `KEYS`.
 *
 * @example
 * ```ts
 * import { KEYS } from '@lostgradient/weft/storage/interface';
 * KEYS.workflow('workflow-id');
 * ```
 */
// This interleaving preserves the byte-identical Object.keys(KEYS) insertion
// order from before the module split (see interface.test.ts's characterization
// test): each *_CORE / *_EXTENDED pair is split at the point where another
// module's keys were interleaved in the original single-object literal.
export const KEYS: typeof WORKFLOW_RECORD_KEYS_CORE &
  typeof SIGNAL_KEYS &
  typeof WORKFLOW_LIFECYCLE_KEYS_CORE &
  typeof WORKFLOW_RECORD_KEYS_EXTENDED &
  typeof LEASE_KEYS &
  typeof MAILBOX_KEYS &
  typeof OUTBOX_KEYS &
  typeof OWNERSHIP_CLAIM_KEYS &
  typeof WORKFLOW_CATALOG_KEYS &
  typeof GENERATION_KEYS &
  typeof WORKFLOW_LIFECYCLE_KEYS_EXTENDED = {
  ...WORKFLOW_RECORD_KEYS_CORE,
  ...SIGNAL_KEYS,
  ...WORKFLOW_LIFECYCLE_KEYS_CORE,
  ...WORKFLOW_RECORD_KEYS_EXTENDED,
  ...LEASE_KEYS,
  ...MAILBOX_KEYS,
  ...OUTBOX_KEYS,
  ...OWNERSHIP_CLAIM_KEYS,
  ...WORKFLOW_CATALOG_KEYS,
  ...GENERATION_KEYS,
  ...WORKFLOW_LIFECYCLE_KEYS_EXTENDED,
};
