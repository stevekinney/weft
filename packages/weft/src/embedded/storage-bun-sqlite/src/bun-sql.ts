import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';

import {
  assertStorageBatchOperationCount,
  normalizeDeleteRangeOptions,
  scopedStorage,
  type BatchOperation,
  type ConditionalBatchCondition,
  type DeleteRangeOptions,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
  type StorageEntryMetadata,
  type StorageScanEntryWithMetadata,
} from "../../storage/src/index.ts";
import {
  assertReadOnlyQuery,
  buildSqliteCountKeysByPrefix,
  buildSqliteDeleteKeysByPrefix,
  buildSqliteKeyRangeDelete,
  buildSqliteKeyRangeSelect,
  buildSqliteKeyValueMetadataRangeSelect,
  buildSqliteKeyValueRangeSelect,
  runConditionalBatchBody,
  SQLITE_ADD_UPDATED_AT_COLUMN,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_CREATE_KEY_VALUE_TABLE,
  SQLITE_DELETE_VALUE_BY_KEY,
  SQLITE_SELECT_KEY_PRESENCE,
  SQLITE_SELECT_KEY_VALUE_COLUMNS,
  SQLITE_SELECT_VALUE_BY_KEY,
  SQLITE_SELECT_WRITE_TIME_BY_KEY,
  SQLITE_UPSERT_VALUE_WITH_WRITE_TIME,
} from "../../storage/src/sql/index.ts";

type BunSQLiteStoragePersistence = NonNullable<StorageCapabilities['persistence']>;

type KeyValueMetadataRow = { key: string; value: Uint8Array; updated_at: number | null };

/**
 * Options for {@link BunSQLiteStorage}.
 *
 * @example
 * ```ts
 * import { BunSQLiteStorage, type BunSQLiteStorageOptions } from '@lostgradient/storage-bun-sqlite';
 *
 * const options: BunSQLiteStorageOptions = { now: () => Date.UTC(2026, 10, 2, 16, 45) };
 * using storage = new BunSQLiteStorage(':memory:', options);
 * ```
 */
export interface BunSQLiteStorageOptions {
  /**
   * The clock each write's time is read from, in milliseconds since the Unix epoch. Defaults to
   * `Date.now`. Every put in one batch or conditional batch shares one reading.
   */
  readonly now?: () => number;
}

/** The metadata a row's `updated_at` gives: its write time, or unknown for `NULL`. */
function metadataFromWriteTime(updatedAt: number | null | undefined): StorageEntryMetadata {
  return { updatedAt: typeof updatedAt === 'number' ? updatedAt : null };
}

