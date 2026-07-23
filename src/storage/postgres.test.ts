import { describe, expect, it } from 'bun:test';

import { createPGliteTestFixture } from './pglite.test-support.ts';
import { PostgresStorage, type PostgresPool } from './postgres.ts';
import {
  bytes as encode,
  runBasicStorageContract,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

const pgliteFixture = createPGliteTestFixture();

/**
 * Construct a PostgresStorage over the shared PGlite, resetting the table first so
 * each case starts from an empty store. `PostgresKeyValueStorage.#ensureTable`
 * creates the table on first use; truncating here is enough to isolate cases.
 */
async function createPgliteBackedPostgresStorage(): Promise<PostgresStorage> {
  await pgliteFixture.reset();
  return new PostgresStorage({ pool: pgliteFixture.pool });
}

runStorageCapabilityConformance('PostgresStorage', {
  create: createPgliteBackedPostgresStorage,
  // PostgresStorage always reports the production (primary-endpoint) capability
  // row, regardless of the injected backend. PGlite's in-process behavior is a
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

runBasicStorageContract('PostgresStorage', { create: createPgliteBackedPostgresStorage });

describe('PostgresStorage', () => {
  it('accepts an injected pool without a url', async () => {
    // The native pg adapter shares the injected-pool escape hatch: with a pool
    // supplied, `url` is optional and never touched. This is the papercut fix that
    // lets a caller reuse a shared application pool without a dummy connection
    // string.
    await using storage = new PostgresStorage({ pool: pgliteFixture.pool });
    await pgliteFixture.reset();
    await storage.put('k', encode('v'));
    expect(await storage.get('k')).toEqual(encode('v'));
  });

  it('throws a clear error when neither a url nor a pool is provided', () => {
    // Without a pool to reuse and no url to build one from, there is nothing to
    // connect to — fail loudly at construction rather than later on first use.
    expect(() => new PostgresStorage({})).toThrow(/either a `url`.*or a pre-built `pool`/);
  });

  // NB: binary/NUL round-trips, COLLATE "C" ordering, atomic batch, and
  // conditionalBatch are all exercised by the conformance runners above (shared
  // base logic, identical to neon.test.ts) — not re-tested here. The cases below
  // cover only what is UNIQUE to PostgresStorage: the schema-qualified story, the
  // injected-pool ownership contract, and the `pg` driver interop.

  it('lives in its own schema alongside app tables (schema option)', async () => {
    // The headline use case: point `schema` at a dedicated Weft schema so engine
    // state shares ONE database with the application's tables (atomic with app
    // writes, one PITR line). Prove the adapter actually writes to `weft.kv`, not
    // `public.kv`.
    await pgliteFixture.database.query('DROP SCHEMA IF EXISTS weft CASCADE');
    await using storage = new PostgresStorage({
      pool: pgliteFixture.pool,
      schema: 'weft',
    });
    await storage.put('k', encode('v'));
    expect(await storage.get('k')).toEqual(encode('v'));

    const qualified = await pgliteFixture.database.query('SELECT count(*)::int AS n FROM weft.kv');
    expect((qualified.rows[0] as { n: number }).n).toBe(1);
  });

  it('does NOT close an injected (caller-owned) pool on async dispose', async () => {
    // Ownership stays with the caller for an injected pool — disposing one
    // PostgresStorage must not tear out a pool shared by other consumers.
    let endCalled = false;
    const stubPool: PostgresPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {
        endCalled = true;
      },
    };
    const storage = new PostgresStorage({ pool: stubPool });
    await storage[Symbol.asyncDispose]();
    expect(endCalled).toBe(false);
  });

  it('closes an owned pool built via the injected poolFactory on async dispose', async () => {
    // The poolFactory seam constructs an owned pool; disposal must close it
    // exactly once. This covers the owned-pool teardown path without importing the
    // real pg driver or contacting any network.
    let endCalls = 0;
    const ownedPool: PostgresPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {
        endCalls += 1;
      },
    };
    const storage = new PostgresStorage(
      { url: 'postgresql://user:pass@localhost/db' },
      () => ownedPool,
    );
    await storage[Symbol.asyncDispose]();
    expect(endCalls).toBe(1);
  });

  it('resolves a Pool constructor from the real `pg` default export (CJS-interop pin)', async () => {
    // The default pool factory relies on `import('pg').then(({ default: pg }) =>
    // new pg.Pool(...))`. If pg's CJS/ESM interop shape ever shifts, that breaks at
    // runtime for real users only — this pins it against the actual installed
    // driver. Constructing a Pool opens no socket, and end() on a never-queried
    // pool resolves cleanly, so this needs no database.
    const { default: pg } = await import('pg');
    expect(typeof pg.Pool).toBe('function');
    const pool = new pg.Pool({ connectionString: 'postgresql://u:p@localhost:5432/db' });
    await pool.end();
  });
});

/**
 * Opt-in integration suite against a real Postgres via the `pg` driver. Skipped
 * by default so CI and `bun test` never require a database; set
 * `WEFT_TEST_POSTGRES_URL` (point it at a primary endpoint) to run it. This is the
 * only place the real `pg` wire protocol — TCP connection, BYTEA marshalling, and
 * SERIALIZABLE conflict handling — is exercised end to end.
 */
const POSTGRES_URL = process.env['WEFT_TEST_POSTGRES_URL'];

describe.skipIf(!POSTGRES_URL)('PostgresStorage (live pg)', () => {
  // A dedicated table so a mistakenly-supplied production URL can't be wiped by the
  // reset below — and so the live suite exercises the `table` option over the real
  // driver for free.
  const LIVE_TABLE = 'weft_test_kv';

  async function createLivePostgresStorage(): Promise<PostgresStorage> {
    const storage = new PostgresStorage({ url: POSTGRES_URL!, table: LIVE_TABLE });
    // Reset only this suite's table so each case starts from an empty store.
    await storage.put('__reset__', new Uint8Array([0]));
    await storage.deletePrefix('');
    return storage;
  }

  it('round-trips put/get and scan over the real driver', async () => {
    await using storage = await createLivePostgresStorage();
    await storage.put('live:a', encode('a'));
    await storage.put('live:b', encode('b'));
    expect(await storage.get('live:a')).toEqual(encode('a'));
    const keys: string[] = [];
    for await (const key of storage.keys('live:')) {
      keys.push(key);
    }
    expect(keys).toEqual(['live:a', 'live:b']);
    await storage.deletePrefix('live:');
  });

  it('applies a mixed batch as one atomic transaction over the real driver', async () => {
    await using storage = await createLivePostgresStorage();
    await storage.put('batch:gone', encode('seed'));
    await storage.batch([
      { type: 'put', key: 'batch:kept', value: encode('value') },
      { type: 'delete', key: 'batch:gone' },
    ]);
    expect(await storage.get('batch:kept')).toEqual(encode('value'));
    expect(await storage.get('batch:gone')).toBeNull();
    await storage.deletePrefix('batch:');
  });
});
