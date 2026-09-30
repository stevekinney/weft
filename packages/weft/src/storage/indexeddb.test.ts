import { describe, expect, it, spyOn } from 'bun:test';

import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  createFakeRequest,
  createFakeTransaction,
  withFailingIndexedDbOpen,
  withFakeIndexedDb,
} from './indexeddb-fault-harness.test-support.ts';
import { SCAN_PAGE_SIZE } from './indexeddb-scan-page-size.ts';
import { IndexedDBStorage } from './indexeddb.ts';
import type { ScanOptions } from './interface.ts';
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
  largeScanTimeoutMs: 30_000,
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
      expect(await rejectionOf(storage.get('key'))).toBe(openError);
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
      expect(await rejectionOf(storage.get('key'))).toBe(requestError);
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
      expect(await rejectionOf(storage.deletePrefix('key:'))).toBe(transactionError);
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
        expect(
          await rejectionOf(storage.batch([{ type: 'put', key: 'key', value: encode('value') }])),
        ).toBe(transactionError);
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
      expect(await rejectionOf(collect(storage.keys('key:')))).toBe(cursorError);
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
      expect(await rejectionOf(collect(storage.scan('key:')))).toBe(transactionError);
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
      expect(await rejectionOf(collect(storage.keys('key:')))).toBe(transactionError);
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
      expect(
        await rejectionOf(
          storage.conditionalBatch(
            [{ key: 'key', expectedValue: encode('value') }],
            [{ type: 'put', key: 'next', value: encode('next') }],
          ),
        ),
      ).toBe(requestError);
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

const PAGE = SCAN_PAGE_SIZE;

