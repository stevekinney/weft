import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { loadBetterSqlite3ForTest } from './node-sqlite-loader.ts';
import { NodeSQLiteStorage } from './node-sqlite.ts';

const MISSING_BETTER_SQLITE_ERROR =
  'NodeSQLiteStorage requires the optional peer dependency "better-sqlite3". Install it in your application with: bun add better-sqlite3 (or npm install better-sqlite3).';

// better-sqlite3 uses native bindings that aren't supported in Bun.
// These tests are designed to run under Node.js. When running under Bun,
// they verify only that the class exists and the capability check error
// message is correct.
const IS_BUN = typeof globalThis.Bun !== 'undefined';

function canLoadBetterSqlite3(): boolean {
  try {
    new NodeSQLiteStorage(':memory:')[Symbol.dispose]();
    return true;
  } catch {
    return false;
  }
}

const AVAILABLE = !IS_BUN && canLoadBetterSqlite3();
const describeIfAvailable = AVAILABLE ? describe : describe.skip;

type FakeRow = { key: string; value: Uint8Array };

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function createFakeDatabaseConstructor() {
  let closed = false;
  const values = new Map<string, Uint8Array>();
  const preparedSql = new Set<string>();
  const pragmas: string[] = [];

  class FakeDatabase {
    pragma(source: string): void {
      pragmas.push(source);
    }

    exec(): void {}

    prepare(source: string) {
      preparedSql.add(source);

      if (source === 'SELECT value FROM kv WHERE key = ?') {
        return {
          get(key: string) {
            const value = values.get(key);
            return value ? { value } : undefined;
          },
          run() {},
          all() {
            return [];
          },
        };
      }

      if (
        source ===
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ) {
        return {
          run(key: string, value: Uint8Array) {
            values.set(key, new Uint8Array(value));
          },
          get() {
            return undefined;
          },
          all() {
            return [];
          },
        };
      }

      if (source === 'DELETE FROM kv WHERE key = ?') {
        return {
          run(key: string) {
            values.delete(key);
          },
          get() {
            return undefined;
          },
          all() {
            return [];
          },
        };
      }

      if (source.startsWith('SELECT key, value FROM kv WHERE ')) {
        return {
          run() {},
          get() {
            return undefined;
          },
          all(...parameters: unknown[]): FakeRow[] {
            let index = 0;
            const prefix = parameters[index++] as string;
            const prefixEnd = parameters[index++] as string;
            const gt = source.includes('key > ?') ? (parameters[index++] as string) : undefined;
            const gte = source.includes('key >= ? AND key < ? AND key >= ?')
              ? (parameters[index++] as string)
              : undefined;
            const lt = source.includes('key < ? AND key < ? ORDER')
              ? (parameters[index++] as string)
              : undefined;
            const lte = source.includes('key <= ?') ? (parameters[index++] as string) : undefined;
            const limit = source.includes('LIMIT ?') ? (parameters[index++] as number) : undefined;

            let rows = [...values.entries()]
              .filter(([key]) => key >= prefix && key < prefixEnd)
              .filter(([key]) => (gt === undefined ? true : key > gt))
              .filter(([key]) => (gte === undefined ? true : key >= gte))
              .filter(([key]) => (lt === undefined ? true : key < lt))
              .filter(([key]) => (lte === undefined ? true : key <= lte))
              .toSorted(([left], [right]) => compareKeys(left, right))
              .map(([key, value]) => ({ key, value: new Uint8Array(value) }));

            if (source.includes('ORDER BY key DESC')) {
              rows = rows.toReversed();
            }

            if (limit !== undefined) {
              rows = rows.slice(0, limit);
            }

            return rows;
          },
        };
      }

      throw new Error(`Unexpected SQL in fake database: ${source}`);
    }

    transaction<TArguments extends unknown[], TResult>(fn: (...entries: TArguments) => TResult) {
      return (...entries: TArguments): TResult => fn(...entries);
    }

    close(): void {
      closed = true;
    }
  }

  return {
    Database: FakeDatabase as unknown as new (path: string) => FakeDatabase,
    isClosed: () => closed,
    preparedSql,
    pragmas,
  };
}

