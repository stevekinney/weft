import { describe, expect, it } from 'bun:test';

import { storageConditionalBatch } from './interface.ts';
import { NeonStorage } from './neon.ts';
import {
  bytes as encode,
  runBasicStorageContract,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

/**
 * Live Neon test suite. These tests exercise the real `@neondatabase/serverless`
 * pool against an actual Postgres endpoint, which the in-process PGlite suite
 * (neon.test.ts) cannot do: only a real multi-connection pool can stage genuine
 * concurrent compare-and-swap contention and prove the `SERIALIZABLE` + 40001
 * retry path under real conflict.
 *
 * They run ONLY when `NEON_DATABASE_URL` is set (point it at a primary endpoint,
 * not a read replica — see `NeonStorage.capabilities()`); otherwise they skip
 * cleanly so the default `bun test` and CI never require a remote database. The
 * concurrency design is therefore NOT covered by CI line-coverage; the in-process
 * suite covers correctness of the SQL/byte handling and the retry orchestration
 * (via a fault-injecting stub in neon-retry.test.ts), while this suite is the
 * only place real contention is observed.
 *
 * Every adapter shares the single `kv` table on the remote endpoint (unlike the
 * PGlite suite, where each case gets a fresh in-process database), so `create()`
 * truncates the table first to isolate cases that scan the whole keyspace.
 */
const NEON_DATABASE_URL = process.env['NEON_DATABASE_URL'];
const describeLive = NEON_DATABASE_URL ? describe : describe.skip;

async function createLiveNeonStorage(): Promise<NeonStorage> {
  const storage = new NeonStorage({ url: NEON_DATABASE_URL! });
  // Reset the shared remote table so each case starts from an empty store. The
  // adapter's #ensureTable creates the table on first use; a put-then-delete via
  // the public surface both guarantees the table exists and clears it.
  await storage.put('__reset__', new Uint8Array([0]));
  await storage.deletePrefix('');
  return storage;
}

if (NEON_DATABASE_URL) {
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
    // A real Neon pool can stage two concurrent write transactions, so the
    // contention case in the conformance suite runs here (unlike the PGlite suite).
    supportsConcurrentWrites: true,
  });

  runBasicStorageContract('NeonStorage (live)', { create: createLiveNeonStorage });
}

describeLive('NeonStorage (live) concurrent compare-and-swap', () => {
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

describeLive('NeonStorage (live) collapsed batch round trips', () => {
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
