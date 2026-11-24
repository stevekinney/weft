import { type StorageCapabilities } from '../capabilities.ts';
import { normalizeDeleteRangeOptions, type DeleteRangeOptions } from '../delete-range.ts';
import type { StorageEntryMetadata, StorageScanEntryWithMetadata } from '../entry-metadata.ts';
import {
  assertStorageBatchOperationCount,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
} from '../interface.ts';
import { scopedStorage } from '../scoped-storage.ts';
import { conditionsHold, writeBatchNetEffect } from './neon-batch.ts';
import {
  affectedRowCount,
  metadataFromWriteTime,
  resolveBatchNetEffect,
  toBytea,
  toStorageValue,
} from './neon-value-mapping.ts';
import {
  buildPostgresCreateSchema,
  buildPostgresKeyValueQueries,
  PG_ACQUIRE_SETUP_LOCK,
  PG_BEGIN_READ_COMMITTED,
  PG_BEGIN_READ_ONLY,
  PG_BEGIN_SERIALIZABLE,
  PG_COMMIT,
  PG_ROLLBACK,
  resolvePostgresTableReference,
  type PostgresKeyValueQueries,
} from './postgres-key-value-queries.ts';
import type {
  PostgresKeyValueStorageOptions,
  PostgresPool,
  PostgresPoolClient,
} from './postgres-pool.ts';
import { assertReadOnlyQuery } from './read-only-query.ts';
import {
  isRetryableTransactionFailure,
  MAX_SERIALIZATION_RETRIES,
  serializationRetryDelay,
  sleep,
} from './serialization-retry.ts';

/**
 * Driver-agnostic base for Weft's Postgres-wire storage adapters. Implements the
 * full `Storage` interface over a single `kv(key TEXT COLLATE "C", value BYTEA, updated_at
 * BIGINT)` table using the structural {@link PostgresPool} seam, so switching between the
 * native `pg` driver and the Neon serverless driver is a subclass choice, not a
 * behavior change. Everything driver-specific — the driver import and the default
 * connection-pool construction — lives in the concrete subclass, which passes a
 * `poolFactory` to this constructor; the base itself carries no driver dependency.
 *
 * **Write times.** Every write records its time in `updated_at`, which `stat` and
 * `scanWithMetadata` read. A table created before the column existed gains it on first use,
 * and its rows read back an unknown (`null`) write time until they are written again.
 *
 * **Endpoint assumption.** `capabilities()` reports `readAfterWrite:
 * 'linearizable'`, which holds for the **primary** endpoint. A read-replica
 * connection string would violate that guarantee — point this adapter at the
 * primary.
 *
 * @see {@link PostgresStorage} for the native `pg` adapter and {@link NeonStorage}
 *   for the Neon serverless adapter.
 */
export class PostgresKeyValueStorage implements Storage {
  #pool: PostgresPool;
  // All SQL statements for this instance, bound once to the resolved table
  // reference (the unqualified `kv` by default, or a quoted `"schema"."table"`
  // when configured). Interpolating the reference once here keeps it off every
  // query's hot path.
  #queries: PostgresKeyValueQueries;
  // The configured schema, if any — its `CREATE SCHEMA IF NOT EXISTS` runs
  // during initialization before the table is created. `undefined` for the
  // default (unqualified) deployment, which skips schema creation entirely.
  #schema: string | undefined;
  // Memoized table-initialization promise; see #ensureTable for the
  // share-on-concurrent, clear-on-reject semantics.
  #initializationPromise: Promise<void> | undefined;
  // True only when this adapter constructed the pool itself. An injected pool is
  // owned by the caller, so disposal must NOT close it — closing a shared pool
  // would tear out connectivity for every other consumer of that pool.
  #ownsPool: boolean;
  // The single owned-pool shutdown, memoized so disposal is idempotent: a second
  // dispose (sync-then-async, or either twice) awaits/observes the same `end()`
  // rather than calling it again (which the driver rejects as "ended twice").
  #poolShutdown: Promise<void> | undefined;
  // Backoff between SERIALIZABLE attempts; see SerializationRetryOptions.
  #retryDelay: (milliseconds: number) => Promise<void>;
  #retryRandom: () => number;
  #now: () => number;