describe('NodeSQLiteStorage', () => {
  it('throws a clear runtime error when the better-sqlite3 package is missing', () => {
    // Inject a throwing module resolver instead of mocking `node:module`. Bun's
    // `mock.module('node:module', ...)` patches the CJS loader process-wide and
    // `mock.restore()` does not revert it, which poisons `require()` for every
    // later test in the same process. The injected-resolver seam tests the same
    // missing-dependency path with no global side effect.
    expect(() =>
      loadBetterSqlite3ForTest(() => {
        const error = new Error("Cannot find module 'better-sqlite3'") as Error & { code: string };
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }),
    ).toThrow(MISSING_BETTER_SQLITE_ERROR);
  });

  it('throws a clear runtime error when the better-sqlite3 native binding fails to load', () => {
    // Simulate better-sqlite3's native binding failing to dlopen under Bun: the
    // require itself rejects with ERR_DLOPEN_FAILED. The loader recognizes this as
    // a load failure and reshapes it into the actionable peer-dependency error.
    expect(() =>
      loadBetterSqlite3ForTest(() => {
        const error = new Error("'better-sqlite3' is not yet supported in Bun.") as Error & {
          code: string;
        };
        error.code = 'ERR_DLOPEN_FAILED';
        throw error;
      }),
    ).toThrow(MISSING_BETTER_SQLITE_ERROR);
  });

  it('throws a clear runtime error when the better-sqlite3 native binding is absent', () => {
    expect(() =>
      loadBetterSqlite3ForTest(() => {
        throw new Error(
          'Could not locate the bindings file. Tried: /node_modules/better-sqlite3/build/better_sqlite3.node',
        );
      }),
    ).toThrow(MISSING_BETTER_SQLITE_ERROR);
  });

  if (IS_BUN) {
    it('throws a clear runtime error when better-sqlite3 is unavailable', () => {
      expect(() => new NodeSQLiteStorage(':memory:')).toThrow(MISSING_BETTER_SQLITE_ERROR);
    });
  }
});

describeIfAvailable('NodeSQLiteStorage (integration)', () => {
  let storage: NodeSQLiteStorage;

  beforeEach(() => {
    storage = new NodeSQLiteStorage(':memory:');
  });

  afterEach(() => {
    storage[Symbol.dispose]();
  });

  describe('get / put / delete', () => {
    it('returns null for a missing key', async () => {
      expect(await storage.get('missing')).toBeNull();
    });

    it('stores and retrieves a value', async () => {
      const value = new Uint8Array([1, 2, 3]);
      await storage.put('key1', value);
      const result = await storage.get('key1');
      expect(result).toEqual(value);
    });

    it('overwrites an existing key', async () => {
      await storage.put('key1', new Uint8Array([1]));
      await storage.put('key1', new Uint8Array([2]));
      const result = await storage.get('key1');
      expect(result).toEqual(new Uint8Array([2]));
    });

    it('deletes a key', async () => {
      await storage.put('key1', new Uint8Array([1]));
      await storage.delete('key1');
      expect(await storage.get('key1')).toBeNull();
    });

    it('delete on missing key is a no-op', async () => {
      // Should not throw.
      await storage.delete('nonexistent');
    });
  });

  describe('scan', () => {
    beforeEach(async () => {
      await storage.put('a:1', new Uint8Array([1]));
      await storage.put('a:2', new Uint8Array([2]));
      await storage.put('a:3', new Uint8Array([3]));
      await storage.put('b:1', new Uint8Array([4]));
    });

    it('scans all keys with a matching prefix', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:')) {
        results.push(entry);
      }
      expect(results).toHaveLength(3);
      expect(results[0]![0]).toBe('a:1');
      expect(results[1]![0]).toBe('a:2');
      expect(results[2]![0]).toBe('a:3');
    });

    it('respects limit', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 2 })) {
        results.push(entry);
      }
      expect(results).toHaveLength(2);
    });

    it('supports reverse ordering', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { reverse: true })) {
        results.push(entry);
      }
      expect(results[0]![0]).toBe('a:3');
      expect(results[2]![0]).toBe('a:1');
    });

    it('supports gt option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { gt: 'a:1' })) {
        results.push(entry);
      }
      expect(results).toHaveLength(2);
      expect(results[0]![0]).toBe('a:2');
    });

    it('supports lt option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { lt: 'a:3' })) {
        results.push(entry);
      }
      expect(results).toHaveLength(2);
      expect(results[1]![0]).toBe('a:2');
    });

    it('supports gte option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { gte: 'a:2' })) {
        results.push(entry);
      }
      expect(results).toHaveLength(2);
      expect(results[0]![0]).toBe('a:2');
    });

    it('supports lte option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { lte: 'a:2' })) {
        results.push(entry);
      }
      expect(results).toHaveLength(2);
      expect(results[1]![0]).toBe('a:2');
    });

    it('returns empty for non-matching prefix', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('z:')) {
        results.push(entry);
      }
      expect(results).toHaveLength(0);
    });

    it('caches scan statements', async () => {
      // Run two scans with the same shape but different parameters.
      const results1: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 1 })) {
        results1.push(entry);
      }
      const results2: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 2 })) {
        results2.push(entry);
      }

      // Same SQL shape → single cache entry.
      expect(storage.scanStatementCacheSize).toBe(1);
      expect(results1).toHaveLength(1);
      expect(results2).toHaveLength(2);
    });
  });

  describe('batch', () => {
    it('applies multiple operations atomically', async () => {
      await storage.batch([
        { type: 'put', key: 'k1', value: new Uint8Array([10]) },
        { type: 'put', key: 'k2', value: new Uint8Array([20]) },
        { type: 'put', key: 'k3', value: new Uint8Array([30]) },
      ]);

      expect(await storage.get('k1')).toEqual(new Uint8Array([10]));
      expect(await storage.get('k2')).toEqual(new Uint8Array([20]));
      expect(await storage.get('k3')).toEqual(new Uint8Array([30]));
    });

    it('handles mixed put and delete operations', async () => {
      await storage.put('existing', new Uint8Array([1]));
      await storage.batch([
        { type: 'put', key: 'new', value: new Uint8Array([2]) },
        { type: 'delete', key: 'existing' },
      ]);

      expect(await storage.get('new')).toEqual(new Uint8Array([2]));
      expect(await storage.get('existing')).toBeNull();
    });

    it('handles empty batch', async () => {
      // Should not throw.
      await storage.batch([]);
    });
  });

  describe('conditionalBatch', () => {
    it('commits operations when every condition matches', async () => {
      await storage.put('expected', new Uint8Array([1]));

      const committed = await storage.conditionalBatch(
        [{ key: 'expected', expectedValue: new Uint8Array([1]) }],
        [{ type: 'put', key: 'written', value: new Uint8Array([2]) }],
      );

      expect(committed).toBe(true);
      expect(await storage.get('written')).toEqual(new Uint8Array([2]));
    });

    it('returns false and skips writes when a condition does not match', async () => {
      await storage.put('expected', new Uint8Array([1]));

      const committed = await storage.conditionalBatch(
        [{ key: 'expected', expectedValue: new Uint8Array([9]) }],
        [{ type: 'put', key: 'skipped', value: new Uint8Array([2]) }],
      );

      expect(committed).toBe(false);
      expect(await storage.get('skipped')).toBeNull();
    });

    it('supports delete operations inside a committed conditional batch', async () => {
      await storage.put('delete-me', new Uint8Array([1]));

      const committed = await storage.conditionalBatch(
        [{ key: 'missing', expectedValue: null }],
        [{ type: 'delete', key: 'delete-me' }],
      );

      expect(committed).toBe(true);
      expect(await storage.get('delete-me')).toBeNull();
    });
  });

  describe('dispose', () => {
    it('closes the database cleanly', () => {
      const instance = new NodeSQLiteStorage(':memory:');
      // Should not throw.
      instance[Symbol.dispose]();
    });
  });
});

