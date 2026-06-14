/**
 * Node-compatible SQLite storage adapter using `better-sqlite3`.
 *
 * Implements the same `Storage` interface and SQL schema as `BunSQLiteStorage`
 * but uses `better-sqlite3` instead of `bun:sqlite`, enabling the same
 * storage layer to run on Node.js 22+.
 *
 * `better-sqlite3` is a peer dependency — it must be installed separately by
 * consumers who import `@lostgradient/weft/storage/sqlite/node`.
 *
 * @module storage/node-sqlite
 */

import type {
  BatchOperation,
  ConditionalBatchCondition,
  ScanOptions,
  Storage,
  StorageCapabilities,
} from './interface.ts';
import { assertStorageBatchOperationCount, storageValuesEqual } from './interface.ts';
import {
  createMissingBetterSqlite3Error,
  isBetterSqlite3LoadFailure,
  loadBetterSqlite3,
  type BetterSqliteConstructor,
  type BetterSqliteDatabase,
  type BetterSqliteStatement,
  type BetterSqliteTransaction,
} from './node-sqlite-loader.ts';
import {
  SQLITE_CREATE_KEY_VALUE_TABLE,
  SQLITE_DELETE_VALUE_BY_KEY,
  SQLITE_SELECT_VALUE_BY_KEY,
  SQLITE_UPSERT_VALUE_BY_KEY,
  buildSqliteKeyValueRangeSelect,
} from './sqlite-key-value-queries.ts';

type NodeSQLiteStoragePersistence = NonNullable<StorageCapabilities['persistence']>;

/**
 * Runtime-neutral alias for the Node SQLite adapter. Consumers that import
 * from `@lostgradient/weft/storage/sqlite` get this class under Node.
 */
export { NodeSQLiteStorage as SQLiteStorage };

/**
 * SQLite-backed {@link Storage} using `better-sqlite3` for Node.js 22+
 * environments.
 *
 * Implements the same WAL-mode schema as {@link BunSQLiteStorage}
 * but resolves the `better-sqlite3` peer dependency lazily at construction time,
 * so the module compiles without it installed.  Import from
 * `@lostgradient/weft/storage/sqlite/node` to use this adapter.
 *
 * Unlike BunSQLiteStorage, this adapter currently implements only the required
 * Storage methods (`get`, `put`, `delete`, `scan`, `batch`, and
 * `conditionalBatch`). The optional `has`, `keys`, `count`, `deletePrefix`, and
 * `scoped` helpers fall back to the generic implementations in
 * `@lostgradient/weft/storage/interface`; `deleteRange` falls back to `storageDeleteRange`
 * (exported from `@lostgradient/weft` / `@lostgradient/weft/storage`). There is no SQL passthrough
 * `query()` method.
 *
 * @example
 * ```ts
 * import { NodeSQLiteStorage } from '@lostgradient/weft/storage/sqlite/node';
 * import { workflow, Engine } from '@lostgradient/weft';
 *
 * // Requires: bun add better-sqlite3
 * await using storage = new NodeSQLiteStorage('./weft.db');
 * await using engine = new Engine({ storage });
 *
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * const handle = await engine.start('ping', null);
 * console.log(await handle.result()); // 'pong'
 * ```
 */
export class NodeSQLiteStorage implements Storage {
  #database: BetterSqliteDatabase;
  #persistence: NodeSQLiteStoragePersistence;
  #getStatement: BetterSqliteStatement;
  #putStatement: BetterSqliteStatement;
  #deleteStatement: BetterSqliteStatement;
  #batchTransaction: BetterSqliteTransaction;
  #scanStatements: Map<string, BetterSqliteStatement> = new Map();

  /**
   * Number of distinct prepared-statement cache entries for scan().
   * Exposed for regression tests that assert the cache stays bounded.
   */
  get scanStatementCacheSize(): number {
    return this.#scanStatements.size;
  }

  capabilities(): StorageCapabilities {
    // Single-process WAL SQLite (better-sqlite3): serialized writers,
    // same-connection reads see committed data (linearizable); snapshot scans;
    // batch() runs in one transaction. This adapter omits its own deletePrefix
    // and relies on the derived scan-and-delete fallback, so boundedRangeDelete
    // is false.
    return {
      persistence: this.#persistence,
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: false,
    };
  }

  constructor(path: string = ':memory:', databaseConstructor?: BetterSqliteConstructor) {
    this.#persistence = path === ':memory:' ? 'ephemeral' : 'local';
    const Database = databaseConstructor ?? loadBetterSqlite3();

    try {
      this.#database = new Database(path);
    } catch (error) {
      if (databaseConstructor === undefined && isBetterSqlite3LoadFailure(error)) {
        throw createMissingBetterSqlite3Error(error);
      }

      throw error;
    }

    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('synchronous = NORMAL');
    this.#database.pragma('cache_size = -64000');
    this.#database.pragma('mmap_size = 268435456');
    this.#database.pragma('temp_store = MEMORY');
    this.#database.pragma('wal_autocheckpoint = 10000');

    this.#database.exec(SQLITE_CREATE_KEY_VALUE_TABLE);

    this.#getStatement = this.#database.prepare(SQLITE_SELECT_VALUE_BY_KEY);
    this.#putStatement = this.#database.prepare(SQLITE_UPSERT_VALUE_BY_KEY);
    this.#deleteStatement = this.#database.prepare(SQLITE_DELETE_VALUE_BY_KEY);
    this.#batchTransaction = this.#database.transaction((entries: unknown) => {
      for (const entry of entries as BatchOperation[]) {
        if (entry.type === 'put') {
          this.#putStatement.run(entry.key, entry.value);
        } else {
          this.#deleteStatement.run(entry.key);
        }
      }
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const row = this.#getStatement.get(key);
    if (!row) return null;
    const value = (row as { value: Uint8Array }).value;
    return new Uint8Array(value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#putStatement.run(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#deleteStatement.run(key);
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { parameters, sql } = buildSqliteKeyValueRangeSelect(prefix, options);

    let statement = this.#scanStatements.get(sql);
    if (!statement) {
      statement = this.#database.prepare(sql);
      this.#scanStatements.set(sql, statement);
    }

    const rows = statement.all(...parameters);

    for (const row of rows) {
      const typedRow = row as { key: string; value: Uint8Array };
      yield [typedRow.key, new Uint8Array(typedRow.value)];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    if (operations.length === 0) return;
    this.#batchTransaction(operations);
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
    assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

    const conditionalTransaction = this.#database.transaction(
      (...arguments_: unknown[]): boolean => {
        const pendingConditions = arguments_[0] as ConditionalBatchCondition[];
        const pendingOperations = arguments_[1] as BatchOperation[];

        for (const condition of pendingConditions) {
          const row = this.#getStatement.get(condition.key);
          const currentValue = row ? new Uint8Array((row as { value: Uint8Array }).value) : null;
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

    return Boolean(conditionalTransaction(conditions, operations));
  }

  [Symbol.dispose](): void {
    this.#scanStatements.clear();
    this.#database.close();
  }
}