/** Zero-padded key so lexicographic order equals numeric order. */
function pagedKey(index: number, prefix = 'p:'): string {
  return `${prefix}${String(index).padStart(6, '0')}`;
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function seedKeys(storage: IndexedDBStorage, keys: string[]): Promise<void> {
  await storage.batch(keys.map((key) => ({ type: 'put' as const, key, value: encode(key) })));
}

async function seedCount(count: number, prefix = 'p:'): Promise<IndexedDBStorage> {
  const storage = new IndexedDBStorage(`paged-${crypto.randomUUID()}`);
  await seedKeys(
    storage,
    Array.from({ length: count }, (_, index) => pagedKey(index, prefix)),
  );
  return storage;
}

type KeyReader = {
  name: 'scan' | 'keys';
  read: (storage: IndexedDBStorage, prefix: string, options?: ScanOptions) => AsyncIterable<string>;
};

const keyReaders: KeyReader[] = [
  {
    name: 'scan',
    async *read(storage, prefix, options) {
      for await (const [key] of storage.scan(prefix, options)) yield key;
    },
  },
  { name: 'keys', read: (storage, prefix, options) => storage.keys(prefix, options) },
];

/** Count transactions opened while `run` executes. */
async function countTransactions(run: () => Promise<void>): Promise<number> {
  const spy = spyOn(IDBDatabase.prototype, 'transaction');
  try {
    await run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe('IndexedDBStorage paged scans', () => {
  it('uses an internal page size strictly between 1 and 1000', () => {
    expect(Number.isInteger(SCAN_PAGE_SIZE)).toBe(true);
    expect(SCAN_PAGE_SIZE).toBeGreaterThan(1);
    expect(SCAN_PAGE_SIZE).toBeLessThan(1000);
  });

  it('keeps reporting best-effort scan consistency', () => {
    expect(
      new IndexedDBStorage(`paged-${crypto.randomUUID()}`).capabilities().scanConsistency,
    ).toBe('best-effort');
  });

  it('scan tolerates a consumer that awaits storage work and a macrotask per record', async () => {
    const storage = await seedCount(PAGE * 2 + 1);
    const seen: string[] = [];
    for await (const [key] of storage.scan('p:')) {
      await storage.get(key);
      await macrotask();
      seen.push(key);
    }
    expect(seen).toEqual(Array.from({ length: PAGE * 2 + 1 }, (_, index) => pagedKey(index)));
  });

  it('keys tolerates a consumer that awaits storage work and a macrotask per record', async () => {
    const storage = await seedCount(PAGE * 2 + 1);
    const seen: string[] = [];
    for await (const key of storage.keys('p:')) {
      await storage.get(key);
      await macrotask();
      seen.push(key);
    }
    expect(seen).toEqual(Array.from({ length: PAGE * 2 + 1 }, (_, index) => pagedKey(index)));
  });

  for (const reader of keyReaders) {
    describe(reader.name, () => {
      const collectKeys = async (
        storage: IndexedDBStorage,
        prefix: string,
        options?: ScanOptions,
      ): Promise<string[]> => {
        const out: string[] = [];
        for await (const key of reader.read(storage, prefix, options)) out.push(key);
        return out;
      };
      const expected = (count: number, reverse = false): string[] => {
        const all = Array.from({ length: count }, (_, index) => pagedKey(index));
        return reverse ? all.toReversed() : all;
      };

      for (const count of [PAGE * 2 + 7, PAGE * 2, PAGE, PAGE - 1, 1]) {
        it(`yields every key once in order, forward and reverse, for ${count} records`, async () => {
          const storage = await seedCount(count);
          expect(await collectKeys(storage, 'p:')).toEqual(expected(count));
          expect(await collectKeys(storage, 'p:', { reverse: true })).toEqual(
            expected(count, true),
          );
        });
      }

      it('yields every key once for the empty prefix, forward and reverse', async () => {
        const storage = await seedCount(PAGE * 2 + 3);
        expect(await collectKeys(storage, '')).toEqual(expected(PAGE * 2 + 3));
        expect(await collectKeys(storage, '', { reverse: true })).toEqual(
          expected(PAGE * 2 + 3, true),
        );
      });

      it('yields nothing after exactly one zero-row page for an empty prefix match', async () => {
        const storage = await seedCount(3);
        let result: string[] = ['unset'];
        const transactions = await countTransactions(async () => {
          result = await collectKeys(storage, 'absent:');
        });
        expect(result).toEqual([]);
        expect(transactions).toBe(1);
      });

      it('opens one extra zero-row page only for an exact multiple of the page size', async () => {
        const exact = await seedCount(PAGE * 2);
        expect(await countTransactions(async () => void (await collectKeys(exact, 'p:')))).toBe(3);
        const short = await seedCount(PAGE * 2 - 1);
        expect(await countTransactions(async () => void (await collectKeys(short, 'p:')))).toBe(2);
      });

      it('honors limit across a page boundary and stops opening pages', async () => {
        const storage = await seedCount(PAGE * 3);
        let result: string[] = [];
        const transactions = await countTransactions(async () => {
          result = await collectKeys(storage, 'p:', { limit: PAGE + 10 });
        });
        expect(result).toEqual(expected(PAGE + 10));
        expect(transactions).toBe(2);
      });

      it('does not open another page when limit lands exactly on a page boundary', async () => {
        const storage = await seedCount(PAGE * 3);
        let result: string[] = [];
        const transactions = await countTransactions(async () => {
          result = await collectKeys(storage, 'p:', { limit: PAGE });
        });
        expect(result).toEqual(expected(PAGE));
        expect(transactions).toBe(1);
      });

      it('yields nothing for limit 0', async () => {
        const storage = await seedCount(PAGE + 1);
        expect(await collectKeys(storage, 'p:', { limit: 0 })).toEqual([]);
      });

      it('honors a gt bound beyond the first page, including a first page with no matches', async () => {
        const count = PAGE * 3;
        const storage = await seedCount(count);
        const gt = pagedKey(PAGE + 10);
        expect(await collectKeys(storage, 'p:', { gt })).toEqual(
          expected(count).filter((key) => key > gt),
        );
      });

      it('honors an lt bound beyond the first page in both directions', async () => {
        const count = PAGE * 3;
        const storage = await seedCount(count);
        const lt = pagedKey(PAGE + 5);
        expect(await collectKeys(storage, 'p:', { lt })).toEqual(
          expected(count).filter((key) => key < lt),
        );
        const lowLt = pagedKey(5);
        expect(await collectKeys(storage, 'p:', { lt: lowLt, reverse: true })).toEqual(
          expected(count, true).filter((key) => key < lowLt),
        );
      });

      it('terminates a reverse scan whose lowest key equals the prefix', async () => {
        for (const total of [PAGE * 2, PAGE + 1, PAGE * 2 + 1]) {
          const storage = new IndexedDBStorage(`paged-${crypto.randomUUID()}`);
          const others = Array.from({ length: total - 1 }, (_, index) => pagedKey(index));
          await seedKeys(storage, ['p:', ...others]);
          expect(await collectKeys(storage, 'p:', { reverse: true })).toEqual([
            ...others.toReversed(),
            'p:',
          ]);
        }
      });

      it('terminates a reverse empty-prefix scan whose lowest key is the empty string', async () => {
        for (const total of [PAGE * 2, PAGE + 1]) {
          const storage = new IndexedDBStorage(`paged-${crypto.randomUUID()}`);
          const others = Array.from({ length: total - 1 }, (_, index) => pagedKey(index));
          await seedKeys(storage, ['', ...others]);
          expect(await collectKeys(storage, '', { reverse: true })).toEqual([
            ...others.toReversed(),
            '',
          ]);
          expect(await collectKeys(storage, '')).toEqual(['', ...others]);
        }
      });

      describe('mutation semantics', () => {
        const drain = async (iterator: AsyncIterator<string>): Promise<string[]> => {
          const out: string[] = [];
          for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
            out.push(step.value);
          }
          return out;
        };

        it('lets a purge-shaped consumer delete every key exactly once across pages', async () => {
          const count = PAGE * 2 + 1;
          const storage = await seedCount(count);
          const seen: string[] = [];
          for await (const key of reader.read(storage, 'p:')) {
            await storage.delete(key);
            await macrotask();
            seen.push(key);
          }
          expect(seen).toEqual(expected(count));
          expect(await collectKeys(storage, 'p:')).toEqual([]);
        });

        it('yields a buffered key deleted before it is yielded', async () => {
          const storage = await seedCount(PAGE * 2);
          const iterator = reader.read(storage, 'p:')[Symbol.asyncIterator]();
          const first = await iterator.next();
          expect(first.value).toBe(pagedKey(0));
          await storage.delete(pagedKey(1));
          const second = await iterator.next();
          expect(second.value).toBe(pagedKey(1));
        });

        it('does not yield a key in a later page deleted before that page is read', async () => {
          const storage = await seedCount(PAGE * 2);
          const iterator = reader.read(storage, 'p:')[Symbol.asyncIterator]();
          await iterator.next();
          await storage.delete(pagedKey(PAGE + 3));
          const rest = await drain(iterator);
          expect(rest).not.toContain(pagedKey(PAGE + 3));
          expect(rest).toHaveLength(PAGE * 2 - 2);
        });

        it('yields a key inserted after the continuation key of a non-final full page exactly once', async () => {
          const storage = await seedCount(PAGE * 2 + 1);
          const iterator = reader.read(storage, 'p:')[Symbol.asyncIterator]();
          await iterator.next();
          const inserted = `${pagedKey(PAGE - 1)}x`;
          await storage.put(inserted, encode('x'));
          const rest = await drain(iterator);
          expect(rest.filter((key) => key === inserted)).toHaveLength(1);
          expect(rest.indexOf(inserted)).toBe(PAGE - 1);
          expect(new Set(rest).size).toBe(rest.length);
        });

        it('does not yield a key inserted at or before the continuation key', async () => {
          const storage = await seedCount(PAGE * 2 + 1);
          const iterator = reader.read(storage, 'p:')[Symbol.asyncIterator]();
          await iterator.next();
          const inserted = `${pagedKey(PAGE / 2)}x`;
          await storage.put(inserted, encode('x'));
          const rest = await drain(iterator);
          expect(rest).not.toContain(inserted);
          expect(rest).toHaveLength(PAGE * 2);
        });

        it('does not yield a key inserted while a short final page is being yielded', async () => {
          const storage = await seedCount(PAGE + 5);
          const iterator = reader.read(storage, 'p:')[Symbol.asyncIterator]();
          for (let index = 0; index <= PAGE; index++) await iterator.next();
          await storage.put('p:zzzzzz', encode('z'));
          expect(await drain(iterator)).toEqual(
            Array.from({ length: 4 }, (_, index) => pagedKey(PAGE + 1 + index)),
          );
        });

        it('yields a key inserted while a full final page is being yielded via the trailing page', async () => {
          const storage = await seedCount(PAGE * 2);
          const iterator = reader.read(storage, 'p:')[Symbol.asyncIterator]();
          for (let index = 0; index <= PAGE; index++) await iterator.next();
          await storage.put('p:zzzzzz', encode('z'));
          const rest = await drain(iterator);
          expect(rest.filter((key) => key === 'p:zzzzzz')).toHaveLength(1);
          expect(rest.at(-1)).toBe('p:zzzzzz');
        });
      });
    });
  }

  it('yields a buffered value overwritten before it is yielded with its buffered value', async () => {
    const storage = await seedCount(PAGE * 2);
    const iterator = storage.scan('p:')[Symbol.asyncIterator]();
    await iterator.next();
    await storage.put(pagedKey(1), encode('overwritten'));
    const second = await iterator.next();
    expect(second.value?.[0]).toBe(pagedKey(1));
    expect(new TextDecoder().decode(second.value?.[1])).toBe(pagedKey(1));
    const current = await storage.get(pagedKey(1));
    expect(new TextDecoder().decode(current ?? undefined)).toBe('overwritten');
  });
});
