import { describe, expect, it } from 'bun:test';

import { Engine, workflow, type WorkflowContext } from '../index.ts';
import { flush } from '../testing/storage-backends.test-support.ts';
import { createCloudflareSqlTestDouble } from './cloudflare-durable-object-sql-test-double.test-support.ts';
import { CloudflareDurableObjectSQLiteStorage } from './cloudflare.ts';
import {
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

runStorageCapabilityConformance('CloudflareDurableObjectSQLiteStorage', {
  create: () => new CloudflareDurableObjectSQLiteStorage({ sql: createCloudflareSqlTestDouble() }),
  expected: {
    persistence: 'local',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
});

runBasicStorageContract('CloudflareDurableObjectSQLiteStorage', {
  create: () => new CloudflareDurableObjectSQLiteStorage({ sql: createCloudflareSqlTestDouble() }),
});

runBinaryAndLargeScanStorageConformance('CloudflareDurableObjectSQLiteStorage', {
  create: () => new CloudflareDurableObjectSQLiteStorage({ sql: createCloudflareSqlTestDouble() }),
});

runConcurrentConditionalBatchConformance('CloudflareDurableObjectSQLiteStorage', {
  create: () => new CloudflareDurableObjectSQLiteStorage({ sql: createCloudflareSqlTestDouble() }),
});

describe('CloudflareDurableObjectSQLiteStorage', () => {
  it('validates the table name as a strict SQL identifier at construction', () => {
    const sql = createCloudflareSqlTestDouble();
    expect(() => new CloudflareDurableObjectSQLiteStorage({ sql, table: 'bad name' })).toThrow(
      /not a valid Cloudflare Durable Object SQLite identifier/,
    );
    expect(
      () => new CloudflareDurableObjectSQLiteStorage({ sql, table: 'bad; DROP TABLE kv' }),
    ).toThrow(/not a valid Cloudflare Durable Object SQLite identifier/);
  });

  it('honors a custom table name for reads, writes, scans, and deletes', async () => {
    const sql = createCloudflareSqlTestDouble();
    const storage = new CloudflareDurableObjectSQLiteStorage({ sql, table: 'weft_state' });

    // The custom table exists and the default `kv` table does not.
    const tables = [
      ...sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ),
    ];
    expect(tables.map((row) => row.name)).toEqual(['weft_state']);

    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    expect(decode((await storage.get('p:a'))!)).toBe('a');
    const scanned = await collect(storage.scan('p:'));
    expect(scanned.map(([key]) => key)).toEqual(['p:a', 'p:b']);
    expect(await storage.deletePrefix('p:')).toBe(2);
    expect(await storage.get('p:a')).toBeNull();

    // The reads/writes above all landed in the configured table, never `kv`.
    const inConfiguredTable = [
      ...sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM weft_state'),
    ];
    expect(inConfiguredTable[0]?.count).toBe(0);
  });

  it('round-trips binary values through base64 encoding, including embedded NULs', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    const binary = new Uint8Array([0, 1, 127, 128, 255, 42, 0, 13, 10]);
    await storage.put('binary', binary);
    expect(await storage.get('binary')).toEqual(binary);
  });

  it('round-trips an empty byte value as an empty array, not null', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    await storage.put('empty', new Uint8Array([]));
    const result = await storage.get('empty');
    expect(result).not.toBeNull();
    expect(result).toEqual(new Uint8Array([]));
  });

  it('round-trips a large value (over 64KB) that spans multiple base64 chunk boundaries', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    const large = new Uint8Array(200_000);
    for (let index = 0; index < large.length; index += 1) {
      large[index] = index % 256;
    }
    await storage.put('large', large);
    expect(await storage.get('large')).toEqual(large);
  });

  it('get on an absent key returns null', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    expect(await storage.get('missing')).toBeNull();
  });

  it('has() reflects key presence', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    await storage.put('present', encode('1'));
    expect(await storage.has('present')).toBe(true);
    expect(await storage.has('absent')).toBe(false);
  });

  it('count() and keys() report the prefix contents', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    await storage.put('p:1', encode('1'));
    await storage.put('p:2', encode('2'));
    await storage.put('other', encode('x'));
    expect(await storage.count('p:')).toBe(2);
    expect(await collect(storage.keys('p:'))).toEqual(['p:1', 'p:2']);
  });

  it('deletePrefix removes every key under the prefix natively and returns the count', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('q:c', encode('c'));
    expect(await storage.deletePrefix('p:')).toBe(2);
    expect(await storage.get('p:a')).toBeNull();
    expect(await storage.get('q:c')).not.toBeNull();
  });

  it('deletePrefix on an empty prefix returns 0', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    expect(await storage.deletePrefix('nothing:')).toBe(0);
  });

  it('deleteRange deletes only the bounded keys and returns the count', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
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
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    for (const sequence of [1, 2, 3, 4]) {
      await storage.put(`ev:${String(sequence).padStart(2, '0')}`, encode(String(sequence)));
    }
    expect(await storage.deleteRange('ev:', { lt: 'ev:09', limit: 2 })).toBe(2);
    expect(await storage.get('ev:01')).toBeNull();
    expect(await storage.get('ev:02')).toBeNull();
    expect(await storage.get('ev:03')).not.toBeNull();
  });

  it('scan returns keys sorted, honoring limit/reverse/bounds', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const ascending = await collect(storage.scan('p:'));
    expect(ascending.map(([key]) => key)).toEqual(['p:a', 'p:b', 'p:c']);

    const reversed = await collect(storage.scan('p:', { reverse: true }));
    expect(reversed.map(([key]) => key)).toEqual(['p:c', 'p:b', 'p:a']);

    const limited = await collect(storage.scan('p:', { limit: 2 }));
    expect(limited.map(([key]) => key)).toEqual(['p:a', 'p:b']);
  });

  it('scan does not observe a key inserted synchronously between materialization and iteration (snapshot)', async () => {
    // A regression guard for the "no artificial await before the SQL read"
    // invariant: obtaining the iterator must eagerly run sql.exec()
    // synchronously, so a write issued right after still misses the
    // already-materialized result set.
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    await storage.put('scan:a', encode('1'));
    await storage.put('scan:b', encode('2'));

    const iterator = storage.scan('scan:')[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await storage.put('scan:c', encode('3'));

    const seen: string[] = [];
    if (!first.done) seen.push(first.value[0]);
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      seen.push(next.value[0]);
    }
    expect(seen).toEqual(['scan:a', 'scan:b']);
  });

  it('batch applies puts and deletes atomically', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    await storage.put('keep', encode('keep'));
    await storage.put('remove', encode('remove'));
    await storage.batch([
      { type: 'put', key: 'added', value: encode('added') },
      { type: 'delete', key: 'remove' },
    ]);
    expect(decode((await storage.get('keep'))!)).toBe('keep');
    expect(await storage.get('remove')).toBeNull();
    expect(decode((await storage.get('added'))!)).toBe('added');
  });

  it('batch with an empty array is a no-op', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    await storage.put('key', encode('value'));
    await storage.batch([]);
    expect(decode((await storage.get('key'))!)).toBe('value');
  });

  it('batch rejects an operation count above MAX_BATCH_OPERATIONS', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    const operations = Array.from({ length: 10_001 }, (_, index) => ({
      type: 'put' as const,
      key: `k:${index}`,
      value: encode('v'),
    }));
    await expect(storage.batch(operations)).rejects.toThrow(/exceeds MAX_BATCH_OPERATIONS/);
  });

  it('conditionalBatch commits when the precondition holds', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    const applied = await storage.conditionalBatch(
      [{ key: 'idem:k', expectedValue: null }],
      [{ type: 'put', key: 'idem:k', value: encode('first') }],
    );
    expect(applied).toBe(true);
    expect(decode((await storage.get('idem:k'))!)).toBe('first');
  });

  it('conditionalBatch applies nothing when the precondition mismatches', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    await storage.put('cas:key', encode('initial'));
    const applied = await storage.conditionalBatch(
      [{ key: 'cas:key', expectedValue: encode('wrong') }],
      [{ type: 'put', key: 'cas:key', value: encode('changed') }],
    );
    expect(applied).toBe(false);
    expect(decode((await storage.get('cas:key'))!)).toBe('initial');
  });

  it('conditionalBatch rejects an oversized condition or operation list', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    const conditions = Array.from({ length: 10_001 }, (_, index) => ({
      key: `k:${index}`,
      expectedValue: null,
    }));
    await expect(storage.conditionalBatch(conditions, [])).rejects.toThrow(
      /exceeds MAX_BATCH_OPERATIONS/,
    );
  });

  it('lets exactly one of two contending conditionalBatch calls win', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    await storage.put('cas:counter', encode('start'));
    const condition = [{ key: 'cas:counter', expectedValue: encode('start') }];

    const [first, second] = await Promise.all([
      storage.conditionalBatch(condition, [
        { type: 'put', key: 'cas:counter', value: encode('first') },
      ]),
      storage.conditionalBatch(condition, [
        { type: 'put', key: 'cas:counter', value: encode('second') },
      ]),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(decode((await storage.get('cas:counter'))!)).toBe(first ? 'first' : 'second');
  });

  it('does not tear down the injected sql binding on disposal (non-owning view)', async () => {
    const sql = createCloudflareSqlTestDouble();
    const storage = new CloudflareDurableObjectSQLiteStorage({ sql });
    await storage.put('key', encode('value'));

    expect(() => storage[Symbol.dispose]()).not.toThrow();

    // The injected sql binding still works after the adapter disposes —
    // disposal never closed or otherwise tore it down.
    const rows = [...sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', 'key')];
    expect(rows).toHaveLength(1);
  });

  it('creates the configured table before the first operation', async () => {
    const sql = createCloudflareSqlTestDouble();
    const storage = new CloudflareDurableObjectSQLiteStorage({ sql });
    await storage.put('key', encode('value'));

    const tables = [
      ...sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'",
      ),
    ];
    expect(tables).toHaveLength(1);
  });

  it('works with Engine.create({ backgroundTasks: "manual", startScheduler: false }) and engine.runMaintenance()', async () => {
    const storage = new CloudflareDurableObjectSQLiteStorage({
      sql: createCloudflareSqlTestDouble(),
    });
    const sleeper = workflow({ name: 'sleeper' }).execute(async function* (
      ctx: WorkflowContext,
    ): AsyncGenerator<unknown, string, unknown> {
      yield* ctx.sleep('1m');
      return 'awake';
    });

    await using engine = await Engine.create({
      storage,
      backgroundTasks: 'manual',
      startScheduler: false,
      workflows: { sleeper },
    });

    const handle = await engine.start('sleeper', undefined);
    await flush();
    await engine.runMaintenance(Date.now() + 60_000);

    await expect(handle.result()).resolves.toBe('awake');
  });
});
