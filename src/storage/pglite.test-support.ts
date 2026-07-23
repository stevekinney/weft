import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll } from 'bun:test';

import type { PostgresPool, PostgresPoolClient } from './postgres.ts';

/**
 * A PGlite-backed Postgres pool for storage adapter tests. The adapter shares a
 * single connection, so `end()` is intentionally a no-op and the owning test
 * fixture remains responsible for closing the database.
 */
export function pgliteAsPostgresPool(database: PGlite | (() => PGlite)): PostgresPool {
  const getDatabase = typeof database === 'function' ? database : () => database;
  const client: PostgresPoolClient = {
    query: (sql, parameters) => getDatabase().query(sql, parameters as unknown[]),
    release: () => {
      // Single connection; there is nothing to return to a pool.
    },
  };
  return {
    query: (sql, parameters) => getDatabase().query(sql, parameters as unknown[]),
    connect: async () => client,
    end: async () => {
      // The owning fixture closes the database once after all cases finish.
    },
  };
}

export type PGliteTestFixture = {
  readonly database: PGlite;
  readonly pool: PostgresPool;
  reset(): Promise<void>;
};

/**
 * Own a shared in-memory Postgres for a test file. Booting PGlite is expensive,
 * so cases reuse one database and reset the shared `kv` table between runs.
 */
export function createPGliteTestFixture(): PGliteTestFixture {
  let database: PGlite | undefined;

  beforeAll(async () => {
    database = await new PGlite();
    await database.query('SELECT 1');
  });

  afterAll(async () => {
    await database?.close();
    database = undefined;
  });

  const getDatabase = (): PGlite => {
    if (!database) {
      throw new Error('PGlite test fixture is not running');
    }
    return database;
  };

  return {
    get database() {
      return getDatabase();
    },
    pool: pgliteAsPostgresPool(getDatabase),
    async reset() {
      const activeDatabase = getDatabase();
      await activeDatabase.query(
        'CREATE TABLE IF NOT EXISTS kv (key TEXT COLLATE "C" PRIMARY KEY, value BYTEA NOT NULL)',
      );
      await activeDatabase.query('DELETE FROM kv');
    },
  };
}
