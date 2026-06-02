import { Database, Statement, type SQLQueryBindings } from 'bun:sqlite';

import { normalizeDeleteRangeOptions, type DeleteRangeOptions } from './delete-range';
import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from './interface';
import { assertReadOnlyQuery } from './read-only-query';
import { scopedStorage } from './scoped-storage';
import {
  SQLITE_COUNT_KEYS_BY_PREFIX,
  SQLITE_CREATE_KEY_VALUE_TABLE,
  SQLITE_DELETE_KEYS_BY_PREFIX,
  SQLITE_DELETE_VALUE_BY_KEY,
  SQLITE_SELECT_KEY_PRESENCE,
  SQLITE_SELECT_VALUE_BY_KEY,
  SQLITE_UPSERT_VALUE_BY_KEY,
  buildSqliteKeyRangeDelete,
  buildSqliteKeyRangeSelect,
  buildSqliteKeyValueRangeSelect,
  buildSqlitePrefixRangeParameters,
} from './sqlite-key-value-queries';

type BunSQLiteStoragePersistence = NonNullable<StorageCapabilities['persistence']>;

/**
 * Runtime-neutral alias for the Bun SQLite adapter. Consumers that import
 * from `@lostgradient/weft/storage/sqlite` get this class under Bun.
 */
export { BunSQLiteStorage as SQLiteStorage };

/**
 * SQLite-backed {@link Storage} using Bun's built-in `bun:sqlite` module.
 *
 * Opens the database in WAL mode with prepared-statement caching so the hot
 * `get`/`put`/`batch` paths pay zero per-call `prepare()` cost.  Pass
 * `':memory:'` (the default) for ephemeral storage, or a file path for durable
 * persistence across restarts.
 *
 * `query<T>(sql, params?)` runs read-only SQL against the underlying database
 * after validation with `assertReadOnlyQuery`. It is intended for dashboards or
 * debugging; arbitrary mutations are rejected.
 *
 * @example
 * ```ts
 * import { BunSQLiteStorage } from '@lostgradient/weft/storage/sqlite/bun';
 * import { workflow, Engine, type WorkflowContext } from '@lostgradient/weft';
 *
 * // Durable on-disk storage
 * await using storage = new BunSQLiteStorage('./weft.db');
 * await using engine = new Engine({ storage });
 *
 * engine.register(
 *   workflow({ name: 'echo' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     return input;
 *   }),
 * );
 *
 * const handle = await engine.start('echo', { msg: 'hi' });
 * console.log(await handle.result()); // { msg: 'hi' }
 * ```
 */
export class BunSQLiteStorage implements Storage {
  #database: Database;
  #persistence: BunSQLiteStoragePersistence;
  // Prepared statements are cached on the instance so the hot paths (get,
  // put, batch) never pay `prepare()` cost after construction. This matters:
  // the start/complete benchmarks make 2-3 storage calls per workflow, and
  // re-preparing the same SQL on every call drops throughput by roughly 2x.
  #getStatement: Statement<{ value: Uint8Array }, [string]>;
  #putStatement: Statement<unknown, [string, Uint8Array]>;
  #deleteStatement: Statement<unknown, [string]>;
  #hasStatement: Statement<{ present: number }, [string]>;
  #countStatement: Statement<{ count: number }, [string, string]>;
  #deletePrefixStatement: Statement<unknown, [string, string]>;
  #batchTransaction: (entries: BatchOperation[]) => void;
  // Cache prepared statements for scan() keyed by the fully-built SQL string.
  // The set of SQL variants is bounded by the structural shape of the scan
  // arguments (presence of gt/gte/lt/lte/reverse/limit), not by their
  // numeric values — LIMIT is a bound parameter, not interpolated into the
  // SQL, so varying `limit` values collapse onto a single cache entry. The
  // cache grows at most by the number of distinct shape combinations, which
  // is ≤ 2^6 = 64. bun:sqlite tracks live statements on the database and
  // refuses to close while any are outstanding, so we finalize every cached
  // entry in [Symbol.dispose].
  #scanStatements: Map<string, Statement<{ key: string; value: Uint8Array }, SQLQueryBindings[]>> =
    new Map();
  #keyStatements: Map<string, Statement<{ key: string }, SQLQueryBindings[]>> = new Map();
  // deleteRange SQL varies only by bound shape and limit-presence (LIMIT is a
  // bound parameter), so the cache is bounded the same way as #scanStatements.
  #deleteRangeStatements: Map<string, Statement<unknown, SQLQueryBindings[]>> = new Map();

