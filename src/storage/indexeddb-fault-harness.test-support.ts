/**
 * Test-only fault harness for the IndexedDB storage failure-path suite. The
 * production IndexedDB adapter depends on load-bearing timing: failures arrive
 * via `queueMicrotask`, the open request resolves through `request.onsuccess`,
 * and request handlers (`onsuccess`/`onerror`) are assigned only AFTER the store
 * method returns. Each failure test must preserve that timing.
 *
 * This harness removes the byte-identical plumbing every failure test rebuilds
 * — the `IDBOpenDBRequest`, the `IDBDatabase` (`objectStoreNames.contains`,
 * `createObjectStore`, `close`, `transaction`), and the generic `IDBRequest`
 * shell — while leaving the behavior-distinguishing bits inline: which store
 * method throws, whether it is a request error vs. a transaction error vs. an
 * abort, the specific error object, and the trigger timing. The `fire*` methods
 * are SYNCHRONOUS; tests schedule them with `queueMicrotask` from inside the
 * store method (matching production, which assigns handlers after the method
 * returns).
 *
 * Consumed via deep import and intentionally not re-exported from any package
 * entry point. The `.test-support.ts` suffix is excluded by
 * `tsconfig.build.json` so this file never ships in `dist/`.
 */

/**
 * A configurable fake `IDBTransaction`, returned so tests can fire its handlers.
 * All `fire*` methods invoke the corresponding handler SYNCHRONOUSLY — the test
 * controls timing by deciding when to call them (typically inside a
 * `queueMicrotask(...)` at the trigger site).
 */
export type FakeTransaction = IDBTransaction & {
  /** Invoke `onerror` synchronously, carrying the preset transaction error. */
  fireError(): void;
  /** Invoke `onabort` synchronously. */
  fireAbort(): void;
  /** Invoke `oncomplete` synchronously. */
  fireComplete(): void;
};

/** A generic fake `IDBRequest<T>` whose handlers are fired explicitly. */
export type FakeRequest<T> = IDBRequest<T> & {
  /** Invoke `onsuccess` synchronously. */
  fireSuccess(): void;
  /** Invoke `onerror` synchronously, carrying the preset request error. */
  fireError(): void;
};

/**
 * Build a generic fake `IDBRequest<T>` with the standard
 * `{ result, error, onsuccess, onerror, readyState }` shape. `fireSuccess()` /
 * `fireError()` invoke the handler SYNCHRONOUSLY; schedule them with
 * `queueMicrotask(...)` from INSIDE the store method that produced the request,
 * because production assigns the request handlers only after that method
 * returns.
 */
export function createFakeRequest<T>(options: {
  result?: T;
  error?: DOMException | Error | null;
}): FakeRequest<T> {
  const request = {
    result: options.result,
    error: options.error ?? null,
    onsuccess: null,
    onerror: null,
    readyState: 'pending',
    fireSuccess() {
      request.onsuccess?.(new Event('success'));
    },
    fireError() {
      request.onerror?.(new Event('error'));
    },
  } as unknown as FakeRequest<T>;

  return request;
}

/**
 * Build a fake transaction. The store factory receives the transaction handle
 * so store methods can fire transaction-level error/abort/complete from inside
 * a method (e.g. `delete()` schedules `transaction.fireError()`), avoiding a
 * forward `let transaction` closure.
 */
export function createFakeTransaction(options: {
  transactionError?: DOMException | Error | null;
  store: (transaction: FakeTransaction) => Partial<IDBObjectStore>;
}): FakeTransaction {
  const transaction = {
    error: options.transactionError ?? null,
    oncomplete: null,
    onerror: null,
    onabort: null,
    objectStore() {
      return options.store(transaction);
    },
    abort() {},
    fireError() {
      transaction.onerror?.(new Event('error'));
    },
    fireAbort() {
      transaction.onabort?.(new Event('abort'));
    },
    fireComplete() {
      transaction.oncomplete?.(new Event('complete'));
    },
  } as unknown as FakeTransaction;

  return transaction;
}

/** Build the standard fake `IDBDatabase` that returns `transaction`. */
function createFakeDatabase(transaction: IDBTransaction): IDBDatabase {
  return {
    objectStoreNames: {
      contains() {
        return true;
      },
    },
    createObjectStore() {},
    transaction() {
      return transaction;
    },
    close() {},
  } as unknown as IDBDatabase;
}

/**
 * Install a fake `indexedDB.open` for the duration of `body`, restoring the
 * original in a finally. The open request resolves via `request.onsuccess` on
 * the next microtask, matching the real open lifecycle the production code
 * awaits. Pass `transaction` for the common case, or `database` to take full
 * control of the `IDBDatabase` (e.g. the batch test fires
 * `transaction.fireError()` from inside `database.transaction()`).
 */
export async function withFakeIndexedDb(
  options:
    | { transaction: IDBTransaction; database?: never }
    | { database: () => IDBDatabase; transaction?: never },
  body: () => Promise<void>,
): Promise<void> {
  const originalOpen = indexedDB.open.bind(indexedDB);

  try {
    indexedDB.open = (() => {
      const database = options.database
        ? options.database()
        : createFakeDatabase(options.transaction);

      const request = {
        result: database,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        readyState: 'pending',
      } as unknown as IDBOpenDBRequest;

      queueMicrotask(() => {
        request.onsuccess?.(new Event('success'));
      });

      return request;
    }) as typeof indexedDB.open;

    await body();
  } finally {
    indexedDB.open = originalOpen;
  }
}

/**
 * Open-failure variant: the fake open request rejects via `request.onerror` on
 * the next microtask, carrying `openError`.
 */
export async function withFailingIndexedDbOpen(
  openError: DOMException | Error,
  body: () => Promise<void>,
): Promise<void> {
  const originalOpen = indexedDB.open.bind(indexedDB);

  try {
    indexedDB.open = (() => {
      const request = {
        result: undefined,
        error: openError,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        readyState: 'pending',
      } as unknown as IDBOpenDBRequest;

      queueMicrotask(() => {
        request.onerror?.(new Event('error'));
      });

      return request;
    }) as typeof indexedDB.open;

    await body();
  } finally {
    indexedDB.open = originalOpen;
  }
}
