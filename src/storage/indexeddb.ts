import {
  normalizeDeleteRangeOptions,
  resolveDeleteRangeBounds,
  type DeleteRangeOptions,
} from './delete-range';
import {
  assertStorageBatchOperationCount,
  matchesScanOptions,
  resolvePrefixRangeEnd,
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from './interface';
import { scopedStorage } from './scoped-storage';

const STORE_NAME = 'kv';

type IndexedDbRuntime = {
  indexedDB: Pick<typeof indexedDB, 'open'>;
  IDBKeyRange: Pick<typeof IDBKeyRange, 'bound'>;
};

function resolveIndexedDbRuntime(
  runtime: Partial<IndexedDbRuntime> = globalThis,
): IndexedDbRuntime {
  const indexedDbFactory = runtime.indexedDB;
  const keyRangeFactory = runtime.IDBKeyRange;
  if (indexedDbFactory === undefined || keyRangeFactory === undefined) {
    throw new Error('IndexedDBStorage requires both indexedDB and IDBKeyRange runtime globals.');
  }
  return {
    indexedDB: indexedDbFactory,
    IDBKeyRange: keyRangeFactory,
  };
}

/** Wrap an IDBRequest in a Promise, resolving on success and rejecting on error. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Convert cursor request callbacks into awaited iteration steps that reject on request or transaction failure. */
function createCursorRequestAwaiter<TCursor extends IDBCursor | IDBCursorWithValue>(
  request: IDBRequest<TCursor | null>,
  transaction: IDBTransaction,
): () => Promise<TCursor | null> {
  let resolveCurrent: ((value: TCursor | null) => void) | null = null;
  let rejectCurrent: ((reason?: unknown) => void) | null = null;
  let pendingError: DOMException | Error | null = null;

  const rejectPendingCursor = (
    error: DOMException | null | undefined,
    fallbackMessage: string,
  ): void => {
    const reason = error ?? new Error(fallbackMessage);

    if (rejectCurrent) {
      const reject = rejectCurrent;
      resolveCurrent = null;
      rejectCurrent = null;
      reject(reason);
      return;
    }

    pendingError = reason;
  };

  request.onsuccess = () => {
    if (!resolveCurrent) {
      return;
    }

    const resolve = resolveCurrent;
    resolveCurrent = null;
    rejectCurrent = null;
    resolve(request.result);
  };

  request.onerror = () => {
    rejectPendingCursor(request.error, 'IndexedDB cursor request failed.');
  };

  transaction.onerror = () => {
    rejectPendingCursor(transaction.error, 'IndexedDB transaction failed.');
  };

  transaction.onabort = () => {
    rejectPendingCursor(transaction.error, 'IndexedDB transaction aborted.');
  };

  return (): Promise<TCursor | null> => {
    return new Promise<TCursor | null>((resolve, reject) => {
      if (pendingError) {
        const error = pendingError;
        pendingError = null;
        reject(error);
        return;
      }

      resolveCurrent = resolve;
      rejectCurrent = reject;

      if (request.readyState === 'done') {
        const resolveReady = resolveCurrent;
        resolveCurrent = null;
        rejectCurrent = null;
        resolveReady?.(request.result);
      }
    });
  };
}

type CursorOpener<TCursor extends IDBCursor | IDBCursorWithValue> = (
  store: IDBObjectStore,
  range: IDBKeyRange,
  direction: IDBCursorDirection,
) => IDBRequest<TCursor | null>;

async function* iterateCursor<TCursor extends IDBCursor | IDBCursorWithValue, TValue>(
  database: IDBDatabase,
  keyRangeFactory: IndexedDbRuntime['IDBKeyRange'],
  prefix: string,
  options: ScanOptions,
  openCursor: CursorOpener<TCursor>,
  project: (cursor: TCursor) => TValue,
): AsyncIterable<TValue> {
  const { limit, reverse } = options;
  const prefixEnd = resolvePrefixRangeEnd(prefix);
  const range = keyRangeFactory.bound(prefix, prefixEnd, false, true);
  const direction: IDBCursorDirection = reverse ? 'prev' : 'next';

  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const request = openCursor(store, range, direction);
  const nextCursor = createCursorRequestAwaiter(request, transaction);

  let count = 0;
  let completed = false;
  try {
    let cursor = await nextCursor();

    while (cursor) {
      if (limit !== undefined && count >= limit) {
        break;
      }

      const key = cursor.key as string;
      if (matchesScanOptions(key, options)) {
        yield project(cursor);
        count++;
      }

      cursor.continue();
      cursor = await nextCursor();
    }

    completed = true;
  } finally {
    if (!completed) {
      try {
        transaction.abort();
      } catch {
        // Transaction may already be finished
      }
    }
  }
}

/**
 * IndexedDB-backed {@link Storage} implementation for browser and service-worker
 * environments.
 *
 * Initiates an IndexedDB open request on construction and lazily awaits it on
 * the first call. All operations transparently await the in-flight open before
 * issuing their transaction. The database has a single `'kv'` object store, and
 * `databaseName` defaults to `'weft'`. Use this when running weft inside a
 * browser tab or service worker where SQLite and LMDB are unavailable.
 *
 * @example
 * ```ts
 * import { IndexedDBStorage } from '@lostgradient/weft/storage/indexeddb';
 * import { workflow, Engine, type WorkflowContext } from '@lostgradient/weft';
 *
 * // Opens (or re-opens) the default 'weft' IndexedDB database
 * await using storage = new IndexedDBStorage();
 * await using engine = new Engine({ storage });
 *
 * engine.register(
 *   workflow({ name: 'greet' }).execute(async function* (ctx: WorkflowContext, input: { name: string }) {
 *     return `Hello, ${input.name}!`;
 *   }),
 * );
 *
 * const handle = await engine.start('greet', { name: 'World' });
 * console.log(await handle.result()); // 'Hello, World!'
 * ```
 */
export class IndexedDBStorage implements Storage {
  #databaseName: string;
  #database: IDBDatabase | null = null;
  #databasePromise: Promise<IDBDatabase>;
  readonly #runtime: IndexedDbRuntime;

  constructor(
    databaseName: string = 'weft',
    runtime: IndexedDbRuntime = resolveIndexedDbRuntime(),
  ) {
    this.#databaseName = databaseName;
    this.#runtime = runtime;
    this.#databasePromise = this.#open();
  }

  capabilities(): StorageCapabilities {
    // IndexedDB transactional same-origin store: same-instance reads observe
    // committed writes (linearizable); batch() runs in one readwrite
    // transaction; deletePrefix and deleteRange use IDBKeyRange deletes
    // (deleteRange cursor-deletes when a limit caps it). scan() iterates a
    // live cursor in a readonly transaction that auto-commits whenever the
    // microtask queue drains between async steps, so a concurrent external write
    // CAN appear mid-iteration — the honest scan level is best-effort, not
    // snapshot.
    return {
      persistence: 'local',
      readAfterWrite: 'linearizable',
      scanConsistency: 'best-effort',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  #open(): Promise<IDBDatabase> {
    const request = this.#runtime.indexedDB.open(this.#databaseName, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    return promisify(request).then((database) => {
      this.#database = database;
      return database;
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const result = await promisify(store.get(key));
    return result === undefined ? null : new Uint8Array(result);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    await promisify(store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    await promisify(store.delete(key));
  }

  async has(key: string): Promise<boolean> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    return (await promisify(store.count(key))) > 0;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const database = await this.#databasePromise;
    const prefixEnd = resolvePrefixRangeEnd(prefix);
    const range = this.#runtime.IDBKeyRange.bound(prefix, prefixEnd, false, true);

    return new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      let deletedCount = 0;

      const countRequest = store.count(range);
      countRequest.onsuccess = () => {
        deletedCount = countRequest.result;
        store.delete(range);
      };

      transaction.oncomplete = () => resolve(deletedCount);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    const normalized = normalizeDeleteRangeOptions(options);
    // resolveDeleteRangeBounds returns null for an impossible range, so we skip
    // building an IDBKeyRange that would otherwise throw DataError.
    const bounds = resolveDeleteRangeBounds(prefix, normalized);
    if (bounds === null) {
      return 0;
    }
    const range = this.#runtime.IDBKeyRange.bound(
      bounds.lower.key,
      bounds.upper.key,
      bounds.lower.open,
      bounds.upper.open,
    );

    const database = await this.#databasePromise;
    const { limit } = normalized;

    return new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      let deletedCount = 0;

      if (limit === undefined) {
        // No cap: count then range-delete in one shot, like deletePrefix.
        const countRequest = store.count(range);
        countRequest.onsuccess = () => {
          deletedCount = countRequest.result;
          store.delete(range);
        };
      } else {
        // Capped: walk a forward (ascending) cursor and delete the lowest N keys.
        const cursorRequest = store.openCursor(range, 'next');
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor === null || deletedCount >= limit) {
            return;
          }
          cursor.delete();
          deletedCount++;
          if (deletedCount < limit) {
            cursor.continue();
          }
        };
      }

      transaction.oncomplete = () => resolve(deletedCount);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const database = await this.#databasePromise;
    yield* iterateCursor(
      database,
      this.#runtime.IDBKeyRange,
      prefix,
      options,
      (store, range, direction) => store.openCursor(range, direction),
      (cursor) => [cursor.key as string, new Uint8Array(cursor.value)],
    );
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    if (operations.length === 0) return;

    const database = await this.#databasePromise;
    return new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      for (const operation of operations) {
        if (operation.type === 'put') {
          store.put(operation.value, operation.key);
        } else {
          store.delete(operation.key);
        }
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
    assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

    const database = await this.#databasePromise;

    return new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      let settled = false;
      let abortedByCondition = false;

      const settleReject = (
        error: DOMException | Error | null | undefined,
        message: string,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error ?? new Error(message));
      };

      transaction.oncomplete = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(true);
      };

      transaction.onerror = () => {
        settleReject(transaction.error, 'IndexedDB conditionalBatch transaction failed.');
      };

      transaction.onabort = () => {
        if (settled) {
          return;
        }

        settled = true;
        if (abortedByCondition) {
          resolve(false);
          return;
        }

        reject(transaction.error ?? new Error('IndexedDB conditionalBatch transaction aborted.'));
      };

      const applyOperations = (): void => {
        for (const operation of operations) {
          if (operation.type === 'put') {
            store.put(operation.value, operation.key);
          } else {
            store.delete(operation.key);
          }
        }
      };

      const verifyCondition = (index: number): void => {
        if (index >= conditions.length) {
          applyOperations();
          return;
        }

        const condition = conditions[index]!;
        const request = store.get(condition.key);

        request.onsuccess = () => {
          const raw = request.result;
          const currentValue = raw === undefined ? null : new Uint8Array(raw);
          if (!storageValuesEqual(currentValue, condition.expectedValue)) {
            abortedByCondition = true;
            transaction.abort();
            return;
          }

          verifyCondition(index + 1);
        };

        request.onerror = () => {
          settleReject(request.error, 'IndexedDB conditionalBatch condition check failed.');
        };
      };

      verifyCondition(0);
    });
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    const database = await this.#databasePromise;
    yield* iterateCursor(
      database,
      this.#runtime.IDBKeyRange,
      prefix,
      options,
      (store, range, direction) => store.openKeyCursor(range, direction),
      (cursor) => cursor.key as string,
    );
  }

  async count(prefix: string): Promise<number> {
    const database = await this.#databasePromise;
    const prefixEnd = resolvePrefixRangeEnd(prefix);
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    return promisify(store.count(this.#runtime.IDBKeyRange.bound(prefix, prefixEnd, false, true)));
  }

  scoped(prefix: string): Storage {
    const scoped = scopedStorage(this, prefix);
    return scoped;
  }

  [Symbol.dispose](): void {
    if (this.#database) {
      this.#database.close();
      this.#database = null;
    }
  }
}
