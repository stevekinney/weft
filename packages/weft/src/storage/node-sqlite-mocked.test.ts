import { describe, expect, it } from 'bun:test';

import { storageCount, storageDeletePrefix, storageKeys } from './interface.ts';

type FakeRow = { key: string; value: Uint8Array };

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createFakeDatabaseConstructor() {
  return class FakeDatabase {
    readonly data = new Map<string, Uint8Array>();
    readonly pragmas: string[] = [];
    readonly execStatements: string[] = [];
    closed = false;

    pragma(source: string): void {
      this.pragmas.push(source);
    }

    exec(source: string): void {
      this.execStatements.push(source);
    }

    prepare(source: string) {
      if (source === 'SELECT value FROM kv WHERE key = ?') {
        return {
          get: (key: string): { value: Uint8Array } | undefined => {
            const value = this.data.get(key);
            return value ? { value } : undefined;
          },
          run: () => undefined,
          all: () => [],
        };
      }

      if (source.startsWith('INSERT INTO kv')) {
        return {
          run: (key: string, value: Uint8Array): void => {
            this.data.set(key, new Uint8Array(value));
          },
          get: () => undefined,
          all: () => [],
        };
      }

      if (source === 'DELETE FROM kv WHERE key = ?') {
        return {
          run: (key: string): void => {
            this.data.delete(key);
          },
          get: () => undefined,
          all: () => [],
        };
      }

      if (source.startsWith('SELECT key, value FROM kv WHERE ')) {
        return {
          run: () => undefined,
          get: () => undefined,
          all: (...parameters: unknown[]): FakeRow[] => {
            const [prefix, prefixEnd] = parameters as [string, string, ...unknown[]];
            const hasOptionalGt = source.includes(' AND key > ?');
            const hasOptionalGte = (source.match(/key >= \?/g) ?? []).length > 1;
            const hasOptionalLt = (source.match(/key < \?/g) ?? []).length > 1;
            const hasOptionalLte = source.includes(' AND key <= ?');

            const rows = [...this.data.entries()]
              .filter(([key]) => key >= prefix && key < prefixEnd)
              .filter(([key]) => {
                let parameterIndex = 2;

                if (hasOptionalGt) {
                  const gt = parameters[parameterIndex++] as string;
                  if (!(key > gt)) return false;
                }

                if (hasOptionalGte) {
                  const gte = parameters[parameterIndex++] as string;
                  if (!(key >= gte)) return false;
                }

                if (hasOptionalLt) {
                  const lt = parameters[parameterIndex++] as string;
                  if (!(key < lt)) return false;
                }

                if (hasOptionalLte) {
                  const lte = parameters[parameterIndex++] as string;
                  if (!(key <= lte)) return false;
                }

                return true;
              })
              .toSorted(([left], [right]) =>
                source.includes('ORDER BY key DESC')
                  ? compareKeys(right, left)
                  : compareKeys(left, right),
              )
              .map(([key, value]) => ({ key, value: new Uint8Array(value) }));

            if (source.includes('LIMIT ?')) {
              const limit = parameters[parameters.length - 1] as number;
              return rows.slice(0, limit);
            }

            return rows;
          },
        };
      }

      throw new Error(`Unexpected SQL in fake database: ${source}`);
    }

    transaction<TArguments extends unknown[], TResult>(fn: (...entries: TArguments) => TResult) {
      return (...entries: TArguments): TResult => {
        return fn(...entries);
      };
    }

    close(): void {
      this.closed = true;
    }
  };
}

