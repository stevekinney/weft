import type { PGlite } from '@electric-sql/pglite';

import type { PostgresPool, PostgresPoolClient } from '../sql/postgres-pool.ts';

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
