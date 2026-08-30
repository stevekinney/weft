import { describe, expect, it } from 'bun:test';

import { createLazyPostgresPool } from './lazy-postgres-pool.ts';
import type { PostgresPool } from './postgres-key-value-storage.ts';

/**
 * A no-op pool that records lifecycle for assertions. Stands in for a real driver
 * `Pool` so these tests exercise the lazy wrapper WITHOUT importing `pg` or opening
 * a socket — the wrapper's memoization, dispose guards, and error rewrapping are
 * the same regardless of which driver `loadPool` returns.
 */
function fakePool(record: { queries: string[]; ends: number }): PostgresPool {
  return {
    query: async (sql) => {
      record.queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
    end: async () => {
      record.ends += 1;
    },
  };
}

describe('createLazyPostgresPool', () => {
  it('imports the driver at most once and forwards the url', async () => {
    const record: { queries: string[]; ends: number } = { queries: [], ends: 0 };
    let loads = 0;
    let seenUrl: string | undefined;
    const pool = createLazyPostgresPool('postgresql://u:p@h/db', {
      driverName: 'pg',
      storageName: 'PostgresStorage',
      loadPool: async (url) => {
        loads += 1;
        seenUrl = url;
        return fakePool(record);
      },
    });

    await pool.query('SELECT 1');
    await pool.query('SELECT 2');
    await pool.connect();

    expect(loads).toBe(1); // memoized — not one import per call
    expect(seenUrl).toBe('postgresql://u:p@h/db');
    expect(record.queries).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('closes the built pool exactly once on end()', async () => {
    const record: { queries: string[]; ends: number } = { queries: [], ends: 0 };
    const pool = createLazyPostgresPool('postgresql://u:p@h/db', {
      driverName: 'pg',
      storageName: 'PostgresStorage',
      loadPool: async () => fakePool(record),
    });

    await pool.query('SELECT 1');
    await pool.end();
    await pool.end();

    expect(record.ends).toBe(1);
  });

  it('end() before first use never imports the driver and does not throw', async () => {
    let loads = 0;
    const pool = createLazyPostgresPool('postgresql://u:p@h/db', {
      driverName: 'pg',
      storageName: 'PostgresStorage',
      loadPool: async () => {
        loads += 1;
        return fakePool({ queries: [], ends: 0 });
      },
    });

    await pool.end();

    expect(loads).toBe(0);
  });

  it('throws on use after dispose instead of silently building an unreachable pool', async () => {
    const record: { queries: string[]; ends: number } = { queries: [], ends: 0 };
    let loads = 0;
    const pool = createLazyPostgresPool('postgresql://u:p@h/db', {
      driverName: 'pg',
      storageName: 'PostgresStorage',
      loadPool: async () => {
        loads += 1;
        return fakePool(record);
      },
    });

    await pool.query('SELECT 1');
    await pool.end();

    // The regression this guards: without a disposed flag, this call would import
    // a NEW pool that no future end() can reach — a connection leak that also keeps
    // the "disposed" adapter silently working.
    await expect(pool.query('SELECT 2')).rejects.toThrow(/disposed and cannot be reused/);
    expect(loads).toBe(1); // no second pool was built
  });

  it('rewraps a missing driver as an actionable install hint and allows retry', async () => {
    let attempts = 0;
    const record: { queries: string[]; ends: number } = { queries: [], ends: 0 };
    const pool = createLazyPostgresPool('postgresql://u:p@h/db', {
      driverName: 'pg',
      storageName: 'PostgresStorage',
      loadPool: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Cannot find module 'pg'");
        return fakePool(record);
      },
    });

    await expect(pool.query('SELECT 1')).rejects.toThrow(
      /PostgresStorage requires the optional peer dependency "pg".*bun add pg.*npm install pg/s,
    );

    // The rejection is not memoized: a since-installed driver works on retry.
    await pool.query('SELECT 2');
    expect(attempts).toBe(2);
    expect(record.queries).toEqual(['SELECT 2']);
  });

  it('passes a non-module load error through unchanged', async () => {
    const boom = new Error('connection refused');
    const pool = createLazyPostgresPool('postgresql://u:p@h/db', {
      driverName: 'pg',
      storageName: 'PostgresStorage',
      loadPool: async () => {
        throw boom;
      },
    });

    await expect(pool.query('SELECT 1')).rejects.toBe(boom);
  });
});
