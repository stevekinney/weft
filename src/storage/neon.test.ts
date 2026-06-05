import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'bun:test';

import { NeonStorage, type NeonPool, type NeonPoolClient } from './neon.ts';
import {
  collect,
  decodeText,
  bytes as encode,
  runBasicStorageContract,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

/**
 * A single PGlite instance is booted once at module evaluation and shared by
 * every case in this file, for two reasons:
 *
 * 1. **Speed.** A fresh PGlite is a full WASM Postgres boot (~hundreds of ms).
 *    Booting one and resetting it between cases keeps the suite fast instead of
 *    re-booting per test.
 * 2. **Test isolation against a Bun `mock.module` leak.** `node-sqlite.test.ts`
 *    calls `mock.module('node:module', ...)` to simulate a missing native
 *    binding. Bun patches the CJS module loader process-wide and `mock.restore()`
 *    does not fully revert it, so any PGlite booted *after* that test runs hits a
 *    poisoned `require("url").fileURLToPath` inside its WASM glue and throws. A
 *    PGlite already booted before the poisoning keeps working, so booting once at
 *    module-eval (the import phase, before any test body runs) sidesteps the leak
 *    entirely. Constructing a new PGlite per case would reintroduce the failure.
 *
 * The boot uses a top-level await so module evaluation does not finish until the
 * instance is ready.
 */
const sharedDatabase = await new PGlite();
await sharedDatabase.query('SELECT 1');

afterAll(async () => {
  await sharedDatabase.close();
});

/**
 * Wrap the shared PGlite instance as a {@link NeonPool}. PGlite is a real
 * in-process Postgres, so this exercises the actual `$1`/BYTEA/`ON CONFLICT`/range
 * SQL and the `COLLATE "C"` ordering that a JS-map fake would silently get wrong.
 * PGlite serializes statements on one connection, so an interactive
 * `BEGIN`/`COMMIT` driven through plain `query()` is safe and `connect()` hands
 * back the same instance with a no-op `release()`. `end()` is a no-op because the
 * shared instance outlives any single case and is closed once in `afterAll`.
 */
function sharedPgliteAsNeonPool(): NeonPool {
  const client: NeonPoolClient = {
    query: (sql, parameters) => sharedDatabase.query(sql, parameters as unknown[]),
    release: () => {
      // Single shared connection; nothing to return to a pool.
    },
  };
  return {
    query: (sql, parameters) => sharedDatabase.query(sql, parameters as unknown[]),
    connect: async () => client,
    end: async () => {
      // The shared instance is closed once in afterAll, not per dispose.
    },
  };
}

/**
 * Construct a NeonStorage over the shared PGlite, resetting the table first so
 * each case starts from an empty store. `NeonStorage.#ensureTable` creates the
 * table on first use; truncating here is enough to isolate cases.
 */
async function createPgliteBackedNeonStorage(): Promise<NeonStorage> {
  await sharedDatabase.query(
    'CREATE TABLE IF NOT EXISTS kv (key TEXT COLLATE "C" PRIMARY KEY, value BYTEA NOT NULL)',
  );
  await sharedDatabase.query('DELETE FROM kv');
  return new NeonStorage({ url: 'pglite://memory', pool: sharedPgliteAsNeonPool() });
}

runStorageCapabilityConformance('NeonStorage', {
  create: createPgliteBackedNeonStorage,
  // NeonStorage always reports the production (primary-endpoint) capability row,
  // regardless of the injected backend. PGlite's in-process behavior is a
  // superset of these claims, so the behavioral cases pass.
  expected: {
    persistence: 'remote',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
  // PGlite serializes on a single connection, so the concurrent-CAS-contention
  // case cannot be staged here. Real concurrency is covered in neon-live.test.ts
  // against an actual Neon endpoint.
  supportsConcurrentWrites: false,
});

runBasicStorageContract('NeonStorage', { create: createPgliteBackedNeonStorage });

describe('NeonStorage', () => {
  it('round-trips binary values including embedded NULs', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    const binary = new Uint8Array([0, 1, 127, 128, 255, 42, 0, 13, 10]);
    await storage.put('binary', binary);
    expect(await storage.get('binary')).toEqual(binary);
  });

  it('round-trips an empty byte value as an empty array, not null', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('empty', new Uint8Array([]));
    const result = await storage.get('empty');
    expect(result).not.toBeNull();
    expect(result).toEqual(new Uint8Array([]));
  });

  it('returns null for an absent key', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    expect(await storage.get('missing')).toBeNull();
  });

  it('orders punctuated keys by byte value (COLLATE "C")', async () => {
    // wf-idx-... ('-' = 0x2d) must sort before wf:... (':' = 0x3a). A locale
    // collation would reorder these and break prefix-range scans; the C collation
    // restores byte ordering. This is the behavioral counterpart to the DDL pin.
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('wf:z', encode('z'));
    await storage.put('wf-idx:a', encode('a'));
    const entries = await collect(storage.scan('wf'));
    expect(entries.map(([key]) => key)).toEqual(['wf-idx:a', 'wf:z']);
  });

  it('has() reflects key presence', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('present', encode('1'));
    expect(await storage.has('present')).toBe(true);
    expect(await storage.has('absent')).toBe(false);
  });

  it('count() and keys() report the prefix contents', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('p:1', encode('1'));
    await storage.put('p:2', encode('2'));
    await storage.put('other', encode('x'));
    expect(await storage.count('p:')).toBe(2);
    expect(await collect(storage.keys('p:'))).toEqual(['p:1', 'p:2']);
  });

  it('deletePrefix removes every key under the prefix and returns the count', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('q:c', encode('c'));
    expect(await storage.deletePrefix('p:')).toBe(2);
    expect(await storage.get('p:a')).toBeNull();
    expect(await storage.get('q:c')).not.toBeNull();
  });

  it('deleteRange deletes only the bounded keys and returns the count', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    for (const sequence of [1, 2, 3, 4]) {
      await storage.put(`ev:${String(sequence).padStart(2, '0')}`, encode(String(sequence)));
    }
    const deleted = await storage.deleteRange('ev:', { lt: 'ev:03' });
    expect(deleted).toBe(2);
    expect(await storage.get('ev:01')).toBeNull();
    expect(await storage.get('ev:02')).toBeNull();
    expect(await storage.get('ev:03')).not.toBeNull();
  });

  it('deleteRange with a limit deletes the lowest keys first', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    for (const sequence of [1, 2, 3, 4]) {
      await storage.put(`ev:${String(sequence).padStart(2, '0')}`, encode(String(sequence)));
    }
    expect(await storage.deleteRange('ev:', { lt: 'ev:09', limit: 2 })).toBe(2);
    expect(await storage.get('ev:01')).toBeNull();
    expect(await storage.get('ev:02')).toBeNull();
    expect(await storage.get('ev:03')).not.toBeNull();
  });

  it('batch applies puts and deletes atomically', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('keep', encode('keep'));
    await storage.put('remove', encode('remove'));
    await storage.batch([
      { type: 'put', key: 'added', value: encode('added') },
      { type: 'delete', key: 'remove' },
    ]);
    expect(decodeText((await storage.get('keep'))!)).toBe('keep');
    expect(await storage.get('remove')).toBeNull();
    expect(decodeText((await storage.get('added'))!)).toBe('added');
  });

  it('batch with an empty array is a no-op', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('key', encode('value'));
    await storage.batch([]);
    expect(decodeText((await storage.get('key'))!)).toBe('value');
  });

  it('conditionalBatch commits when an absent-key precondition holds', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    const applied = await storage.conditionalBatch(
      [{ key: 'idem:k', expectedValue: null }],
      [{ type: 'put', key: 'idem:k', value: encode('first') }],
    );
    expect(applied).toBe(true);
    expect(decodeText((await storage.get('idem:k'))!)).toBe('first');
  });

  it('conditionalBatch rejects when an absent-key precondition is violated', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('idem:k', encode('existing'));
    const applied = await storage.conditionalBatch(
      [{ key: 'idem:k', expectedValue: null }],
      [{ type: 'put', key: 'idem:k', value: encode('second') }],
    );
    expect(applied).toBe(false);
    expect(decodeText((await storage.get('idem:k'))!)).toBe('existing');
  });

  it('query rejects non-read-only SQL', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await expect(storage.query('DELETE FROM kv')).rejects.toThrow();
  });

  it('query runs read-only passthrough SQL', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('q:1', encode('one'));
    const rows = await storage.query<{ key: string }>('SELECT key FROM kv ORDER BY key');
    expect(rows.map((row) => row.key)).toEqual(['q:1']);
  });

  it('query rejects a data-modifying CTE that the textual check misses', async () => {
    // `WITH x AS (DELETE ... RETURNING ...) SELECT * FROM x` reads as a SELECT to
    // the textual gate but mutates. Running passthrough inside BEGIN READ ONLY
    // makes Postgres reject it at the database level, and the row survives.
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('cte:1', encode('keep'));
    await expect(
      storage.query('WITH removed AS (DELETE FROM kv RETURNING key) SELECT key FROM removed'),
    ).rejects.toThrow();
    // The row must still be present — the CTE delete was blocked.
    expect(decodeText((await storage.get('cte:1'))!)).toBe('keep');
  });

  it('throws an actionable error when a pre-existing kv table lacks COLLATE "C"', async () => {
    // `CREATE TABLE IF NOT EXISTS` is a no-op against a foreign kv table; a table
    // created with the database default collation would silently break prefix
    // scans. The adapter must detect the wrong collation and refuse to operate.
    // A dedicated PGlite is used so the shared (correctly-collated) instance is untouched.
    const database = await new PGlite();
    await database.query('CREATE TABLE kv (key TEXT PRIMARY KEY, value BYTEA NOT NULL)');
    const pool: NeonPool = {
      query: (sql, parameters) => database.query(sql, parameters as unknown[]),
      connect: async () => ({
        query: (sql, parameters) => database.query(sql, parameters as unknown[]),
        release: () => {},
      }),
      end: async () => {
        await database.close();
      },
    };
    await using storage = new NeonStorage({ url: 'pglite://memory', pool });
    await expect(storage.put('k', encode('v'))).rejects.toThrow('COLLATE "C"');
  });

  it('throws when the collation introspection returns no row', async () => {
    // Defensive: if the introspection somehow finds no kv.key row, treat the
    // unknowable collation as a hard error rather than assume it is correct.
    const pool: NeonPool = {
      query: async (sql) => (sql.includes('pg_collation') ? { rows: [] } : { rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {},
    };
    await using storage = new NeonStorage({ url: 'stub://', pool });
    await expect(storage.put('k', encode('v'))).rejects.toThrow('no kv table');
  });

  it('scoped() returns a prefix-namespaced view backed by the same store', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    const scoped = storage.scoped('tenant-a:');
    await scoped.put('key', encode('scoped-value'));
    // The scoped view reads its own key, and the underlying store sees the prefix.
    expect(decodeText((await scoped.get('key'))!)).toBe('scoped-value');
    expect(decodeText((await storage.get('tenant-a:key'))!)).toBe('scoped-value');
  });

  it('does NOT close an injected (caller-owned) pool on synchronous dispose', async () => {
    // Ownership stays with the caller for an injected pool — disposing one
    // NeonStorage must not tear out a pool shared by other consumers.
    let endCalled = false;
    const stubPool: NeonPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {
        endCalled = true;
      },
    };
    const storage = new NeonStorage({ url: 'stub://', pool: stubPool });
    expect(() => storage[Symbol.dispose]()).not.toThrow();
    await Promise.resolve();
    expect(endCalled).toBe(false);
  });

  it('does NOT close an injected pool on async dispose either', async () => {
    let endCalled = false;
    const stubPool: NeonPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {
        endCalled = true;
      },
    };
    const storage = new NeonStorage({ url: 'stub://', pool: stubPool });
    await storage[Symbol.asyncDispose]();
    expect(endCalled).toBe(false);
  });

  it('constructs a real pool lazily from a url and closes it on dispose', () => {
    // The Neon serverless Pool is lazy — constructing it touches no socket. This
    // covers the production construction branch and the owned fire-and-forget
    // dispose path in CI, with no remote endpoint. A bogus host is never contacted
    // because no query runs before dispose; pool.end() on a never-queried pool
    // resolves cleanly, so dispose never throws.
    const storage = new NeonStorage({
      url: 'postgresql://user:pass@nonexistent.invalid/db',
    });
    expect(() => storage[Symbol.dispose]()).not.toThrow();
  });

  it('closes an owned pool on async dispose', async () => {
    const storage = new NeonStorage({
      url: 'postgresql://user:pass@nonexistent.invalid/db',
    });
    // pool.end() on a never-queried lazy pool resolves cleanly.
    await expect(storage[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it('swallows a rejected pool.end() on synchronous dispose', async () => {
    // The sync dispose is fire-and-forget: a rejected end() must never surface as
    // an unhandled rejection. Disposing twice makes the owned pool's second end()
    // reject ("Called end on pool more than once"), exercising the swallow.
    const storage = new NeonStorage({
      url: 'postgresql://user:pass@nonexistent.invalid/db',
    });
    storage[Symbol.dispose]();
    expect(() => storage[Symbol.dispose]()).not.toThrow();
    // Let the swallowed rejection settle.
    await Promise.resolve();
  });
});
