/**
 * Cloudflare Durable Object SQLite storage adapter.
 *
 * Wraps a Durable Object's `ctx.storage.sql` binding (structurally typed as
 * {@link Sql} — see `cloudflare-durable-object-sql.ts`) in the same `Storage`
 * interface every other adapter implements, over a single key/value table.
 * `@cloudflare/workers-types` is never imported: the structural `Sql`/
 * `SqlStorageCursor` shape is enough to both type this adapter and drive it
 * in tests with a `bun:sqlite`-backed double.
 *
 * This module has zero runtime-specific imports of its own — the `sql`
 * binding is injected by the caller — so it is bundleable for Bun, Node, and
 * the Cloudflare Workers (`workerd`) runtime alike. Import from
 * `@lostgradient/weft/storage/cloudflare`.
 *
 * @module storage/cloudflare
 */

import type { Sql } from './cloudflare-durable-object-sql.ts';
import { normalizeDeleteRangeOptions, type DeleteRangeOptions } from './delete-range.ts';
import {
  assertStorageBatchOperationCount,
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from './interface.ts';
import { assertSqlIdentifier } from './sql-identifier.ts';
import {
  buildSqliteKeyRangeDelete,
  buildSqliteKeyRangeQuery,
  buildSqlitePrefixRangeParameters,
} from './sqlite-key-value-queries.ts';

export type { Sql, SqlStorageCursor, SqlStorageValue } from './cloudflare-durable-object-sql.ts';

const DEFAULT_TABLE = 'kv';

// btoa/atob operate on Latin1 strings; String.fromCharCode(...bytes) with a
// large argument list overflows the call stack, so the byte→string
// conversion runs in bounded chunks. This is the only encoding this adapter
// uses — no `Buffer`, no `node:buffer`, so it stays portable to the Workers
// runtime.
const BASE64_CHUNK_SIZE = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type ValueRow = { value: string };
type KeyValueRow = { key: string; value: string };
type KeyRow = { key: string };
type PresenceRow = { present: number };
type CountRow = { count: number };

/**
 * Configuration for {@link CloudflareDurableObjectSQLiteStorage}.
 *
 * @example
 * ```ts
 * import type { CloudflareDurableObjectSQLiteStorageOptions } from '@lostgradient/weft/storage/cloudflare';
 * import type { Sql } from '@lostgradient/weft/storage/cloudflare';
 *
 * declare const sql: Sql;
 * const options: CloudflareDurableObjectSQLiteStorageOptions = { sql, table: 'weft_kv' };
 * void options;
 * ```
 */
export type CloudflareDurableObjectSQLiteStorageOptions = {
  /** The Durable Object's `ctx.storage.sql` binding, or a structurally compatible double. */
  sql: Sql;
  /**
   * Table name for the single key/value table this adapter reads and writes.
   * Validated as a strict SQL identifier at construction; defaults to `kv`.
   */
  table?: string;
};

/**
 * Storage adapter over a Cloudflare Durable Object's `ctx.storage.sql`
 * binding.
 *
 * A **non-owning** view: the `sql` binding is injected, the Durable Object
 * owns its storage connection, and `[Symbol.dispose]` is a no-op — there is
 * nothing here to close.
 *
 * Schema is one `kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)` table (name
 * configurable via `table`). Values are stored as base64-encoded text rather
 * than `BLOB`: it keeps this adapter's SQL binding contract to the TEXT/
 * number/null value types the Durable Object SQL binding guarantees, without
 * assuming broader binary-parameter support.
 *
 * `ctx.storage.sql.exec()` is synchronous — Durable Object storage is
 * transactional only up to the next `await`/yield point in the calling code.
 * Every method here that needs that guarantee (`batch`, `conditionalBatch`,
 * `scan`) runs its `exec()` calls with no `await` in between, so a single
 * `Storage` call from this adapter is one atomic unit of Durable Object
 * storage work.
 *
 * `deletePrefix()` and `deleteRange()` are native single-statement `DELETE`s
 * (not a scan-then-batch fallback), so `capabilities().boundedRangeDelete`
 * is honestly `true`.
 *
 * @example
 * ```ts
 * import { CloudflareDurableObjectSQLiteStorage, type Sql } from '@lostgradient/weft/storage/cloudflare';
 * import { Engine, workflow, type WorkflowContext } from '@lostgradient/weft';
 *
 * // Injected by the Durable Object runtime: `ctx.storage.sql` inside a
 * // `DurableObject` subclass.
 * declare const sql: Sql;
 *
 * const storage = new CloudflareDurableObjectSQLiteStorage({ sql });
 *
 * // Durable Objects drive their own event loop; there is no host process to
 * // own background intervals, so the engine runs in manual maintenance mode
 * // and the Durable Object alarm (or a Worker Cron Trigger) drives
 * // `engine.runMaintenance()` explicitly.
 * const engine = await Engine.create({
 *   storage,
 *   backgroundTasks: 'manual',
 *   startScheduler: false,
 * });
 *
 * engine.register(
 *   workflow({ name: 'echo' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     return input;
 *   }),
 * );
 * ```
 */
export class CloudflareDurableObjectSQLiteStorage implements Storage {
  readonly #sql: Sql;
  readonly #table: string;

  constructor(options: CloudflareDurableObjectSQLiteStorageOptions) {
    const { sql, table = DEFAULT_TABLE } = options;
    assertSqlIdentifier(table, 'table', 'Cloudflare Durable Object SQLite');

    this.#sql = sql;
    this.#table = table;

    // `exec()` is synchronous — DO SQLite requires no `await` here, unlike
    // NeonStorage's lazily-awaited #ensureTable().
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS ${this.#table} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);
  }

  capabilities(): StorageCapabilities {
    // A Durable Object's SQLite storage is durably persisted per-object,
    // single-writer (one active instance at a time), and every sql.exec()
    // call it makes participates in the object's implicit transaction, so
    // reads observe the object's own just-committed writes and a scan never
    // interleaves with a concurrent write from this same object.
    return {
      persistence: 'local',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.#getSync(key);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#putSync(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#deleteSync(key);
  }

  async has(key: string): Promise<boolean> {
    const rows = [
      ...this.#sql.exec<PresenceRow>(
        `SELECT 1 AS present FROM ${this.#table} WHERE key = ? LIMIT 1`,
        key,
      ),
    ];
    return rows.length > 0;
  }

  async count(prefix: string): Promise<number> {
    const [rangeStart, rangeEnd] = buildSqlitePrefixRangeParameters(prefix);
    const rows = [
      ...this.#sql.exec<CountRow>(
        `SELECT COUNT(*) AS count FROM ${this.#table} WHERE key >= ? AND key < ?`,
        rangeStart,
        rangeEnd,
      ),
    ];
    return rows[0]?.count ?? 0;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const [rangeStart, rangeEnd] = buildSqlitePrefixRangeParameters(prefix);
    const cursor = this.#sql.exec(
      `DELETE FROM ${this.#table} WHERE key >= ? AND key < ?`,
      rangeStart,
      rangeEnd,
    );
    return cursor.rowsWritten;
  }

  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    const normalized = normalizeDeleteRangeOptions(options);
    const { parameters, sql } = buildSqliteKeyRangeDelete(prefix, normalized, this.#table);
    const cursor = this.#sql.exec(sql, ...parameters);
    return cursor.rowsWritten;
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { parameters, sqlSuffix } = buildSqliteKeyRangeQuery(prefix, options);

    // Eagerly materialize the full result set with one synchronous
    // sql.exec() call before the first `yield`. Durable Object storage is
    // transactional only up to the next `await`/yield in the calling code;
    // deferring rows into a live cursor across yields would both break that
    // invariant and violate the snapshot scanConsistency capabilities()
    // reports (a write between yields must never appear mid-scan).
    const rows = [
      ...this.#sql.exec<KeyValueRow>(
        `SELECT key, value FROM ${this.#table} ${sqlSuffix}`,
        ...parameters,
      ),
    ];

    for (const row of rows) {
      yield [row.key, base64ToBytes(row.value)];
    }
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    const { parameters, sqlSuffix } = buildSqliteKeyRangeQuery(prefix, options);
    const rows = [
      ...this.#sql.exec<KeyRow>(`SELECT key FROM ${this.#table} ${sqlSuffix}`, ...parameters),
    ];

    for (const row of rows) {
      yield row.key;
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    if (operations.length === 0) return;

    // No `await` between operations: every write below runs in the same
    // synchronous stretch, so the whole batch is one atomic Durable Object
    // storage transaction.
    for (const operation of operations) {
      this.#applyOperation(operation);
    }
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
    assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

    // Read-compare-write with no `await` anywhere in this method: two
    // concurrent conditionalBatch() calls against the same table can never
    // interleave their read and write phases, so exactly one of two
    // contending calls with the same precondition can commit.
    for (const condition of conditions) {
      const currentValue = this.#getSync(condition.key);
      if (!storageValuesEqual(currentValue, condition.expectedValue)) {
        return false;
      }
    }

    for (const operation of operations) {
      this.#applyOperation(operation);
    }

    return true;
  }

  #getSync(key: string): Uint8Array | null {
    const rows = [
      ...this.#sql.exec<ValueRow>(`SELECT value FROM ${this.#table} WHERE key = ?`, key),
    ];
    const row = rows[0];
    return row ? base64ToBytes(row.value) : null;
  }

  #putSync(key: string, value: Uint8Array): void {
    this.#sql.exec(
      `INSERT INTO ${this.#table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      bytesToBase64(value),
    );
  }

  #deleteSync(key: string): void {
    this.#sql.exec(`DELETE FROM ${this.#table} WHERE key = ?`, key);
  }

  #applyOperation(operation: BatchOperation): void {
    if (operation.type === 'put') {
      this.#putSync(operation.key, operation.value);
    } else {
      this.#deleteSync(operation.key);
    }
  }

  /**
   * No-op. This adapter is a non-owning view over an injected `sql` binding
   * — the Durable Object owns its storage connection, so there is nothing
   * here to close. Disposing this adapter never touches `sql` beyond the
   * ordinary reads/writes issued by the methods above.
   */
  [Symbol.dispose](): void {
    // Intentionally empty: nothing owned, nothing to release.
  }
}
