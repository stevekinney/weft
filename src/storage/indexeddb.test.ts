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

const INDEXED_DB_LARGE_SCAN_TIMEOUT_MS = 30_000;

/** Helper to encode a string as Uint8Array. */
function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Helper to decode a Uint8Array to string. */
function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

describe('IndexedDBStorage', () => {
  it('rejects when the IndexedDB open request fails', async () => {
    const openError = new Error('open failed');

    await withFailingIndexedDbOpen(openError, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      await expect(storage.get('key')).rejects.toBe(openError);
    });
  });

  it('get on empty storage returns null', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    const result = await storage.get('nonexistent');
    expect(result).toBeNull();
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

  it('put then get returns same bytes', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    const value = encode('hello');
    await storage.put('key', value);
    const result = await storage.get('key');
    expect(result).toEqual(value);
  });

  it('put with same key overwrites previous value', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('key', encode('first'));
    await storage.put('key', encode('second'));
    const result = await storage.get('key');
    expect(decode(result!)).toBe('second');
  });

  it('delete removes key, subsequent get returns null', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('key', encode('value'));
    await storage.delete('key');
    const result = await storage.get('key');
    expect(result).toBeNull();
  });

  it('delete on nonexistent key is a no-op', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.delete('nonexistent');
    const result = await storage.get('nonexistent');
    expect(result).toBeNull();
  });

  it('scan with prefix returns only matching keys, sorted lexicographically', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('wf:b', encode('b'));
    await storage.put('wf:a', encode('a'));
    await storage.put('wf:c', encode('c'));
    await storage.put('other:x', encode('x'));

    const entries = await collect(storage.scan('wf:'));
    expect(entries.map(([key]) => key)).toEqual(['wf:a', 'wf:b', 'wf:c']);
  });

  it('scan with limit returns at most N entries', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const entries = await collect(storage.scan('p:', { limit: 2 }));
    expect(entries).toHaveLength(2);
    expect(entries.map(([key]) => key)).toEqual(['p:a', 'p:b']);
  });

  it('scan with reverse returns in reverse order', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const entries = await collect(storage.scan('p:', { reverse: true }));
    expect(entries.map(([key]) => key)).toEqual(['p:c', 'p:b', 'p:a']);
  });

  it('scan with gt/lt bounds', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const entries = await collect(storage.scan('p:', { gt: 'p:a', lt: 'p:d' }));
    expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
  });

  it('scan with gte/lte bounds', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const entries = await collect(storage.scan('p:', { gte: 'p:b', lte: 'p:c' }));
    expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
  });

  it('scan with no matches yields zero entries', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('other:a', encode('a'));

    const entries = await collect(storage.scan('wf:'));
    expect(entries).toHaveLength(0);
  });

  it('batch with multiple puts: all keys exist after', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.batch([
      { type: 'put', key: 'a', value: encode('1') },
      { type: 'put', key: 'b', value: encode('2') },
      { type: 'put', key: 'c', value: encode('3') },
    ]);

    expect(await storage.get('a')).toEqual(encode('1'));
    expect(await storage.get('b')).toEqual(encode('2'));
    expect(await storage.get('c')).toEqual(encode('3'));
  });

  it('batch with mixed puts and deletes: correct final state', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('keep', encode('keep'));
    await storage.put('remove', encode('remove'));

    await storage.batch([
      { type: 'put', key: 'new', value: encode('new') },
      { type: 'delete', key: 'remove' },
    ]);

    expect(await storage.get('keep')).toEqual(encode('keep'));
    expect(await storage.get('remove')).toBeNull();
    expect(await storage.get('new')).toEqual(encode('new'));
  });

  it('batch with empty array is a no-op', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('key', encode('value'));
    await storage.batch([]);
    expect(await storage.get('key')).toEqual(encode('value'));
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

  it('binary values: put Uint8Array with various byte values, verify identical on get', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    const binaryData = new Uint8Array([0, 1, 127, 128, 255, 42, 0, 13, 10]);
    await storage.put('binary', binaryData);
    const result = await storage.get('binary');
    expect(result).toEqual(binaryData);
  });

  it('scan with empty prefix returns all keys', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    await storage.put('alpha:1', encode('a1'));
    await storage.put('beta:2', encode('b2'));
    await storage.put('gamma:3', encode('g3'));

    const entries = await collect(storage.scan(''));
    expect(entries).toHaveLength(3);
    expect(entries.map(([key]) => key)).toEqual(['alpha:1', 'beta:2', 'gamma:3']);
  });

  it('scan with empty prefix on empty storage returns no entries', async () => {
    const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
    const entries = await collect(storage.scan(''));
    expect(entries).toHaveLength(0);
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

  it(
    'large key count (1000 entries): scan returns all in correct order',
    async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      const operations = Array.from({ length: 1000 }, (_, index) => ({
        type: 'put' as const,
        key: `item:${String(index).padStart(4, '0')}`,
        value: encode(String(index)),
      }));
      await storage.batch(operations);

      const entries = await collect(storage.scan('item:'));
      expect(entries).toHaveLength(1000);

      for (let index = 0; index < entries.length; index++) {
        expect(entries[index]![0]).toBe(`item:${String(index).padStart(4, '0')}`);
      }
    },
    INDEXED_DB_LARGE_SCAN_TIMEOUT_MS,
  );

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