/**
 * SQLite-backed {@link Storage} using Bun's built-in `bun:sqlite` module.
 *
 * Opens the database in WAL mode with prepared-statement caching so the hot
 * `get`/`put`/`batch` paths pay zero per-call `prepare()` cost.  Pass
 * `':memory:'` (the default) for ephemeral storage, or a file path for durable
 * persistence across restarts.
 *
 * Every write records its time in the table's `updated_at` column, which {@link
 * BunSQLiteStorage.stat} and {@link BunSQLiteStorage.scanWithMetadata} read. A database file
 * written before the column existed opens unchanged: the column is added on open, and the rows
 * already in it read back an unknown (`null`) write time until they are written again.
 *
 * `query<T>(sql, params?)` runs read-only SQL against the underlying database
 * after validation with `assertReadOnlyQuery`. It is intended for dashboards or
 * debugging; arbitrary mutations are rejected.
 *
 * @example
 * ```ts
 * import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
 *
 * // Durable on-disk storage
 * using storage = new BunSQLiteStorage('./app.db');
 *
 * await storage.put('greeting', new TextEncoder().encode('hello'));
 * console.log(new TextDecoder().decode((await storage.get('greeting')) ?? undefined)); // 'hello'
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
  #putStatement: Statement<unknown, [string, Uint8Array, number]>;
  #deleteStatement: Statement<unknown, [string]>;
  #hasStatement: Statement<{ present: number }, [string]>;
  #statStatement: Statement<{ updated_at: number | null }, [string]>;
  #batchTransaction: { immediate: (entries: BatchOperation[], writtenAt: number) => void };
  #now: () => number;
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
  // Same bounded shape set as #scanStatements: only the selected columns differ.
  #metadataScanStatements: Map<string, Statement<KeyValueMetadataRow, SQLQueryBindings[]>> =
    new Map();
  // deleteRange SQL varies only by bound shape and limit-presence (LIMIT is a
  // bound parameter), so the cache is bounded the same way as #scanStatements.
  #deleteRangeStatements: Map<string, Statement<unknown, SQLQueryBindings[]>> = new Map();
  // count() and deletePrefix() each have two SQL shapes: a bounded prefix range, and the
  // unbounded one an empty prefix needs. Keyed by SQL, so at most two entries apiece.
  #countStatements: Map<string, Statement<{ count: number }, string[]>> = new Map();
  #deletePrefixStatements: Map<string, Statement<unknown, string[]>> = new Map();

  /**
   * Number of distinct prepared-statement cache entries for scan().
   * Exposed for regression tests that assert the cache stays bounded
   * regardless of the numeric values callers pass.
   */
  get scanStatementCacheSize(): number {
    return this.#scanStatements.size;
  }

  constructor(path: string = ':memory:', options: BunSQLiteStorageOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#persistence = path === ':memory:' ? 'ephemeral' : 'local';
    this.#database = new Database(path);

    // First, so the connection waits for another process's lock from its first statement,
    // including the journal-mode switch below, which takes a write lock of its own.
    this.#database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec('PRAGMA synchronous = NORMAL');
    this.#database.exec('PRAGMA cache_size = -64000');
    this.#database.exec('PRAGMA mmap_size = 268435456');
    this.#database.exec('PRAGMA temp_store = MEMORY');
    this.#database.exec('PRAGMA wal_autocheckpoint = 10000');

    this.#database.exec(SQLITE_CREATE_KEY_VALUE_TABLE);
    this.#addWriteTimeColumn();

    this.#getStatement = this.#database.prepare<{ value: Uint8Array }, [string]>(
      SQLITE_SELECT_VALUE_BY_KEY,
    );
    this.#putStatement = this.#database.prepare<unknown, [string, Uint8Array, number]>(
      SQLITE_UPSERT_VALUE_WITH_WRITE_TIME,
    );
    this.#deleteStatement = this.#database.prepare<unknown, [string]>(SQLITE_DELETE_VALUE_BY_KEY);
    this.#hasStatement = this.#database.prepare<{ present: number }, [string]>(
      SQLITE_SELECT_KEY_PRESENCE,
    );
    this.#statStatement = this.#database.prepare<{ updated_at: number | null }, [string]>(
      SQLITE_SELECT_WRITE_TIME_BY_KEY,
    );
    // Build the transaction wrapper once; bun:sqlite memoizes the compiled
    // transaction so subsequent calls just run the prepared statements.
    this.#batchTransaction = this.#database.transaction(
      (entries: BatchOperation[], writtenAt: number) => {
        for (const entry of entries) {
          if (entry.type === 'put') {
            this.#putStatement.run(entry.key, entry.value, writtenAt);
          } else {
            this.#deleteStatement.run(entry.key);
          }
        }
      },
    );
  }

  /**
   * Add the `updated_at` column to a table created before this adapter recorded write times. The
   * check and the change run in one immediate transaction, so two processes opening the same old
   * file cannot both add it.
   */
  #addWriteTimeColumn(): void {
    const addWhenMissing = this.#database.transaction(() => {
      // Prepared and finalized here rather than cached by `query()`, so no statement outlives it.
      const statement = this.#database.prepare<{ name: string }, []>(
        SQLITE_SELECT_KEY_VALUE_COLUMNS,
      );
      let columns: string[];
      try {
        columns = statement.all().map((column) => column.name);
      } finally {
        statement.finalize();
      }
      if (!columns.includes('updated_at')) {
        this.#database.exec(SQLITE_ADD_UPDATED_AT_COLUMN);
      }
    });
    addWhenMissing.immediate();
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
    this.#putStatement.run(key, value, this.#now());
  }

  async delete(key: string): Promise<void> {
    this.#deleteStatement.run(key);
  }

  async has(key: string): Promise<boolean> {
    return this.#hasStatement.get(key) != null;
  }

  /** When `key` was last written, or `null` when it is absent. */
  async stat(key: string): Promise<StorageEntryMetadata | null> {
    const row = this.#statStatement.get(key);
    return row ? metadataFromWriteTime(row.updated_at) : null;
  }

  /** {@link BunSQLiteStorage.scan} with each entry's write time, read in the same statement. */
  async *scanWithMetadata(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<StorageScanEntryWithMetadata> {
    const { parameters, sql } = buildSqliteKeyValueMetadataRangeSelect(prefix, options);

    let statement = this.#metadataScanStatements.get(sql);
    if (!statement) {
      statement = this.#database.prepare<KeyValueMetadataRow, SQLQueryBindings[]>(sql);
      this.#metadataScanStatements.set(sql, statement);
    }

    for (const row of statement.all(...parameters)) {
      yield [row.key, new Uint8Array(row.value), metadataFromWriteTime(row.updated_at)];
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const { parameters, sql } = buildSqliteDeleteKeysByPrefix(prefix);
    let statement = this.#deletePrefixStatements.get(sql);
    if (!statement) {
      statement = this.#database.prepare<unknown, string[]>(sql);
      this.#deletePrefixStatements.set(sql, statement);
    }
    return statement.run(...parameters).changes;
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
    const { parameters, sql } = buildSqliteCountKeysByPrefix(prefix);
    let statement = this.#countStatements.get(sql);
    if (!statement) {
      statement = this.#database.prepare<{ count: number }, string[]>(sql);
      this.#countStatements.set(sql, statement);
    }
    return statement.get(...parameters)?.count ?? 0;
  }

  scoped(prefix: string): Storage {
    const scoped = scopedStorage(this, prefix);
    return scoped;
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    if (operations.length === 0) return;
    // A batch writes first, so a deferred transaction would also wait under the busy timeout;
    // `.immediate` keeps it in step with `conditionalBatch`, which reads before it writes.
    this.#batchTransaction.immediate(operations, this.#now());
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
    assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

    const writtenAt = this.#now();
    const conditionalTransaction = this.#database.transaction(
      (pendingConditions: ConditionalBatchCondition[], pendingOperations: BatchOperation[]) =>
        runConditionalBatchBody(pendingConditions, pendingOperations, {
          read: (key) => {
            const row = this.#getStatement.get(key);
            return row ? new Uint8Array(row.value) : null;
          },
          put: (key, value) => {
            this.#putStatement.run(key, value, writtenAt);
          },
          delete: (key) => {
            this.#deleteStatement.run(key);
          },
        }),
    );

    // Immediate, so the write lock is taken before the read and a lost race returns `false`
    // after waiting, where a deferred transaction would throw `database is locked`.
    return conditionalTransaction.immediate(conditions, operations);
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

  async sizeBytes(): Promise<number> {
    const [pageCount, pageSize] = await Promise.all([
      this.query<{ page_count: number }>('PRAGMA page_count'),
      this.query<{ page_size: number }>('PRAGMA page_size'),
    ]);
    return (pageCount[0]?.page_count ?? 0) * (pageSize[0]?.page_size ?? 0);
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
    this.#statStatement.finalize();
    for (const statement of this.#countStatements.values()) {
      statement.finalize();
    }
    this.#countStatements.clear();
    for (const statement of this.#deletePrefixStatements.values()) {
      statement.finalize();
    }
    this.#deletePrefixStatements.clear();
    for (const statement of this.#scanStatements.values()) {
      statement.finalize();
    }
    this.#scanStatements.clear();
    for (const statement of this.#keyStatements.values()) {
      statement.finalize();
    }
    this.#keyStatements.clear();
    for (const statement of this.#metadataScanStatements.values()) {
      statement.finalize();
    }
    this.#metadataScanStatements.clear();
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