it('supports the adapter behavior under Bun when a database constructor is injected', async () => {
  const fake = createFakeDatabaseConstructor();
  const storage = new NodeSQLiteStorage(
    ':memory:',
    fake.Database as unknown as ConstructorParameters<typeof NodeSQLiteStorage>[1],
  );

  // capabilities() is only reachable once an instance exists; under Bun the real
  // better-sqlite3 binding cannot load, so the injected fake constructor is the
  // only way to construct an instance and exercise this method here.
  expect(storage.capabilities()).toEqual({
    persistence: 'ephemeral',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: false,
  });

  await storage.put('a:1', new Uint8Array([1]));
  await storage.put('a:2', new Uint8Array([2]));
  await storage.put('b:1', new Uint8Array([3]));

  expect(await storage.get('a:1')).toEqual(new Uint8Array([1]));
  expect(await storage.get('missing')).toBeNull();

  const allKeys: string[] = [];
  for await (const [key] of storage.scan('')) {
    allKeys.push(key);
  }
  expect(allKeys).toEqual(['a:1', 'a:2', 'b:1']);

  const forward: [string, Uint8Array][] = [];
  for await (const entry of storage.scan('a:')) {
    forward.push(entry);
  }
  expect(forward.map(([key]) => key)).toEqual(['a:1', 'a:2']);

  const reverse: string[] = [];
  for await (const [key] of storage.scan('a:', { reverse: true, limit: 1 })) {
    reverse.push(key);
  }
  expect(reverse).toEqual(['a:2']);

  expect(
    await storage.conditionalBatch(
      [{ key: 'a:1', expectedValue: new Uint8Array([1]) }],
      [{ type: 'put', key: 'a:4', value: new Uint8Array([5]) }],
    ),
  ).toBe(true);
  expect(await storage.get('a:4')).toEqual(new Uint8Array([5]));

  expect(
    await storage.conditionalBatch(
      [{ key: 'a:1', expectedValue: new Uint8Array([9]) }],
      [{ type: 'delete', key: 'a:4' }],
    ),
  ).toBe(false);
  expect(await storage.get('a:4')).toEqual(new Uint8Array([5]));

  await storage.batch([
    { type: 'put', key: 'a:3', value: new Uint8Array([4]) },
    { type: 'delete', key: 'b:1' },
  ]);

  expect(storage.scanStatementCacheSize).toBeGreaterThan(0);
  expect(await storage.get('a:3')).toEqual(new Uint8Array([4]));
  expect(await storage.get('b:1')).toBeNull();
  await storage.delete('a:2');
  expect(await storage.get('a:2')).toBeNull();

  storage[Symbol.dispose]();

  expect(fake.isClosed()).toBe(true);
  expect(fake.pragmas).toEqual([
    'journal_mode = WAL',
    'synchronous = NORMAL',
    'cache_size = -64000',
    'mmap_size = 268435456',
    'temp_store = MEMORY',
    'wal_autocheckpoint = 10000',
  ]);
  expect([...fake.preparedSql]).toContain('SELECT value FROM kv WHERE key = ?');
});
