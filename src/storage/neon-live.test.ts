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
