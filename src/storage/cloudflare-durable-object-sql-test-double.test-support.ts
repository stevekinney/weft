/**
 * Test-only implementation of the structural {@link Sql} binding
 * ({@link cloudflare-durable-object-sql.ts}), backed by `bun:sqlite`.
 *
 * Cloudflare's real `ctx.storage.sql.exec()` is synchronous, so this double
 * mirrors that exactly: no `await` anywhere in `exec()`. Row iteration comes
 * from `Statement.all()`; the affected-row count for `INSERT`/`UPDATE`/`DELETE`
 * statements comes from a same-connection `SELECT changes()` query run
 * immediately after, in the same synchronous stretch (bun:sqlite's `Database`
 * does not otherwise expose the changes count from `.all()`).
 *
 * The `.test-support.ts` suffix excludes this module from `dist/` (see
 * `tsconfig.build.json`), so the `bun:sqlite` import never leaks into the
 * published package or the portable browser/Workers bundle.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';

import type { Sql, SqlStorageCursor, SqlStorageValue } from './cloudflare-durable-object-sql.ts';

/** A {@link Sql} double plus the underlying `bun:sqlite` handle for assertions. */
export type CloudflareSqlTestDouble = Sql & {
  /** The underlying `bun:sqlite` database, exposed so tests can assert directly. */
  readonly database: Database;
};

/**
 * Construct a {@link Sql} double over a fresh in-memory `bun:sqlite` database.
 */
export function createCloudflareSqlTestDouble(): CloudflareSqlTestDouble {
  const database = new Database(':memory:');

  return {
    database,
    exec<T = Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: SqlStorageValue[]
    ): SqlStorageCursor<T> {
      // This test double's `Sql` structural type allows `ArrayBuffer` bindings
      // (mirroring the real Durable Object binding), but the adapter under
      // test only ever binds strings and numbers (base64-encoded TEXT values).
      // bun:sqlite's binding type is narrower (no bare ArrayBuffer), so the
      // cast documents that gap rather than widening bun:sqlite's own type.
      const statement = database.query<T, SQLQueryBindings[]>(query);
      const rows = statement.all(...(bindings as SQLQueryBindings[]));
      const changesRow = database.query<{ value: number }, []>('SELECT changes() AS value').get();
      const rowsWritten = changesRow?.value ?? 0;

      return {
        [Symbol.iterator]: () => rows[Symbol.iterator](),
        rowsWritten,
      };
    },
  };
}