describe('NodeSQLiteStorage with mocked better-sqlite3', () => {
  it('covers the full adapter surface without native bindings', async () => {
    const FakeDatabase = createFakeDatabaseConstructor();

    const { NodeSQLiteStorage } = await import(`./node-sqlite.ts?mocked=${Date.now()}`);

    const storage = new NodeSQLiteStorage(':memory:', FakeDatabase);
    const fileBackedStorage = new NodeSQLiteStorage('./weft.db', FakeDatabase);
    expect(fileBackedStorage.capabilities().persistence).toBe('local');
    fileBackedStorage[Symbol.dispose]();

    // Honest capability row: linearizable WAL SQLite, but no own deletePrefix
    // (derived fallback) so boundedRangeDelete is false.
    expect(storage.capabilities()).toEqual({
      persistence: 'ephemeral',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: false,
    });

    expect(await storage.get('missing')).toBeNull();

    await storage.put('a:1', new Uint8Array([1]));
    await storage.put('a:2', new Uint8Array([2]));
    await storage.put('a:3', new Uint8Array([3]));
    await storage.put('b:1', new Uint8Array([4]));

    expect(await storage.get('a:2')).toEqual(new Uint8Array([2]));

    const emptyPrefixResults: [string, Uint8Array][] = [];
    for await (const entry of storage.scan('')) {
      emptyPrefixResults.push(entry);
    }
    expect(emptyPrefixResults.map(([key]) => key)).toEqual(['a:1', 'a:2', 'a:3', 'b:1']);

    const forwardResults: [string, Uint8Array][] = [];
    for await (const entry of storage.scan('a:')) {
      forwardResults.push(entry);
    }
    expect(forwardResults.map(([key]) => key)).toEqual(['a:1', 'a:2', 'a:3']);

    const reverseResults: [string, Uint8Array][] = [];
    for await (const entry of storage.scan('a:', { reverse: true, limit: 2 })) {
      reverseResults.push(entry);
    }
    expect(reverseResults.map(([key]) => key)).toEqual(['a:3', 'a:2']);

    const gtResults: [string, Uint8Array][] = [];
    for await (const entry of storage.scan('a:', { gt: 'a:1' })) {
      gtResults.push(entry);
    }
    expect(gtResults.map(([key]) => key)).toEqual(['a:2', 'a:3']);

    const gteResults: [string, Uint8Array][] = [];
    for await (const entry of storage.scan('a:', { gte: 'a:2' })) {
      gteResults.push(entry);
    }
    expect(gteResults.map(([key]) => key)).toEqual(['a:2', 'a:3']);

    const ltResults: [string, Uint8Array][] = [];
    for await (const entry of storage.scan('a:', { lt: 'a:3' })) {
      ltResults.push(entry);
    }
    expect(ltResults.map(([key]) => key)).toEqual(['a:1', 'a:2']);

    const lteResults: [string, Uint8Array][] = [];
    for await (const entry of storage.scan('a:', { lte: 'a:2' })) {
      lteResults.push(entry);
    }
    expect(lteResults.map(([key]) => key)).toEqual(['a:1', 'a:2']);
    expect(storage.scanStatementCacheSize).toBeGreaterThanOrEqual(2);
    expect(await Array.fromAsync(storageKeys(storage, 'a:', { reverse: true, limit: 2 }))).toEqual([
      'a:3',
      'a:2',
    ]);
    expect(await storageCount(storage, 'a:')).toBe(3);
    expect(await storageDeletePrefix(storage, 'b:')).toBe(1);
    expect(await Array.fromAsync(storage.scan(''))).toEqual([
      ['a:1', new Uint8Array([1])],
      ['a:2', new Uint8Array([2])],
      ['a:3', new Uint8Array([3])],
    ]);

    await storage.batch([
      { type: 'put', key: 'batch:new', value: new Uint8Array([9]) },
      { type: 'delete', key: 'a:1' },
    ]);
    await storage.batch([]);

    expect(
      await storage.conditionalBatch(
        [{ key: 'a:2', expectedValue: new Uint8Array([2]) }],
        [{ type: 'put', key: 'conditional:new', value: new Uint8Array([8]) }],
      ),
    ).toBe(true);
    expect(await storage.get('conditional:new')).toEqual(new Uint8Array([8]));

    expect(
      await storage.conditionalBatch(
        [{ key: 'a:2', expectedValue: new Uint8Array([9]) }],
        [{ type: 'put', key: 'conditional:miss', value: new Uint8Array([7]) }],
      ),
    ).toBe(false);
    expect(await storage.get('conditional:miss')).toBeNull();

    expect(
      await storage.conditionalBatch(
        [{ key: 'a:2', expectedValue: new Uint8Array([2]) }],
        [{ type: 'delete', key: 'a:2' }],
      ),
    ).toBe(true);
    expect(await storage.get('a:2')).toBeNull();

    expect(await storage.get('batch:new')).toEqual(new Uint8Array([9]));
    expect(await storage.get('a:1')).toBeNull();

    await storage.delete('batch:new');
    expect(await storage.get('batch:new')).toBeNull();

    storage[Symbol.dispose]();
  });
});