  /**
   * Number of distinct prepared-statement cache entries for scan().
   * Exposed for regression tests that assert the cache stays bounded
   * regardless of the numeric values callers pass.
   */
  get scanStatementCacheSize(): number {
    return this.#scanStatements.size;
  }

  constructor(path: string = ':memory:') {
    this.#persistence = path === ':memory:' ? 'ephemeral' : 'local';
    this.#database = new Database(path);

    this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec('PRAGMA synchronous = NORMAL');
    this.#database.exec('PRAGMA cache_size = -64000');
    this.#database.exec('PRAGMA mmap_size = 268435456');
    this.#database.exec('PRAGMA temp_store = MEMORY');
    this.#database.exec('PRAGMA wal_autocheckpoint = 10000');

    this.#database.exec(SQLITE_CREATE_KEY_VALUE_TABLE);

    this.#getStatement = this.#database.prepare<{ value: Uint8Array }, [string]>(
      SQLITE_SELECT_VALUE_BY_KEY,
    );
    this.#putStatement = this.#database.prepare<unknown, [string, Uint8Array]>(
      SQLITE_UPSERT_VALUE_BY_KEY,
    );
    this.#deleteStatement = this.#database.prepare<unknown, [string]>(SQLITE_DELETE_VALUE_BY_KEY);
    this.#hasStatement = this.#database.prepare<{ present: number }, [string]>(
      SQLITE_SELECT_KEY_PRESENCE,
    );
    this.#countStatement = this.#database.prepare<{ count: number }, [string, string]>(
      SQLITE_COUNT_KEYS_BY_PREFIX,
    );
    this.#deletePrefixStatement = this.#database.prepare<unknown, [string, string]>(
      SQLITE_DELETE_KEYS_BY_PREFIX,
    );
    // Build the transaction wrapper once; bun:sqlite memoizes the compiled
    // transaction so subsequent calls just run the prepared statements.
    this.#batchTransaction = this.#database.transaction((entries: BatchOperation[]) => {
      for (const entry of entries) {
        if (entry.type === 'put') {
          this.#putStatement.run(entry.key, entry.value);
        } else {
          this.#deleteStatement.run(entry.key);
        }
      }
    });
  }

  capabilities(): StorageCapabilities {
    // Single-process WAL SQLite: serialized writers, same-connection reads see
    // committed data (linearizable); statements observe a snapshot; batch() runs
    // in one transaction (atomic); deletePrefix and deleteRange are single range DELETEs.
    return {
      persistence: this.#persistence,
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const row = this.#getStatement.get(key);
    if (!row) return null;
    // bun:sqlite may return a Buffer; ensure we return a proper Uint8Array.
    return new Uint8Array(row.value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#putStatement.run(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#deleteStatement.run(key);
  }

  async has(key: string): Promise<boolean> {
    return this.#hasStatement.get(key) != null;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const [rangeStart, rangeEnd] = buildSqlitePrefixRangeParameters(prefix);
    return this.#deletePrefixStatement.run(rangeStart, rangeEnd).changes;
  }

  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    const normalized = normalizeDeleteRangeOptions(options);
    const { parameters, sql } = buildSqliteKeyRangeDelete(prefix, normalized);

    let statement = this.#deleteRangeStatements.get(sql);
    if (!statement) {
      statement = this.#database.prepare<unknown, SQLQueryBindings[]>(sql);
      this.#deleteRangeStatements.set(sql, statement);
    }

    return statement.run(...parameters).changes;
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { parameters, sql } = buildSqliteKeyValueRangeSelect(prefix, options);

    let statement = this.#scanStatements.get(sql);
    if (!statement) {
      statement = this.#database.prepare<{ key: string; value: Uint8Array }, SQLQueryBindings[]>(
        sql,
      );
      this.#scanStatements.set(sql, statement);
    }

    const rows = statement.all(...parameters);

    for (const row of rows) {
      yield [row.key, new Uint8Array(row.value)];
    }
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    const { parameters, sql } = buildSqliteKeyRangeSelect(prefix, options);

    let statement = this.#keyStatements.get(sql);
    if (!statement) {
      statement = this.#database.prepare<{ key: string }, SQLQueryBindings[]>(sql);
      this.#keyStatements.set(sql, statement);
    }

    for (const row of statement.all(...parameters)) {
      yield row.key;
    }
  }

  async count(prefix: string): Promise<number> {
    const [rangeStart, rangeEnd] = buildSqlitePrefixRangeParameters(prefix);
    return this.#countStatement.get(rangeStart, rangeEnd)?.count ?? 0;
  }

  scoped(prefix: string): Storage {
    const scoped = scopedStorage(this, prefix);
    return scoped;
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;
    this.#batchTransaction(operations);
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const conditionalTransaction = this.#database.transaction(
      (
        pendingConditions: ConditionalBatchCondition[],
        pendingOperations: BatchOperation[],
      ): boolean => {
        for (const condition of pendingConditions) {
          const row = this.#getStatement.get(condition.key);
          const currentValue = row ? new Uint8Array(row.value) : null;
          if (!storageValuesEqual(currentValue, condition.expectedValue)) {
            return false;
          }
        }

        for (const operation of pendingOperations) {
          if (operation.type === 'put') {
            this.#putStatement.run(operation.key, operation.value);
          } else {
            this.#deleteStatement.run(operation.key);
          }
        }

        return true;
      },
    );

    return conditionalTransaction(conditions, operations);
  }

  async query<T>(sql: string, parameters?: SQLQueryBindings[]): Promise<T[]> {
    assertReadOnlyQuery(sql);

    // query() accepts arbitrary caller-supplied SQL, so caching is not safe
    // (the set of distinct strings is unbounded). Finalize the statement
    // explicitly — bun:sqlite tracks live statements on the database handle
    // and refuses to close while any are outstanding.
    const statement = this.#database.prepare<T, SQLQueryBindings[]>(sql);
    try {
      return statement.all(...(parameters ?? []));
    } finally {
      statement.finalize();
    }
  }

  [Symbol.dispose](): void {
    // Finalize cached statements before closing — bun:sqlite tracks live
    // statements on the database and refuses to close while any are
    // outstanding. Finalizing also ensures subsequent get/put calls throw
    // synchronously instead of silently no-oping against a freed DB handle.
    this.#getStatement.finalize();
    this.#putStatement.finalize();
    this.#deleteStatement.finalize();
    this.#hasStatement.finalize();
    this.#countStatement.finalize();
    this.#deletePrefixStatement.finalize();
    for (const statement of this.#scanStatements.values()) {
      statement.finalize();
    }
    this.#scanStatements.clear();
    for (const statement of this.#keyStatements.values()) {
      statement.finalize();
    }
    this.#keyStatements.clear();
    for (const statement of this.#deleteRangeStatements.values()) {
      statement.finalize();
    }
    this.#deleteRangeStatements.clear();
    // database.close() finalizes any remaining compiled statements including the
    // internal BEGIN/COMMIT/ROLLBACK statements created by database.transaction().
    // We close after finalizing named statements so their handles are released
    // explicitly, giving bun:sqlite a clean shutdown path.
    this.#database.close();
  }
}
