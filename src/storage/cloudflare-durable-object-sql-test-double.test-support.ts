/**
 * Test-only implementation of the structural {@link Sql} binding
 * ({@link cloudflare-durable-object-sql.ts}), backed by `bun:sqlite`.
 *
 * Cloudflare's real `ctx.storage.sql.exec()` is synchronous, so this double
 * mirrors that exactly: no `await` anywhere in `exec()`. Row iteration comes
 * from `Statement.all()`.
 *
 * `bun:sqlite`'s binding type (`SQLQueryBindings`) accepts `TypedArray` but
 * not a bare `ArrayBuffer`, while the real Durable Object binding's
 * `SqlStorageValue` binds and returns raw `ArrayBuffer` for `BLOB` columns.
 * This double closes that gap at the boundary: `ArrayBuffer` bindings are
 * converted to `Uint8Array` before being passed to `bun:sqlite`, and any
 * `Uint8Array` a `bun:sqlite` `BLOB` read returns is converted back to
 * `ArrayBuffer` before rows are handed to the adapter — so callers see the
 * same `SqlStorageValue` shape the real binding would produce.
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

function toSqliteBinding(value: SqlStorageValue): SQLQueryBindings {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Mirror the real Durable Object binding's read shape: a `BLOB` column comes
 * back from `bun:sqlite` as a `Uint8Array`, but `SqlStorageValue` declares
 * `ArrayBuffer` for that case, so each field is converted back at the row
 * boundary.
 */
function fromSqliteRow<T>(row: T): T {
  if (!isPlainRecord(row)) return row;

  const converted: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(row)) {
    converted[field] =
      fieldValue instanceof Uint8Array ? new Uint8Array(fieldValue).buffer : fieldValue;
  }

  // `row` is already structurally `Record<string, SqlStorageValue>` (the
  // generic default for `T`); this only replaces `Uint8Array` fields with
  // their `ArrayBuffer` equivalent, so the result satisfies the same `T`.
  return converted as T;
}

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
      const statement = database.query<T, SQLQueryBindings[]>(query);
      const rows = statement.all(...bindings.map(toSqliteBinding));

      return rows.map(fromSqliteRow);
    },
  };
}
