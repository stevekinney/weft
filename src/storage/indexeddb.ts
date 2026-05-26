import {
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
 * import { IndexedDBStorage } from 'weft/storage/indexeddb';
 * import { workflow, Engine, type WorkflowContext } from 'weft';
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

  constructor(databaseName: string = 'weft') {
    this.#databaseName = databaseName;
    this.#databasePromise = this.#open();
  }

  capabilities(): StorageCapabilities {
    // IndexedDB transactional same-origin store: same-instance reads observe
    // committed writes (linearizable); batch() runs in one readwrite
    // transaction; deletePrefix uses an IDBKeyRange delete. scan() iterates a
    // live cursor in a readonly transaction that auto-commits whenever the
    // microtask queue drains between async steps, so a concurrent external write
    // CAN appear mid-iteration — the honest scan level is best-effort, not
    // snapshot.
    return {
      readAfterWrite: 'linearizable',
      scanConsistency: 'best-effort',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  #open(): Promise<IDBDatabase> {
    const request = indexedDB.open(this.#databaseName, 1);

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
    const range = IDBKeyRange.bound(prefix, prefixEnd, false, true);

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

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { limit, reverse } = options;
    const database = await this.#databasePromise;

    const prefixEnd = resolvePrefixRangeEnd(prefix);
    const range = IDBKeyRange.bound(prefix, prefixEnd, false, true);
    const direction: IDBCursorDirection = reverse ? 'prev' : 'next';

    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor(range, direction);

    let count = 0;
    const nextCursor = createCursorRequestAwaiter(request, transaction);

    // Track whether iteration ran to completion so we can abort the transaction
    // on early termination (e.g., consumer breaks out of the loop), releasing the cursor.
    let completed = false;
    try {
      // Get the first cursor position
      let cursor = await nextCursor();

      while (cursor) {
        if (limit !== undefined && count >= limit) break;

        const key = cursor.key as string;

        if (matchesScanOptions(key, options)) {
          yield [key, new Uint8Array(cursor.value)];
          count++;
        }

        // Advance the cursor
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

  async batch(operations: BatchOperation[]): Promise<void> {
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
    const { limit, reverse } = options;
    const database = await this.#databasePromise;
    const prefixEnd = resolvePrefixRangeEnd(prefix);
    const range = IDBKeyRange.bound(prefix, prefixEnd, false, true);
    const direction: IDBCursorDirection = reverse ? 'prev' : 'next';

    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openKeyCursor(range, direction);

    let count = 0;
    const nextCursor = createCursorRequestAwaiter(request, transaction);

    let completed = false;
    try {
      let cursor = await nextCursor();

      while (cursor) {
        if (limit !== undefined && count >= limit) {
          break;
        }

        const key = cursor.key as string;

        if (matchesScanOptions(key, options)) {
          yield key;
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

  async count(prefix: string): Promise<number> {
    const database = await this.#databasePromise;
    const prefixEnd = resolvePrefixRangeEnd(prefix);
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    return promisify(store.count(IDBKeyRange.bound(prefix, prefixEnd, false, true)));
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
