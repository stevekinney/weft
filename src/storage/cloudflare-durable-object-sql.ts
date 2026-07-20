/**
 * Minimal structural view of a Cloudflare Durable Object's `ctx.storage.sql`
 * binding.
 *
 * Deliberately hand-written instead of importing `@cloudflare/workers-types`:
 * the real binding's `.exec()` method is synchronous (it runs against
 * transactional local storage with no I/O wait), and this structural
 * interface only needs the slice of that surface the adapter actually calls.
 * Any object satisfying this shape — the real Durable Object binding, or a
 * test double backed by `bun:sqlite` — works as `sql`.
 *
 * @module storage/cloudflare-durable-object-sql
 */

/**
 * The value types a Durable Object SQL column can hold.
 *
 * @example
 * ```ts
 * import type { SqlStorageValue } from '@lostgradient/weft/storage/cloudflare';
 *
 * const bound: SqlStorageValue = 'a bound query parameter';
 * void bound;
 * ```
 */
export type SqlStorageValue = ArrayBuffer | string | number | null;

/**
 * The lazily-iterated result of one `Sql.exec()` call. Matches the subset of
 * Cloudflare's `SqlStorageCursor` this adapter reads: row iteration.
 *
 * Deliberately omits `rowsWritten`: on the real Durable Object binding that
 * field is a billing counter that also counts index writes, not a logical
 * rows-affected count — this `kv` table's implicit primary-key index means a
 * single-row `DELETE` can report more than one. `deletePrefix()` and
 * `deleteRange()` instead read the logical count with a same-connection
 * `SELECT changes()` query run immediately after the write, with no `await`
 * in between (see `cloudflare.ts`).
 *
 * On the real binding, `exec()` runs the statement immediately — iterating
 * only consumes the already-computed result, it does not defer execution.
 *
 * @example
 * ```ts
 * import type { Sql, SqlStorageCursor } from '@lostgradient/weft/storage/cloudflare';
 *
 * declare const sql: Sql;
 * const cursor: SqlStorageCursor<{ key: string }> = sql.exec('SELECT key FROM kv');
 * const rows = [...cursor];
 * void rows;
 * ```
 */
export type SqlStorageCursor<T = Record<string, SqlStorageValue>> = Iterable<T>;

/**
 * The structural shape of a Cloudflare Durable Object's `ctx.storage.sql`
 * binding that this adapter depends on.
 *
 * `exec()` is synchronous by contract: Durable Object storage operations are
 * transactional only up to the next `await` in the calling code, so every
 * code path in {@link CloudflareDurableObjectSQLiteStorage} that needs that
 * guarantee (`conditionalBatch`'s read-compare-write, `batch`'s multi-write,
 * `scan`'s snapshot read) calls `exec()` with no `await` in between.
 *
 * @example
 * ```ts
 * import { CloudflareDurableObjectSQLiteStorage, type Sql } from '@lostgradient/weft/storage/cloudflare';
 *
 * // Injected by the Durable Object runtime: `ctx.storage.sql` inside a
 * // `DurableObject` subclass.
 * declare const sql: Sql;
 * const storage = new CloudflareDurableObjectSQLiteStorage({ sql });
 * void storage;
 * ```
 */
export interface Sql {
  exec<T = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<T>;
}
