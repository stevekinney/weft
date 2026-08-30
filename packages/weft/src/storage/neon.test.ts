import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'bun:test';

import { NeonStorage } from './neon.ts';
import { createPGliteTestFixture, pgliteAsPostgresPool } from './pglite.test-support.ts';
import type { PostgresPool } from './postgres.ts';
import {
  collect,
  decodeText,
  bytes as encode,
  runBasicStorageContract,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

const pgliteFixture = createPGliteTestFixture();

/**
 * Construct a NeonStorage over the shared PGlite, resetting the table first so
 * each case starts from an empty store. `NeonStorage.#ensureTable` creates the
 * table on first use; truncating here is enough to isolate cases.
 */
async function createPgliteBackedNeonStorage(): Promise<NeonStorage> {
  await pgliteFixture.reset();
  return new NeonStorage({ url: 'pglite://memory', pool: pgliteFixture.pool });
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

  // #469: the collapsed batch resolves to a net effect per key. A naive
  // multi-row upsert would raise "ON CONFLICT DO UPDATE cannot affect row a
  // second time" for a key written twice; net-effect resolution dedups it.
  it('batch with a key written twice keeps the last value (#469)', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.batch([
      { type: 'put', key: 'dup', value: encode('first') },
      { type: 'put', key: 'dup', value: encode('second') },
    ]);
    expect(decodeText((await storage.get('dup'))!)).toBe('second');
  });

  it('batch with a put then a delete on one key nets to absent (#469)', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('existing', encode('was-here'));
    await storage.batch([
      { type: 'put', key: 'existing', value: encode('rewritten') },
      { type: 'delete', key: 'existing' },
    ]);
    expect(await storage.get('existing')).toBeNull();
  });

  it('batch with a delete then a put on one key nets to the put (#469)', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('k', encode('old'));
    await storage.batch([
      { type: 'delete', key: 'k' },
      { type: 'put', key: 'k', value: encode('new') },
    ]);
    expect(decodeText((await storage.get('k'))!)).toBe('new');
  });

  it('batch applies many puts and deletes in one collapsed transaction (#469)', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('del:1', encode('1'));
    await storage.put('del:2', encode('2'));
    await storage.batch([
      { type: 'put', key: 'put:a', value: encode('a') },
      { type: 'put', key: 'put:b', value: encode('b') },
      { type: 'put', key: 'put:c', value: encode('c') },
      { type: 'delete', key: 'del:1' },
      { type: 'delete', key: 'del:2' },
    ]);
    expect(decodeText((await storage.get('put:a'))!)).toBe('a');
    expect(decodeText((await storage.get('put:c'))!)).toBe('c');
    expect(await storage.get('del:1')).toBeNull();
    expect(await storage.get('del:2')).toBeNull();
  });

  it('conditionalBatch evaluates multiple conditions in one collapsed read (#469)', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('cond:present', encode('here'));
    // Two conditions, mixed present/absent, both must hold for the write.
    const applied = await storage.conditionalBatch(
      [
        { key: 'cond:present', expectedValue: encode('here') },
        { key: 'cond:absent', expectedValue: null },
      ],
      [{ type: 'put', key: 'cond:written', value: encode('ok') }],
    );
    expect(applied).toBe(true);
    expect(decodeText((await storage.get('cond:written'))!)).toBe('ok');
  });

  it('conditionalBatch rejects when one of several conditions fails (#469)', async () => {
    await using storage = await createPgliteBackedNeonStorage();
    await storage.put('cond:a', encode('a'));
    await storage.put('cond:b', encode('b'));
    const applied = await storage.conditionalBatch(
      [
        { key: 'cond:a', expectedValue: encode('a') },
        { key: 'cond:b', expectedValue: encode('WRONG') },
      ],
      [{ type: 'put', key: 'cond:written', value: encode('ok') }],
    );
    expect(applied).toBe(false);
    expect(await storage.get('cond:written')).toBeNull();
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
    try {
      await database.query('CREATE TABLE kv (key TEXT PRIMARY KEY, value BYTEA NOT NULL)');
      const pool: PostgresPool = {
        query: (sql, parameters) => database.query(sql, parameters as unknown[]),
        connect: async () => ({
          query: (sql, parameters) => database.query(sql, parameters as unknown[]),
          release: () => {},
        }),
        end: async () => {},
      };
      // The pool is injected, so it stays caller-owned and disposal never calls
      // end(); close the dedicated instance directly in finally.
      await using storage = new NeonStorage({ url: 'pglite://memory', pool });
      await expect(storage.put('k', encode('v'))).rejects.toThrow('COLLATE "C"');
    } finally {
      await database.close();
    }
  });

  it('throws when the collation introspection returns no row', async () => {
    // Defensive: if the introspection somehow finds no kv.key row, treat the
    // unknowable collation as a hard error rather than assume it is correct.
    const pool: PostgresPool = {
      query: async (sql) => (sql.includes('pg_collation') ? { rows: [] } : { rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {},
    };
    await using storage = new NeonStorage({ url: 'stub://', pool });
    await expect(storage.put('k', encode('v'))).rejects.toThrow('no such table');
  });

  it('retries initialization after a transient failure rather than wedging on a cached rejection', async () => {
    // #ensureTable memoizes the init promise but must clear it on rejection: a
    // dropped connection mid-CREATE should not permanently fail every later
    // operation. The first query (the CREATE) throws once; the next operation
    // must re-run init and succeed.
    let createAttempts = 0;
    const database = await new PGlite();
    try {
      const failingPool: PostgresPool = {
        query: (sql, parameters) => {
          if (sql.includes('CREATE TABLE IF NOT EXISTS')) {
            createAttempts += 1;
            if (createAttempts === 1) {
              return Promise.reject(new Error('connection dropped mid-CREATE'));
            }
          }
          return database.query(sql, parameters as unknown[]);
        },
        connect: async () => ({
          query: (sql, parameters) => database.query(sql, parameters as unknown[]),
          release: () => {},
        }),
        end: async () => {},
      };
      // The pool is injected (caller-owned), so disposal never calls end(); close
      // the dedicated instance directly in finally.
      await using storage = new NeonStorage({ url: 'pglite://memory', pool: failingPool });

      // First operation triggers init, which fails on the CREATE.
      await expect(storage.put('k', encode('v'))).rejects.toThrow('connection dropped mid-CREATE');
      // Second operation must retry init (proving the rejected promise was cleared)
      // and succeed end-to-end.
      await storage.put('k', encode('v'));
      expect(decodeText((await storage.get('k'))!)).toBe('v');
      expect(createAttempts).toBe(2);
    } finally {
      await database.close();
    }
  });

  it('preserves the original failure when a transaction ROLLBACK itself fails', async () => {
    // #withTransaction swallows a ROLLBACK error so the original operation error
    // (the real cause) propagates instead of being masked by a secondary rollback
    // failure. Stage a client whose BEGIN succeeds, whose operation throws, and
    // whose ROLLBACK also rejects — the caller must see the operation error.
    const operationError = new Error('operation failed inside the transaction');
    const pool: PostgresPool = {
      // #ensureTable runs on the pool directly: CREATE succeeds, collation is "C".
      query: async (sql) =>
        sql.includes('pg_collation') ? { rows: [{ collation: 'C' }] } : { rows: [] },
      connect: async () => ({
        query: async (sql) => {
          if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED') return { rows: [] };
          if (sql === 'ROLLBACK') throw new Error('rollback also failed');
          // The batched operation statement throws — triggering the rollback path.
          throw operationError;
        },
        release: () => {},
      }),
      end: async () => {},
    };
    await using storage = new NeonStorage({ url: 'stub://', pool });
    await expect(storage.batch([{ type: 'put', key: 'k', value: encode('v') }])).rejects.toThrow(
      operationError,
    );
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
    const stubPool: PostgresPool = {
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
    const stubPool: PostgresPool = {
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

  it('disposal is idempotent: a real owned pool is ended exactly once across repeated dispose', async () => {
    // The Neon Pool rejects a second end() ("Called end on pool more than once").
    // Memoized shutdown means repeated disposal — sync then async, or either
    // twice — reuses the one end() and never triggers that rejection.
    const storage = new NeonStorage({
      url: 'postgresql://user:pass@nonexistent.invalid/db',
    });
    storage[Symbol.dispose]();
    expect(() => storage[Symbol.dispose]()).not.toThrow();
    // A following async dispose awaits the same memoized shutdown and resolves.
    await expect(storage[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it('async disposal is idempotent across repeated calls', async () => {
    const storage = new NeonStorage({
      url: 'postgresql://user:pass@nonexistent.invalid/db',
    });
    await expect(storage[Symbol.asyncDispose]()).resolves.toBeUndefined();
    await expect(storage[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it('swallows a teardown error from an owned pool on synchronous dispose', async () => {
    // Synchronous [Symbol.dispose] fires the async owned-pool shutdown and swallows
    // any rejection, so a failing end() never surfaces as an unhandled rejection or
    // a thrown dispose. The internal poolFactory seam constructs an owned pool whose
    // end() rejects, without contacting any network.
    let endCalled = false;
    const failingOwnedPool: PostgresPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {
        endCalled = true;
        throw new Error('pool teardown failed');
      },
    };
    const storage = new NeonStorage({ url: 'stub://' }, () => failingOwnedPool);
    expect(() => storage[Symbol.dispose]()).not.toThrow();
    // Let the swallowed end() rejection settle; it must not escape.
    await Promise.resolve();
    await Promise.resolve();
    expect(endCalled).toBe(true);
  });

  it('propagates a teardown error from an owned pool on async dispose', async () => {
    // The async path awaits the same owned-pool shutdown, so a failing end() DOES
    // surface here (unlike the fire-and-forget sync path). Repeated async dispose
    // reuses the one memoized (rejected) shutdown rather than calling end() again.
    let endCalls = 0;
    const failingOwnedPool: PostgresPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {
        endCalls += 1;
        throw new Error('pool teardown failed');
      },
    };
    const storage = new NeonStorage({ url: 'stub://' }, () => failingOwnedPool);
    await expect(storage[Symbol.asyncDispose]()).rejects.toThrow('pool teardown failed');
    await expect(storage[Symbol.asyncDispose]()).rejects.toThrow('pool teardown failed');
    expect(endCalls).toBe(1);
  });
});

describe('NeonStorage configurable schema/table (#468)', () => {
  it('creates the schema, qualifies the table, and round-trips values', async () => {
    const database = await new PGlite();
    try {
      await using storage = new NeonStorage({
        url: 'pglite://memory',
        pool: pgliteAsPostgresPool(database),
        schema: 'weft',
        table: 'state',
      });
      await storage.put('k', encode('v'));
      expect(decodeText((await storage.get('k'))!)).toBe('v');

      // The data lives in the qualified "weft"."state" table, not public.kv.
      const inSchema = await database.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM "weft"."state"`,
      );
      expect(Number(inSchema.rows[0]?.count)).toBe(1);
      const publicTable = await database.query<{ exists: boolean }>(
        `SELECT to_regclass('public.kv') IS NOT NULL AS exists`,
      );
      expect(publicTable.rows[0]?.exists).toBe(false);
    } finally {
      await database.close();
    }
  });

  it('honors a custom unqualified table name (resolved via search_path)', async () => {
    const database = await new PGlite();
    try {
      await using storage = new NeonStorage({
        url: 'pglite://memory',
        pool: pgliteAsPostgresPool(database),
        table: 'workflow_kv',
      });
      await storage.put('k', encode('v'));
      const result = await database.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM "workflow_kv"`,
      );
      expect(Number(result.rows[0]?.count)).toBe(1);
    } finally {
      await database.close();
    }
  });

  it('collapsed batch writes target the configured table', async () => {
    const database = await new PGlite();
    try {
      await using storage = new NeonStorage({
        url: 'pglite://memory',
        pool: pgliteAsPostgresPool(database),
        schema: 'weft',
      });
      await storage.batch([
        { type: 'put', key: 'a', value: encode('1') },
        { type: 'put', key: 'b', value: encode('2') },
      ]);
      const result = await database.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM "weft"."kv"`,
      );
      expect(Number(result.rows[0]?.count)).toBe(2);
    } finally {
      await database.close();
    }
  });

  it('rejects an invalid schema or table identifier at construction', () => {
    const stubPool: PostgresPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {},
    };
    expect(() => new NeonStorage({ url: 'stub://', pool: stubPool, table: 'bad name' })).toThrow(
      /not a valid Postgres identifier/,
    );
    expect(
      () => new NeonStorage({ url: 'stub://', pool: stubPool, schema: 'bad; DROP TABLE kv' }),
    ).toThrow(/not a valid Postgres identifier/);
  });
});