  /**
   * @param options Connection configuration ({@link PostgresKeyValueStorageOptions}).
   * @param poolFactory Constructs the owned pool from `url`. Required — the
   *   concrete subclass injects its driver's pool constructor here (lazily loaded)
   *   so the base module never imports a driver. Used only when no `pool` is
   *   supplied; an injected `pool` stays caller-owned. Throws if neither `pool`
   *   nor `url` is provided.
   */
  constructor(options: PostgresKeyValueStorageOptions, poolFactory: (url: string) => PostgresPool) {
    this.#ownsPool = options.pool === undefined;
    if (options.pool === undefined) {
      if (options.url === undefined) {
        throw new Error(
          'PostgresKeyValueStorage requires either a `url` to build a pool from, or a pre-built `pool`; neither was provided.',
        );
      }
      this.#pool = poolFactory(options.url);
    } else {
      this.#pool = options.pool;
    }
    this.#schema = options.schema;
    this.#retryDelay = options.serializationRetry?.delay ?? sleep;
    this.#retryRandom = options.serializationRetry?.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    // Resolve + validate the table reference once. With no schema/table set this
    // is the bare `kv` (byte-identical default SQL); otherwise a quoted,
    // identifier-validated `"schema"."table"`.
    const tableReference = resolvePostgresTableReference({
      schema: options.schema,
      table: options.table,
    });
    this.#queries = buildPostgresKeyValueQueries(tableReference);
  }

