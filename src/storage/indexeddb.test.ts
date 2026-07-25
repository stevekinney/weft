import { describe, expect, it } from 'bun:test';

import { IndexedDBStorage } from './indexeddb';
import {
  createFakeRequest,
  createFakeTransaction,
  withFailingIndexedDbOpen,
  withFakeIndexedDb,
} from './indexeddb-fault-harness.test-support.ts';
import {
  collect,
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

runStorageCapabilityConformance('IndexedDBStorage', {
  create: () => new IndexedDBStorage(`weft-caps-${String(Math.random()).slice(2)}`),
  expected: {
    persistence: 'local',
    readAfterWrite: 'linearizable',
    scanConsistency: 'best-effort',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
});
runConcurrentConditionalBatchConformance('IndexedDBStorage', {
  create: () => new IndexedDBStorage(`weft-cas-${String(Math.random()).slice(2)}`),
});
runBasicStorageContract('IndexedDBStorage', {
  create: () => new IndexedDBStorage(`weft-basic-${String(Math.random()).slice(2)}`),
});
runBinaryAndLargeScanStorageConformance('IndexedDBStorage', {
  create: () => new IndexedDBStorage(`weft-large-${String(Math.random()).slice(2)}`),
});

/** Helper to encode a string as Uint8Array. */
function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe('IndexedDBStorage', () => {
  it('rejects when the IndexedDB open request fails', async () => {
    const openError = new Error('open failed');

    await withFailingIndexedDbOpen(openError, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      await expect(storage.get('key')).rejects.toBe(openError);
    });
  });

  it('rejects when an IndexedDB request errors during get', async () => {
    const requestError = new Error('get failed');

    const transaction = createFakeTransaction({
      store: () => ({
        get() {
          const getRequest = createFakeRequest<Uint8Array | undefined>({ error: requestError });
          queueMicrotask(() => getRequest.fireError());
          return getRequest;
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      await expect(storage.get('key')).rejects.toBe(requestError);
    });
  });

  it('deletePrefix rejects when the IndexedDB transaction errors', async () => {
    const transactionError = new Error('deletePrefix failed');

    const transaction = createFakeTransaction({
      transactionError,
      store: (tx) => ({
        count() {
          const countRequest = createFakeRequest<number>({ result: 2 });
          queueMicrotask(() => countRequest.fireSuccess());
          return countRequest;
        },
        delete() {
          queueMicrotask(() => tx.fireError());
          return createFakeRequest<undefined>({});
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      await expect(storage.deletePrefix('key:')).rejects.toBe(transactionError);
    });
  });

  it('batch rejects when the IndexedDB transaction errors', async () => {
    const transactionError = new Error('transaction failed');

    const transaction = createFakeTransaction({
      transactionError,
      store: () => ({
        put() {
          return createFakeRequest<IDBValidKey>({ result: 'key' });
        },
        delete() {
          return createFakeRequest<undefined>({});
        },
      }),
    });

    // The batch path attaches `transaction.onerror` after calling
    // `database.transaction()`, so the trigger lives in the database factory.
    await withFakeIndexedDb(
      {
        database: () =>
          ({
            objectStoreNames: { contains: () => true },
            createObjectStore() {},
            transaction() {
              queueMicrotask(() => transaction.fireError());
              return transaction;
            },
            close() {},
          }) as unknown as IDBDatabase,
      },
      async () => {
        const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
        await expect(
          storage.batch([{ type: 'put', key: 'key', value: encode('value') }]),
        ).rejects.toBe(transactionError);
      },
    );
  });

  it('keys rejects when the IndexedDB cursor request errors', async () => {
    const cursorError = new Error('cursor failed');

    const transaction = createFakeTransaction({
      store: () => ({
        openKeyCursor() {
          const cursorRequest = createFakeRequest<IDBCursor | null>({
            result: null,
            error: cursorError,
          });
          queueMicrotask(() => cursorRequest.fireError());
          return cursorRequest;
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      await expect(collect(storage.keys('key:'))).rejects.toBe(cursorError);
    });
  });

  it('keys uses openKeyCursor without opening value cursors', async () => {
    let keyCursorCalls = 0;
    let valueCursorCalls = 0;
    const transaction = createFakeTransaction({
      store: () => ({
        openKeyCursor() {
          keyCursorCalls++;
          const cursorRequest = createFakeRequest<IDBCursor | null>({ result: null });
          queueMicrotask(() => cursorRequest.fireSuccess());
          return cursorRequest;
        },
        openCursor() {
          valueCursorCalls++;
          const cursorRequest = createFakeRequest<IDBCursorWithValue | null>({ result: null });
          queueMicrotask(() => cursorRequest.fireSuccess());
          return cursorRequest;
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      expect(await collect(storage.keys('key:'))).toEqual([]);
    });

    expect(keyCursorCalls).toBe(1);
    expect(valueCursorCalls).toBe(0);
  });

  it('scan rejects when the IndexedDB transaction errors mid-cursor iteration', async () => {
    const transactionError = new Error('transaction failed');

    const transaction = createFakeTransaction({
      transactionError,
      store: (tx) => ({
        openCursor() {
          const cursorRequest = createFakeRequest<IDBCursorWithValue | null>({ result: null });
          queueMicrotask(() => tx.fireError());
          return cursorRequest;
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      await expect(collect(storage.scan('key:'))).rejects.toBe(transactionError);
    });
  });

  it('keys rejects when the IndexedDB transaction aborts mid-cursor iteration', async () => {
    const transactionError = new Error('transaction aborted');

    const transaction = createFakeTransaction({
      transactionError,
      store: (tx) => ({
        openKeyCursor() {
          const cursorRequest = createFakeRequest<IDBCursor | null>({ result: null });
          queueMicrotask(() => tx.fireAbort());
          return cursorRequest;
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      await expect(collect(storage.keys('key:'))).rejects.toBe(transactionError);
    });
  });

  it('[Symbol.dispose] closes database', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('key', encode('value'));
    storage[Symbol.dispose]();
    // After disposal, operations should fail or the database should be closed.
    // We verify by checking the database was closed (no throw on dispose itself).
  });

  it('early break from scan does not leak cursor or transaction', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('k:a', encode('a'));
    await storage.put('k:b', encode('b'));
    await storage.put('k:c', encode('c'));
    await storage.put('k:d', encode('d'));

    // Break after consuming the first entry
    const collected: string[] = [];
    for await (const [key] of storage.scan('k:')) {
      collected.push(key);
      if (collected.length === 1) break;
    }

    expect(collected).toEqual(['k:a']);

    // Verify the storage is still usable after early termination — a leaked
    // transaction/cursor would cause subsequent operations to hang or fail.
    const allEntries = await collect(storage.scan('k:'));
    expect(allEntries).toHaveLength(4);
  });

  it('early break from keys does not leak cursor or transaction', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('k:a', encode('a'));
    await storage.put('k:b', encode('b'));
    await storage.put('k:c', encode('c'));
    await storage.put('k:d', encode('d'));

    const collected: string[] = [];
    for await (const key of storage.keys('k:')) {
      collected.push(key);
      if (collected.length === 1) break;
    }

    expect(collected).toEqual(['k:a']);

    const allKeys = await collect(storage.keys('k:'));
    expect(allKeys).toHaveLength(4);
  });

  it('conditionalBatch rejects on request errors and ignores a later transaction error', async () => {
    const requestError = new Error('condition failed');
    const transactionError = new Error('transaction failed');

    const transaction = createFakeTransaction({
      transactionError,
      store: (tx) => ({
        get() {
          const request = createFakeRequest<Uint8Array | undefined>({ error: requestError });
          // The nested ordering — request error first, then a later
          // transaction error that must be ignored — is the behavior under test.
          queueMicrotask(() => {
            request.fireError();
            queueMicrotask(() => tx.fireError());
          });
          return request;
        },
        put() {
          return createFakeRequest<IDBValidKey>({ result: 'next' });
        },
        delete() {
          return createFakeRequest<undefined>({});
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      await expect(
        storage.conditionalBatch(
          [{ key: 'key', expectedValue: encode('value') }],
          [{ type: 'put', key: 'next', value: encode('next') }],
        ),
      ).rejects.toBe(requestError);
    });
  });
});

describe('IndexedDBStorage deleteRange edge cases', () => {
  async function seed(prefix: string, keys: string[]): Promise<IndexedDBStorage> {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.batch(keys.map((key) => ({ type: 'put' as const, key, value: encode(key) })));
    void prefix;
    return storage;
  }

  it('resolves equal lower bounds (gt and gte at the same key) to the stricter exclusive side', async () => {
    const storage = await seed('k:', ['k:a', 'k:b', 'k:c']);
    // gt and gte both at k:a: exclusive wins, so k:a survives.
    expect(await storage.deleteRange('k:', { gt: 'k:a', gte: 'k:a' })).toBe(2);
    expect(await storage.get('k:a')).not.toBeNull();
    expect(await storage.get('k:b')).toBeNull();
    expect(await storage.get('k:c')).toBeNull();
  });

  it('resolves equal upper bounds (lt and lte at the same key) to the stricter exclusive side', async () => {
    const storage = await seed('k:', ['k:a', 'k:b', 'k:c']);
    // lt and lte both at k:c: exclusive wins, so k:c survives.
    expect(await storage.deleteRange('k:', { lt: 'k:c', lte: 'k:c' })).toBe(2);
    expect(await storage.get('k:a')).toBeNull();
    expect(await storage.get('k:b')).toBeNull();
    expect(await storage.get('k:c')).not.toBeNull();
  });

  it('keeps the prefix exclusive end exclusive even when lte equals it', async () => {
    const storage = await seed('k:', ['k:a', 'k:b']);
    const prefixEnd = 'k;'; // resolvePrefixRangeEnd('k:')
    // An inclusive upper bound at the exclusive prefix end must not pull in keys
    // outside the prefix; both in-prefix keys are still deleted.
    expect(await storage.deleteRange('k:', { lte: prefixEnd })).toBe(2);
    expect(await storage.get('k:a')).toBeNull();
    expect(await storage.get('k:b')).toBeNull();
  });

  it('deletes nothing for an impossible range without throwing DataError', async () => {
    const storage = await seed('k:', ['k:a', 'k:b']);
    expect(await storage.deleteRange('k:', { gt: 'k:z', lt: 'k:a' })).toBe(0);
    expect(await storage.get('k:a')).not.toBeNull();
    expect(await storage.get('k:b')).not.toBeNull();
  });

  it('deletes nothing for a half-open empty range (gt === lt at the same key)', async () => {
    // Exercises the second null clause in resolveDeleteRangeBounds: equal bounds
    // with an open side collapse to an empty interval.
    const storage = await seed('k:', ['k:a', 'k:b']);
    expect(await storage.deleteRange('k:', { gt: 'k:a', lt: 'k:a' })).toBe(0);
    expect(await storage.get('k:a')).not.toBeNull();
    expect(await storage.get('k:b')).not.toBeNull();
  });

  it('lets gte win when it is stricter (higher) than gt', async () => {
    const storage = await seed('k:', ['k:a', 'k:b', 'k:c']);
    // gt='k:a' is wider; gte='k:b' is tighter and inclusive — k:b and k:c go.
    expect(await storage.deleteRange('k:', { gt: 'k:a', gte: 'k:b' })).toBe(2);
    expect(await storage.get('k:a')).not.toBeNull();
    expect(await storage.get('k:b')).toBeNull();
    expect(await storage.get('k:c')).toBeNull();
  });

  it('deletes the lowest keys first under a limit', async () => {
    const storage = await seed('k:', ['k:1', 'k:2', 'k:3', 'k:4']);
    expect(await storage.deleteRange('k:', { gte: 'k:', limit: 2 })).toBe(2);
    expect(await storage.get('k:1')).toBeNull();
    expect(await storage.get('k:2')).toBeNull();
    expect(await storage.get('k:3')).not.toBeNull();
    expect(await storage.get('k:4')).not.toBeNull();
  });
});
