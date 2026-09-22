import { neonConfig } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createNeonTestProxy } from './neon-proxy.test-support.ts';
import {
  createPostgresTestServer,
  postgresTestDatabase,
  type PostgresTestDatabase,
} from './postgres-server.test-support.ts';

import { restoreWorkflowCatalog } from '../core/catalog/storage-io.ts';
import { WorkflowCatalog } from '../core/catalog/workflow-catalog.ts';
import { buildWorkflowContract } from '../core/contract/build.ts';
import { buildWorkflowRevisionManifest } from '../core/contract/manifest.ts';
import { storageConditionalBatch } from './interface.ts';
import { NeonStorage } from './neon.ts';
import {
  bytes as encode,
  runBasicStorageContract,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

// Skip only when no database is obtainable: neither a supplied WEFT_TEST_POSTGRES_URL
// nor the client binaries to spawn a disposable cluster. The wrapper exists so the
// hooks below are skipped too — a file-level beforeAll runs even when every suite
// inside it is skipped, and this one opens a database.
describe.skipIf(postgresTestDatabase === null)('live Neon driver', () => {
  // Use the real Neon WebSocket driver against whichever PostgreSQL this machine can
  // reach: a disposable local cluster, or the server a CI job supplied a URL for.
  // Per the driver documentation, an ordinary PostgreSQL endpoint uses wsProxy and
  // disables password pipelining when local authentication is not password-based.
  let database: PostgresTestDatabase;
  let proxy: ReturnType<typeof createNeonTestProxy>;
  const originalConfiguration = {
    wsProxy: neonConfig.wsProxy,
    useSecureWebSocket: neonConfig.useSecureWebSocket,
    pipelineConnect: neonConfig.pipelineConnect,
  };
  beforeAll(async () => {
    database = await createPostgresTestServer();
    proxy = createNeonTestProxy({ host: database.host, port: database.port });
    neonConfig.wsProxy = () => proxy.address;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineConnect = false;
  });
  afterAll(async () => {
    Object.assign(neonConfig, originalConfiguration);
    if (proxy) await proxy[Symbol.asyncDispose]();
    if (database) {
      await dropLiveTable(database.url);
      await database[Symbol.asyncDispose]();
    }
  });

  // A dedicated table, because the database may be one this run does not own: with
  // `WEFT_TEST_POSTGRES_URL` set, the server is supplied by whoever ran it, and the
  // `deletePrefix('')` below would otherwise wipe every row of the default `kv` table
  // in a database nobody asked us to clear. The suite creates this table on first use
  // and drops it in `afterAll`, so a supplied database is left as we found it.
  const LIVE_TABLE = 'weft_test_neon_kv';

  async function createLiveNeonStorage(): Promise<NeonStorage> {
    const storage = new NeonStorage({ url: database.url, table: LIVE_TABLE });
    // Reset the suite's own table so each case starts from an empty store. The
    // adapter's #ensureTable creates the table on first use; a put-then-delete via
    // the public surface both guarantees the table exists and clears it.
    await storage.put('__reset__', new Uint8Array([0]));
    await storage.deletePrefix('');
    return storage;
  }

  /**
   * Drop the suite's table through the native driver, which reaches the database
   * directly rather than through the WebSocket proxy this suite has already disposed.
   * `LIVE_TABLE` is a literal this file owns, so interpolating it carries no untrusted
   * input; the adapter's own identifier validation covers the configured path.
   */
  async function dropLiveTable(url: string): Promise<void> {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url });
    try {
      await pool.query(`DROP TABLE IF EXISTS "${LIVE_TABLE}"`);
    } finally {
      await pool.end();
    }
  }

  runStorageCapabilityConformance('NeonStorage (live)', {
    create: createLiveNeonStorage,
    expected: {
      persistence: 'remote',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    },
  });
  runConcurrentConditionalBatchConformance('NeonStorage (live)', {
    create: createLiveNeonStorage,
  });

  runBasicStorageContract('NeonStorage (live)', { create: createLiveNeonStorage });

  describe('NeonStorage (live) concurrent compare-and-swap', () => {
    it('lets exactly one of many concurrent absent-key conditionalBatch calls win', async () => {
      // The start-idempotency CAS: N callers race to create the same key, each
      // gated on it being absent. Under SERIALIZABLE, the conflicting transactions
      // abort with 40001 and retry; the second attempt sees the key present and
      // returns false. Exactly one must commit.
      await using storage = await createLiveNeonStorage();
      const key = `start-idem:live:${crypto.randomUUID()}`;
      const contenders = Array.from({ length: 8 }, (_, index) =>
        storageConditionalBatch(
          storage,
          [{ key, expectedValue: null }],
          [{ type: 'put', key, value: encode(`winner-${index}`) }],
        ),
      );

      const outcomes = await Promise.all(contenders);
      const winners = outcomes.filter(Boolean);
      expect(winners).toHaveLength(1);

      const stored = await storage.get(key);
      expect(stored).not.toBeNull();
      await storage.deletePrefix(key);
    });
  });

  describe('NeonStorage (live) collapsed batch round trips', () => {
    // These cases run the collapsed multi-statement batch path against the real
    // `@neondatabase/serverless` driver. PGlite (neon.test.ts) green is necessary
    // but NOT sufficient here: the driver's `unnest($1::text[], $2::bytea[])` array
    // binding and the `key = ANY($1)` bulk read/delete go over the wire to a real
    // Postgres, where bytea array marshalling and SERIALIZABLE conflict detection
    // behave in ways the in-process backend cannot reproduce.

    it('applies a mixed put/put/delete/delete batch as one upsert and one bulk delete', async () => {
      // Proves the real driver round-trips the `unnest` multi-row upsert (two puts)
      // and the `key = ANY($1)` bulk delete (two deletes) in a single transaction.
      await using storage = await createLiveNeonStorage();
      const prefix = `batch:live:${crypto.randomUUID()}:`;
      const keptA = `${prefix}keep-a`;
      const keptB = `${prefix}keep-b`;
      const goneA = `${prefix}gone-a`;
      const goneB = `${prefix}gone-b`;

      // Seed the two keys the batch will delete so the bulk delete has real rows.
      await storage.put(goneA, encode('seed-a'));
      await storage.put(goneB, encode('seed-b'));

      await storage.batch([
        { type: 'put', key: keptA, value: encode('value-a') },
        { type: 'put', key: keptB, value: encode('value-b') },
        { type: 'delete', key: goneA },
        { type: 'delete', key: goneB },
      ]);

      expect(await storage.get(keptA)).toEqual(encode('value-a'));
      expect(await storage.get(keptB)).toEqual(encode('value-b'));
      expect(await storage.get(goneA)).toBeNull();
      expect(await storage.get(goneB)).toBeNull();
      await storage.deletePrefix(prefix);
    });

    it('collapses a put written twice in one batch to a single upsert row (last write wins)', async () => {
      // The net-effect resolver dedupes `put(k, a), put(k, b)` to one row before the
      // upsert. Against a real driver this proves the collapsed `unnest` never binds
      // the same key twice — Postgres rejects "ON CONFLICT DO UPDATE command cannot
      // affect row a second time" when a single INSERT names one key twice.
      await using storage = await createLiveNeonStorage();
      const key = `batch:live:dup:${crypto.randomUUID()}`;

      await storage.batch([
        { type: 'put', key, value: encode('first') },
        { type: 'put', key, value: encode('second') },
      ]);

      expect(await storage.get(key)).toEqual(encode('second'));
      await storage.deletePrefix(key);
    });

    it('evaluates a multi-condition conditionalBatch mixing present and absent preconditions in one read', async () => {
      // The collapsed precondition read fetches every condition's key with a single
      // `key = ANY($1)` query, then compares each against its expected value. Mixing
      // a present-value precondition with an absent-value one proves the real driver
      // returns the present row and omits the absent key in the same result set.
      await using storage = await createLiveNeonStorage();
      const prefix = `cbatch:live:${crypto.randomUUID()}:`;
      const present = `${prefix}present`;
      const absent = `${prefix}absent`;
      const target = `${prefix}target`;

      await storage.put(present, encode('here'));

      const applied = await storageConditionalBatch(
        storage,
        [
          { key: present, expectedValue: encode('here') },
          { key: absent, expectedValue: null },
        ],
        [{ type: 'put', key: target, value: encode('written') }],
      );
      expect(applied).toBe(true);
      expect(await storage.get(target)).toEqual(encode('written'));

      // A mismatched present precondition must reject the whole batch through the
      // same collapsed read, leaving the target untouched.
      const target2 = `${prefix}target2`;
      const rejected = await storageConditionalBatch(
        storage,
        [
          { key: present, expectedValue: encode('wrong') },
          { key: absent, expectedValue: null },
        ],
        [{ type: 'put', key: target2, value: encode('should-not-write') }],
      );
      expect(rejected).toBe(false);
      expect(await storage.get(target2)).toBeNull();
      await storage.deletePrefix(prefix);
    });
  });

  describe('NeonStorage (live) workflow catalog', () => {
    it('installs, activates, and restores catalog state against a real Postgres endpoint', async () => {
      await using storage = await createLiveNeonStorage();
      const name = `catalog-live-${crypto.randomUUID()}`;
      const contract = buildWorkflowContract({ name, version: '1.0.0' });
      const manifest = await buildWorkflowRevisionManifest(contract);

      const catalog = new WorkflowCatalog(storage);
      const pointer = await catalog.activateCandidate(name, manifest);
      expect(pointer.applied).toBe(true);

      const restored = await restoreWorkflowCatalog(storage);
      expect(restored.active.get(name)?.revision).toBe(manifest.revision);
      expect(restored.active.get(name)?.generation).toBe(1);
      expect(restored.entries.get(name)?.get(manifest.revision)?.manifest.revision).toBe(
        manifest.revision,
      );
    });
  });
});