  capabilities(): StorageCapabilities {
    // Postgres, primary endpoint: linearizable read-after-write, snapshot scans,
    // transactional atomic + compare-and-swap batches, and single range-scoped
    // DELETEs for deletePrefix/deleteRange.
    return {
      persistence: 'remote',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  /**
   * Ensure the `kv` table exists and is correctly collated before any operation.
   * Memoized so concurrent first calls share one initialization; cleared on
   * rejection so a transient failure does not permanently wedge the adapter.
   */
  #ensureTable(): Promise<void> {
    this.#initializationPromise ??= this.#initialize().catch((error: unknown) => {
      this.#initializationPromise = undefined;
      throw error;
    });
    return this.#initializationPromise;
  }

  async #initialize(): Promise<void> {
    await this.#createSchemaAndTable();
    await this.#assertKeyCollation();
  }

  /**
   * Create the schema and table under a transaction-scoped advisory lock:
   * concurrent `CREATE ... IF NOT EXISTS` on separate connections can fail with a
   * unique violation on `pg_namespace`/`pg_type` instead of no-op'ing, so waiters
   * take the lock, then find the committed objects. Released at COMMIT/ROLLBACK.
   */
  async #createSchemaAndTable(): Promise<void> {
    await this.#withTransaction(PG_BEGIN_READ_COMMITTED, async (client) => {
      await client.query(PG_ACQUIRE_SETUP_LOCK);
      // Schema first so the schema-qualified CREATE TABLE resolves.
      if (this.#schema !== undefined) {
        await client.query(buildPostgresCreateSchema(this.#schema));
      }
      await client.query(this.#queries.createTable);
      // Check before altering: `ALTER TABLE` takes an exclusive lock even when the column exists,
      // which every later start would otherwise wait on behind live readers.
      const column = await client.query(this.#queries.selectWriteTimeColumn, [
        this.#queries.tableReference,
      ]);
      if (column.rows.length === 0) {
        await client.query(this.#queries.addWriteTimeColumn);
      }
    });
  }

  /**
   * Verify the configured table's `key` column uses the `C` collation. `CREATE
   * TABLE IF NOT EXISTS` is a no-op against a pre-existing table, so a table
   * created elsewhere with the database's default (locale) collation would
   * silently break the lexicographic prefix scans the engine depends on. A table
   * this adapter just created always has `COLLATE "C"`, so this only ever fails
   * for a foreign, mis-collated table — fail loudly with an actionable message
   * rather than corrupt scan results.
   *
   * The introspection is scoped to the configured table reference (passed as
   * `to_regclass($1)`), so a `kv` table elsewhere on the search path cannot be
   * inspected by mistake.
   */
  async #assertKeyCollation(): Promise<void> {
    const result = await this.#pool.query(this.#queries.selectKeyCollation, [
      this.#queries.tableReference,
    ]);
    const collation = result.rows[0]?.['collation'];
    if (collation === 'C') return;
    // No row means the table is absent (unexpected — it was just created — but
    // treat an unknowable collation as a hard error rather than assume success).
    // The introspection query always selects a text column, so a non-string value
    // is impossible in practice; describe it generically if it ever occurs.
    const found =
      collation === undefined
        ? 'no such table'
        : typeof collation === 'string'
          ? `"${collation}"`
          : 'an unexpected collation value';
    throw new Error(
      `Postgres storage requires the ${this.#queries.tableReference} table's "key" column to use COLLATE "C" (found ${found}). A table created without COLLATE "C" sorts keys by the database locale, which breaks Weft's lexicographic prefix scans. Use a fresh table, or recreate it as: CREATE TABLE ${this.#queries.tableReference} (key TEXT COLLATE "C" PRIMARY KEY, value BYTEA NOT NULL).`,
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    await this.#ensureTable();
    const result = await this.#pool.query(this.#queries.selectValueByKey, [key]);
    const row = result.rows[0];
    if (row === undefined) return null;
    const raw = row['value'];
    if (raw === null || raw === undefined) return null;
    return toStorageValue(raw);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.#ensureTable();
    await this.#pool.query(this.#queries.upsertValueByKey, [key, toBytea(value), this.#now()]);
  }

  async delete(key: string): Promise<void> {
    await this.#ensureTable();
    await this.#pool.query(this.#queries.deleteValueByKey, [key]);
  }

  async has(key: string): Promise<boolean> {
    await this.#ensureTable();
    const result = await this.#pool.query(this.#queries.selectKeyPresence, [key]);
    return result.rows.length > 0;
  }

  /** When `key` was last written, or `null` when it is absent. */
  async stat(key: string): Promise<StorageEntryMetadata | null> {
    await this.#ensureTable();
    const result = await this.#pool.query(this.#queries.selectWriteTimeByKey, [key]);
    const row = result.rows[0];
    return row === undefined ? null : metadataFromWriteTime(row['updated_at']);
  }

  /** `scan` with each entry's write time, read in the same statement. */
  async *scanWithMetadata(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<StorageScanEntryWithMetadata> {
    await this.#ensureTable();
    const { parameters, sql } = this.#queries.keyValueMetadataRangeSelect(prefix, options);
    const result = await this.#pool.query(sql, parameters);
    for (const row of result.rows) {
      yield [
        row['key'] as string,
        toStorageValue(row['value']),
        metadataFromWriteTime(row['updated_at']),
      ];
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    await this.#ensureTable();
    const { parameters, sql } = this.#queries.deleteKeysByPrefix(prefix);
    const result = await this.#pool.query(sql, parameters);
    return affectedRowCount(result);
  }

  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    await this.#ensureTable();
    const normalized = normalizeDeleteRangeOptions(options);
    const { parameters, sql } = this.#queries.keyRangeDelete(prefix, normalized);
    const result = await this.#pool.query(sql, parameters);
    return affectedRowCount(result);
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    await this.#ensureTable();
    const { parameters, sql } = this.#queries.keyValueRangeSelect(prefix, options);
    const result = await this.#pool.query(sql, parameters);
    for (const row of result.rows) {
      yield [row['key'] as string, toStorageValue(row['value'])];
    }
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    await this.#ensureTable();
    const { parameters, sql } = this.#queries.keyRangeSelect(prefix, options);
    const result = await this.#pool.query(sql, parameters);
    for (const row of result.rows) {
      yield row['key'] as string;
    }
  }

  async count(prefix: string): Promise<number> {
    await this.#ensureTable();
    const { parameters, sql } = this.#queries.countKeysByPrefix(prefix);
    const result = await this.#pool.query(sql, parameters);
    return Number(result.rows[0]?.['count'] ?? 0);
  }

  scoped(prefix: string): Storage {
    return scopedStorage(this, prefix);
  }

  /**
   * Run `runner` inside a single interactive transaction on a pinned connection.
   * Both `batch()` and `conditionalBatch()` go through here so every statement in
   * a transaction lands on the same connection — `pool.query()` alone may scatter
   * statements across pooled connections, breaking atomicity. The connection is
   * always released, and a failure rolls back before propagating.
   *
   * `shouldCommit` decides COMMIT vs ROLLBACK from the runner's result (default:
   * always commit). `conditionalBatch` passes a predicate so a no-op result (a
   * precondition mismatch that wrote nothing) ROLLs BACK instead of committing: a
   * read-only `SERIALIZABLE` transaction's COMMIT can still abort with `40001`,
   * which would turn a legitimate `false` compare-and-swap into a retried (and
   * possibly thrown) serialization failure. A ROLLBACK never raises `40001`.
   */
  async #withTransaction<T>(
    beginStatement:
      typeof PG_BEGIN_SERIALIZABLE | typeof PG_BEGIN_READ_COMMITTED | typeof PG_BEGIN_READ_ONLY,
    runner: (client: PostgresPoolClient) => Promise<T>,
    shouldCommit: (result: T) => boolean = () => true,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query(beginStatement);
      try {
        const result = await runner(client);
        await client.query(shouldCommit(result) ? PG_COMMIT : PG_ROLLBACK);
        return result;
      } catch (error) {
        await client.query(PG_ROLLBACK).catch(() => {
          // Preserve the original failure; a rollback error is secondary.
        });
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    if (operations.length === 0) return;
    const netEffect = resolveBatchNetEffect(operations);
    const writtenAt = this.#now();
    await this.#ensureTable();
    await this.#withTransaction(PG_BEGIN_READ_COMMITTED, async (client) => {
      await writeBatchNetEffect(client, this.#queries, netEffect, writtenAt);
    });
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
    assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

    // Resolve the write net effect once, outside the retry loop — it is
    // deterministic input, so recomputing per retry would be wasted work. Both it and the
    // conditions snapshot come before the first `await`: a retry waits, so a caller that
    // reuses its arrays while the call is pending must not change what later attempts do.
    const netEffect = resolveBatchNetEffect(operations);
    const checkedConditions = conditions.map((condition) => ({ ...condition }));
    // One reading for every attempt, so a retried transaction stamps the time the call was made.
    const writtenAt = this.#now();

    await this.#ensureTable();

    // SERIALIZABLE is required, not SELECT...FOR UPDATE: a condition with
    // expectedValue null asserts a key is ABSENT, and a row lock cannot lock a
    // nonexistent row — two concurrent absent-checks would both pass. Under
    // SERIALIZABLE the conflicting transaction is aborted (40001, or 40P01 when
    // it deadlocks), so exactly one writer wins. Retry the whole transaction
    // (re-reading every condition) on a retryable abort, waiting a jittered,
    // exponentially growing delay between attempts and bounded by the cap.
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt += 1) {
      try {
        return await this.#withTransaction(
          PG_BEGIN_SERIALIZABLE,
          async (client) => {
            if (!(await conditionsHold(client, this.#queries, checkedConditions))) {
              return false;
            }
            await writeBatchNetEffect(client, this.#queries, netEffect, writtenAt);
            return true;
          },
          // Only COMMIT when the CAS actually wrote (returned true). A precondition
          // mismatch (false) wrote nothing, so ROLL BACK — committing a read-only
          // SERIALIZABLE txn can abort with 40001 and turn a clean `false` into a
          // retried/thrown serialization failure.
          (committed) => committed,
        );
      } catch (error) {
        if (!isRetryableTransactionFailure(error)) {
          throw error;
        }
        lastError = error;
      }
      if (attempt + 1 < MAX_SERIALIZATION_RETRIES) {
        await this.#retryDelay(serializationRetryDelay(attempt, this.#retryRandom));
      }
    }

    // Never silently return false on exhaustion: that is indistinguishable from a
    // precondition mismatch and would corrupt compare-and-swap callers. The cause
    // carries the last abort (40001 serialization failure or 40P01 deadlock).
    throw new Error(
      `conditionalBatch exhausted ${MAX_SERIALIZATION_RETRIES} attempts after retryable transaction failures`,
      { cause: lastError },
    );
  }

  async query<T>(sql: string, parameters?: unknown[]): Promise<T[]> {
    await this.#ensureTable();
    // Two layers: a fast textual reject for obvious writes, then a real READ ONLY
    // transaction so Postgres rejects anything that mutates regardless of how the
    // statement is phrased — a data-modifying CTE (`WITH x AS (DELETE ...) SELECT`)
    // passes the textual check but errors at the database level here.
    assertReadOnlyQuery(sql);
    return this.#withTransaction(PG_BEGIN_READ_ONLY, async (client) => {
      const result = await client.query(sql, parameters ?? []);
      return result.rows as T[];
    });
  }

  /**
   * Close the owned pool exactly once, memoizing the shutdown so repeated disposal
   * (sync then async, or either called twice) reuses the same `end()` promise. A
   * no-op for an injected, caller-owned pool. Returns the shutdown promise so the
   * async path can await it.
   */
  #endPoolOnce(): Promise<void> {
    if (!this.#ownsPool) return Promise.resolve();
    this.#poolShutdown ??= this.#pool.end();
    return this.#poolShutdown;
  }

  [Symbol.dispose](): void {
    // Storage requires a synchronous dispose, but pool teardown is async. Fire the
    // one-time shutdown and swallow rejection so a teardown error never surfaces as
    // an unhandled rejection. `await using` callers get the awaited path via asyncDispose.
    void this.#endPoolOnce().catch(() => {
      // Best-effort teardown.
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#endPoolOnce();
  }
}
