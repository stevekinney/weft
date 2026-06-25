import { decodeBase64ToBytes, encodeBytesToBase64, isRecord } from './byte-encoding.ts';
import { normalizeDeleteRangeOptions, type DeleteRangeOptions } from './delete-range.ts';
import {
  storageCountCore,
  storageDeletePrefixCore,
  storageDeleteRangeCore,
  storageHasCore,
  storageKeysCore,
} from './derived-operations.ts';
import {
  assertStorageBatchOperationCount,
  matchesScanOptions,
  type BatchOperation,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from './interface.ts';
import { scopedStorage } from './scoped-storage.ts';

/** Named WebExtension storage area used by {@link WebExtensionStorage}.
 * @example
 * ```ts
 * import { WebExtensionStorage, type WebExtensionStorageArea } from '@lostgradient/weft/storage/web-extension';
 * const area: WebExtensionStorageArea = 'local';
 * const storage = new WebExtensionStorage({ area });
 * ```
 */
export type WebExtensionStorageArea = 'local' | 'sync' | 'session' | 'managed';

type WebExtensionStoragePersistence = NonNullable<StorageCapabilities['persistence']>;

/** Constructor options for {@link WebExtensionStorage}.
 * @example
 * ```ts
 * import { WebExtensionStorage, type WebExtensionStorageOptions } from '@lostgradient/weft/storage/web-extension';
 * const options: WebExtensionStorageOptions = { area: 'sync' };
 * const storage = new WebExtensionStorage(options);
 * ```
 */
export type WebExtensionStorageOptions = {
  area?: WebExtensionStorageArea;
};

type StorageEnvelope = {
  readonly __weftStorage: 1;
  readonly value: string;
};

type StorageKeyspace = Record<string, StorageEnvelope>;

type WebExtensionRuntime = {
  readonly lastError?: {
    readonly message?: string;
  };
};

type WebExtensionStorageAreaDriver = {
  readonly QUOTA_BYTES?: number;
  readonly QUOTA_BYTES_PER_ITEM?: number;
  get(
    keys?: string | string[] | null,
    callback?: (items: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> | undefined;
  set(items: Record<string, unknown>, callback?: () => void): Promise<void> | undefined;
  remove(keys: string | string[], callback?: () => void): Promise<void> | undefined;
  getBytesInUse?(
    keys?: string | string[] | null,
    callback?: (bytes: number) => void,
  ): Promise<number> | undefined;
};

type WebExtensionStorageChangeListener = (
  changes: Record<string, unknown>,
  areaName: WebExtensionStorageArea,
) => void;

type WebExtensionStorageNamespace = {
  readonly local?: WebExtensionStorageAreaDriver;
  readonly sync?: WebExtensionStorageAreaDriver;
  readonly session?: WebExtensionStorageAreaDriver;
  readonly managed?: WebExtensionStorageAreaDriver;
  readonly onChanged?: {
    addListener?(listener: WebExtensionStorageChangeListener): void;
    removeListener?(listener: WebExtensionStorageChangeListener): void;
  };
};

type WebExtensionNamespace = {
  readonly runtime?: WebExtensionRuntime;
  readonly storage?: WebExtensionStorageNamespace;
};

type WebExtensionGlobal = typeof globalThis & {
  readonly browser?: WebExtensionNamespace;
  readonly chrome?: WebExtensionNamespace;
};

const ENVELOPE_MARKER = 1;
const KEYSPACE_STORAGE_KEY = '__weftStorageKeyspace';
const DEFAULT_SYNC_QUOTA_BYTES = 102_400;
const DEFAULT_SYNC_QUOTA_BYTES_PER_ITEM = 8_192;

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function isStorageEnvelope(value: unknown): value is StorageEnvelope {
  if (!isRecord(value)) return false;
  if (value['__weftStorage'] !== ENVELOPE_MARKER) return false;
  return typeof value['value'] === 'string';
}

function isStorageKeyspace(value: unknown): value is StorageKeyspace {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isStorageEnvelope);
}

function assertUserStorageKey(key: string): void {
  if (key !== KEYSPACE_STORAGE_KEY) return;
  throw new Error(
    `WebExtensionStorage key "${KEYSPACE_STORAGE_KEY}" is reserved for adapter metadata.`,
  );
}

function assertBatchUserStorageKeys(operations: readonly BatchOperation[]): void {
  for (const operation of operations) {
    assertUserStorageKey(operation.key);
  }
}

function createPutEnvelope(value: Uint8Array): StorageEnvelope {
  return { __weftStorage: ENVELOPE_MARKER, value: encodeBytesToBase64(value) };
}

function decodeEnvelope(value: unknown): Uint8Array | null {
  if (!isStorageEnvelope(value)) return null;
  return decodeBase64ToBytes(value.value);
}

function envelopeIsVisible(
  value: unknown,
): value is { readonly __weftStorage: 1; readonly value: string } {
  return isStorageEnvelope(value);
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isWebExtensionNamespace(value: unknown): value is WebExtensionNamespace {
  if (!isRecord(value)) return false;
  if (value['runtime'] !== undefined && !isRecord(value['runtime'])) return false;
  return value['storage'] === undefined || isRecord(value['storage']);
}

function resolveNamespace(namespace: unknown = undefined): WebExtensionNamespace {
  if (namespace !== undefined) {
    if (!isWebExtensionNamespace(namespace)) {
      throw new Error('WebExtensionStorage injected namespace must be an object.');
    }
    return namespace;
  }

  const globalObject = globalThis as WebExtensionGlobal;
  const globalNamespace = globalObject.browser ?? globalObject.chrome;
  if (globalNamespace?.storage === undefined) {
    throw new Error(
      'WebExtensionStorage requires globalThis.browser.storage or globalThis.chrome.storage.',
    );
  }
  return globalNamespace;
}

function resolveStorageArea(
  namespace: WebExtensionNamespace,
  area: WebExtensionStorageArea,
): WebExtensionStorageAreaDriver {
  const driver = namespace.storage?.[area];
  if (driver === undefined) {
    throw new Error(`WebExtensionStorage area "${area}" is not available.`);
  }
  return driver;
}

function webExtensionAreaPersistence(
  area: WebExtensionStorageArea,
): WebExtensionStoragePersistence {
  if (area === 'session') {
    return 'ephemeral';
  }

  if (area === 'sync' || area === 'managed') {
    return 'remote';
  }

  return 'local';
}

function lastRuntimeError(namespace: WebExtensionNamespace): Error | null {
  const message = namespace.runtime?.lastError?.message;
  return message === undefined ? null : new Error(message);
}

async function invokeWebExtensionMethod<T>(
  namespace: WebExtensionNamespace,
  invoke: (callback: (value: T) => void) => Promise<T> | undefined,
  invokeWithoutCallback: () => Promise<T> | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settleResolve = (value: T): void => {
      if (settled) return;
      const error = lastRuntimeError(namespace);
      settled = true;
      if (error !== null) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const callback = (value: T): void => settleResolve(value);
    let result: Promise<T> | undefined;

    try {
      result = invoke(callback);
    } catch {
      try {
        result = invokeWithoutCallback();
      } catch (error) {
        settleReject(error);
        return;
      }
    }

    if (isPromiseLike<T>(result)) {
      void result.then(settleResolve, settleReject);
    }
  });
}

/**
 * WebExtension storage adapter for browser extension contexts.
 *
 * Values are stored as JSON envelopes containing base64-encoded `Uint8Array`
 * bytes so the canonical Weft storage value type stays portable across
 * `browser.storage` and callback-style `chrome.storage` implementations.
 *
 * @example
 * ```ts
 * import { Engine } from '@lostgradient/weft';
 * import { WebExtensionStorage } from '@lostgradient/weft/storage/web-extension';
 *
 * await using storage = new WebExtensionStorage({ area: 'local' });
 * await using engine = new Engine({ storage });
 * ```
 */
export class WebExtensionStorage implements Storage {
  static readonly #mutationQueues = new WeakMap<WebExtensionStorageAreaDriver, Promise<void>>();

  readonly #namespace: WebExtensionNamespace;
  readonly #driver: WebExtensionStorageAreaDriver;
  readonly #area: WebExtensionStorageArea;
  readonly #persistence: WebExtensionStoragePersistence;
  readonly #changeListener: WebExtensionStorageChangeListener;

  constructor(options: WebExtensionStorageOptions = {}, namespace: unknown = undefined) {
    this.#area = options.area ?? 'local';
    this.#persistence = webExtensionAreaPersistence(this.#area);
    this.#namespace = resolveNamespace(namespace);
    this.#driver = resolveStorageArea(this.#namespace, this.#area);
    this.#changeListener = () => {};
    this.#namespace.storage?.onChanged?.addListener?.(this.#changeListener);
  }

  capabilities(): StorageCapabilities {
    // browser.storage/chrome.storage has no transactions. batch() rewrites the
    // keyspace under an in-process lock with one storage set, but there is no
    // native CAS and scans are best-effort across extension contexts.
    return {
      persistence: this.#persistence,
      readAfterWrite: 'session',
      scanConsistency: 'best-effort',
      atomicBatch: false,
      conditionalBatch: false,
      boundedRangeDelete: false,
    };
  }

  async #getItems(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    return invokeWebExtensionMethod(
      this.#namespace,
      (callback) => this.#driver.get(keys, callback),
      () => this.#driver.get(keys),
    );
  }

  async #setItems(items: Record<string, unknown>): Promise<void> {
    await invokeWebExtensionMethod(
      this.#namespace,
      (callback) => this.#driver.set(items, callback),
      () => this.#driver.set(items),
    );
  }

  async #getBytesInUse(keys?: string | string[] | null): Promise<number | null> {
    if (this.#driver.getBytesInUse === undefined) return null;
    return invokeWebExtensionMethod(
      this.#namespace,
      (callback) => this.#driver.getBytesInUse?.(keys, callback),
      () => this.#driver.getBytesInUse?.(keys),
    );
  }

  async #getKeyspace(): Promise<StorageKeyspace> {
    const items = await this.#getItems(KEYSPACE_STORAGE_KEY);
    const keyspace = items[KEYSPACE_STORAGE_KEY];
    if (keyspace === undefined) return {};
    if (!isStorageKeyspace(keyspace)) {
      throw new Error('WebExtensionStorage keyspace is not a valid storage envelope map.');
    }
    return { ...keyspace };
  }

  async #writeKeyspace(keyspace: StorageKeyspace): Promise<void> {
    const items: Record<string, unknown> = { [KEYSPACE_STORAGE_KEY]: keyspace };
    await this.#assertSyncQuota(items);
    await this.#setItems(items);
  }

  async #withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = WebExtensionStorage.#mutationQueues.get(this.#driver) ?? Promise.resolve();
    const gate: { release?: () => void } = {};
    const current = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);

    WebExtensionStorage.#mutationQueues.set(this.#driver, queued);
    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      gate.release?.();
      if (WebExtensionStorage.#mutationQueues.get(this.#driver) === queued) {
        WebExtensionStorage.#mutationQueues.delete(this.#driver);
      }
    }
  }

  #assertWritable(): void {
    if (this.#area === 'managed') {
      throw new Error('WebExtensionStorage area "managed" is read-only.');
    }
  }

  #assertSyncItemQuota(items: Record<string, unknown>): void {
    const itemQuota = this.#driver.QUOTA_BYTES_PER_ITEM ?? DEFAULT_SYNC_QUOTA_BYTES_PER_ITEM;
    for (const [key, value] of Object.entries(items)) {
      const bytes = serializedByteLength({ [key]: value });
      if (bytes > itemQuota) {
        throw new Error(
          `WebExtensionStorage sync item quota exceeded for "${key}": ${String(bytes)} > ${String(
            itemQuota,
          )}.`,
        );
      }
    }
  }

  async #projectSyncTotalBytes(items: Record<string, unknown>): Promise<number> {
    const replacementKeys = Object.keys(items);
    const currentTotalBytes = await this.#getBytesInUse(null);
    const currentReplacementBytes = await this.#getBytesInUse(replacementKeys);

    if (currentTotalBytes !== null && currentReplacementBytes !== null) {
      return currentTotalBytes - currentReplacementBytes + serializedByteLength(items);
    }

    const current = await this.#getItems(null);
    return serializedByteLength({ ...current, ...items });
  }

  async #assertSyncQuota(items: Record<string, unknown>): Promise<void> {
    if (this.#area !== 'sync') return;

    this.#assertSyncItemQuota(items);
    const totalQuota = this.#driver.QUOTA_BYTES ?? DEFAULT_SYNC_QUOTA_BYTES;
    const projectedTotalBytes = await this.#projectSyncTotalBytes(items);

    if (projectedTotalBytes > totalQuota) {
      throw new Error(
        `WebExtensionStorage sync total quota exceeded: ${String(projectedTotalBytes)} > ${String(
          totalQuota,
        )}.`,
      );
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertUserStorageKey(key);
    const keyspace = await this.#getKeyspace();
    return decodeEnvelope(keyspace[key]);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#assertWritable();
    assertUserStorageKey(key);
    await this.#withMutationLock(async () => {
      const keyspace = await this.#getKeyspace();
      keyspace[key] = createPutEnvelope(value);
      await this.#writeKeyspace(keyspace);
    });
  }

  async delete(key: string): Promise<void> {
    this.#assertWritable();
    assertUserStorageKey(key);
    await this.#withMutationLock(async () => {
      const keyspace = await this.#getKeyspace();
      if (!(key in keyspace)) return;
      delete keyspace[key];
      await this.#writeKeyspace(keyspace);
    });
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const keyspace = await this.#getKeyspace();
    let keys = Object.keys(keyspace)
      .filter((key) => key.startsWith(prefix))
      .filter((key) => matchesScanOptions(key, options))
      .filter((key) => envelopeIsVisible(keyspace[key]))
      .toSorted();

    if (options.reverse) {
      keys = keys.toReversed();
    }

    let count = 0;
    for (const key of keys) {
      if (options.limit !== undefined && count >= options.limit) break;
      const value = decodeEnvelope(keyspace[key]);
      if (value === null) continue;
      yield [key, value];
      count += 1;
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    this.#assertWritable();
    if (operations.length === 0) return;
    assertBatchUserStorageKeys(operations);
    await this.#withMutationLock(async () => {
      const keyspace = await this.#getKeyspace();
      for (const operation of operations) {
        if (operation.type === 'put') {
          keyspace[operation.key] = createPutEnvelope(operation.value);
        } else {
          delete keyspace[operation.key];
        }
      }
      await this.#writeKeyspace(keyspace);
    });
  }

  has(key: string): Promise<boolean> {
    return storageHasCore(this, key);
  }

  async *keys(prefix: string, options?: ScanOptions): AsyncIterable<string> {
    yield* storageKeysCore(this, prefix, options);
  }

  count(prefix: string): Promise<number> {
    return storageCountCore(this, prefix);
  }

  async deletePrefix(prefix: string): Promise<number> {
    // Reject a write attempt on a read-only area before scanning or deleting
    // anything, even when no keys match — `batch()` would also assert, but only
    // after a non-empty scan, so the up-front check preserves the contract for
    // the empty-prefix case. `async` ensures the rejection surfaces as a
    // rejected promise rather than a synchronous throw.
    this.#assertWritable();
    return storageDeletePrefixCore(this, prefix);
  }

  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    // Normalize before the writable check so invalid bounds fail consistently.
    const normalized = normalizeDeleteRangeOptions(options);
    this.#assertWritable();
    return storageDeleteRangeCore(this, prefix, normalized);
  }

  scoped(prefix: string): Storage {
    return scopedStorage(this, prefix);
  }

  [Symbol.dispose](): void {
    this.#namespace.storage?.onChanged?.removeListener?.(this.#changeListener);
  }
}
