import { Pool } from '@neondatabase/serverless';

import { normalizeDeleteRangeOptions, type DeleteRangeOptions } from './delete-range.ts';
import {
  assertStorageBatchOperationCount,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from './interface.ts';
import { conditionsHold, writeBatchNetEffect } from './neon-batch.ts';
import {
  affectedRowCount,
  resolveBatchNetEffect,
  toBytea,
  toStorageValue,
  type NeonQueryResult,
} from './neon-value-mapping.ts';
import {
  buildPostgresCreateSchema,
  buildPostgresKeyValueQueries,
  buildPostgresPrefixRangeParameters,
  PG_BEGIN_READ_COMMITTED,
  PG_BEGIN_READ_ONLY,
  PG_BEGIN_SERIALIZABLE,
  PG_COMMIT,
  PG_ROLLBACK,
  resolvePostgresTableReference,
  type PostgresKeyValueQueries,
} from './postgres-key-value-queries.ts';
import { assertReadOnlyQuery } from './read-only-query.ts';
import { scopedStorage } from './scoped-storage.ts';

/**
 * Postgres `SQLSTATE`s that abort a transaction but mean "retry from the start",
 * not "the operation is invalid":
 * - `40001` serialization_failure — a `SERIALIZABLE` transaction conflicted with
 *   a concurrent one and was rolled back.
 * - `40P01` deadlock_detected — two transactions touched overlapping rows in
 *   different orders; Postgres rolled one back as the deadlock victim. Two CAS
 *   calls gated on different keys can deadlock, so this must converge through the
 *   same retry path rather than escape as an engine error.
 *
 * A unique-violation (`23505`) is intentionally NOT retryable here: every write
 * goes through `INSERT ... ON CONFLICT (key) DO UPDATE`, which resolves a key
 * collision instead of raising `23505`, so it cannot occur on this UPSERT shape.
 *
 * The deadlock victim's rollback is total, so retrying the whole
 * `BEGIN → read → compare → write → COMMIT` cycle (re-reading every condition) is
 * as safe for `40P01` as for `40001`.
 */
const RETRYABLE_TRANSACTION_FAILURES = new Set(['40001', '40P01']);

/**
 * Cap on `SERIALIZABLE` retries for a single `conditionalBatch`. A conflict
 * means a concurrent writer touched an overlapping row; under the singleton
 * deployment Weft targets, contention is bounded, so a small cap is enough.
 * On exhaustion the call throws rather than silently returning `false` — a
 * silent `false` would look like a precondition mismatch and corrupt the
 * compare-and-swap callers (start idempotency, quota reservation) depend on.
 */
const MAX_SERIALIZATION_RETRIES = 5;

/**
 * A connection that can run a single interactive transaction. Obtained from
 * {@link NeonPool.connect}; `release()` returns it to the pool. Both
 * `batch()` and `conditionalBatch()` drive `BEGIN`/`COMMIT`/`ROLLBACK` over one
 * of these so every statement in a transaction lands on the same connection —
 * `pool.query()` alone may scatter statements across pooled connections, which
 * would make a multi-statement batch non-atomic.
 */
export type NeonPoolClient = {
  query(sql: string, parameters?: unknown[]): Promise<NeonQueryResult>;
  release(): void;
};

/**
 * Minimal structural view of a node-postgres `Pool`. The real Neon serverless
 * `Pool` satisfies this; the PGlite test backend is wrapped to satisfy it too.
 * `query()` runs a single statement on a pooled connection (used for the
 * single-statement hot paths); `connect()` pins a connection for an interactive
 * transaction; `end()` tears the pool down.
 */
export type NeonPool = {
  query(sql: string, parameters?: unknown[]): Promise<NeonQueryResult>;
  connect(): Promise<NeonPoolClient>;
  end(): Promise<void>;
};

function isRetryableTransactionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE_TRANSACTION_FAILURES.has(code);
}

/**
 * Configuration for connecting to a Neon (or any Postgres) database.
 *
 * @example
 * ```ts
 * import { NeonStorage, type NeonStorageOptions } from '@lostgradient/weft/storage/neon';
 *
 * const options: NeonStorageOptions = {
 *   url: 'postgresql://user:password@ep-cool-name.us-east-2.aws.neon.tech/weft?sslmode=require',
 * };
 * await using storage = new NeonStorage(options);
 * ```
 */
export type NeonStorageOptions = {
  /** Postgres connection string for the primary endpoint. */
  url: string;
  /**
   * Optional pre-built pool. Pass this to reuse a pool you manage (for example a
   * test backend such as PGlite, or a shared application pool), instead of having
   * the adapter construct its own from `url`. When supplied, `url` is ignored and
   * **ownership stays with the caller**: disposing the `NeonStorage` does NOT
   * close an injected pool, so it can be shared across adapters and the caller
   * remains responsible for ending it. A pool the adapter constructs itself (from
   * `url`) IS closed on disposal.
   */
  pool?: NeonPool;
  /**
   * Postgres schema to contain the kv table. Default: unqualified — the table
   * resolves through `search_path` (in practice `public`). When set, the adapter
   * creates the schema if absent (`CREATE SCHEMA IF NOT EXISTS`) and qualifies
   * every statement as `"schema"."table"`. Lets Weft live in its own schema
   * alongside the application's tables in one database — one PITR line, no Drizzle
   * drift/drop risk. Validated as a strict Postgres identifier at construction.
   */
  schema?: string;
  /**
   * Table name. Default: `'kv'`. Validated as a strict Postgres identifier at
   * construction. With neither `schema` nor `table` set, the adapter emits
   * byte-identical SQL against the unqualified `kv` table (existing deployments
   * are unaffected).
   */
  table?: string;
};

/**
 * Storage adapter backed by Neon serverless Postgres for durable, remote
 * deployments. Implements the same `Storage` interface as the SQLite adapters
 * over a single `kv(key TEXT COLLATE "C", value BYTEA)` table, so switching from
 * a local SQLite store to Neon is a configuration change, not a code change.
 *
 * **Endpoint assumption.** `capabilities()` reports `readAfterWrite:
 * 'linearizable'`, which holds for the **primary** Neon endpoint. A read-replica
 * connection string would violate that guarantee — point this adapter at the
 * primary.
 *
 * **WebSocket runtime.** The Neon serverless driver connects over WebSocket. Bun
 * and Node 22+ provide a global `WebSocket`, so no extra wiring is needed there.
 * On Node ≤21 the driver needs `neonConfig.webSocketConstructor` set to the `ws`
 * package before first use; install `ws` and configure it in that runtime.
 *
 * @example
 * ```ts
 * import { NeonStorage } from '@lostgradient/weft/storage/neon';
 * import { Engine } from '@lostgradient/weft';
 *
 * await using storage = new NeonStorage({
 *   url: process.env['NEON_DATABASE_URL']!,
 * });
 * await using engine = new Engine({ storage });
 * ```
 */
export class NeonStorage implements Storage {
  #pool: NeonPool;
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

  /**
   * @param options Connection configuration ({@link NeonStorageOptions}).
   * @param poolFactory Internal seam for constructing the owned pool from `url`.
   *   Defaults to the real driver `Pool`; tests inject a fake (for example one
   *   whose `end()` rejects) to exercise owned-pool teardown without a network.
   *   Used only when no `pool` is supplied; an injected `pool` stays caller-owned.
   */
  constructor(
    options: NeonStorageOptions,
    poolFactory: (url: string) => NeonPool = (url) => new Pool({ connectionString: url }),
  ) {
    this.#ownsPool = options.pool === undefined;
    // The driver's Pool is structurally assignable to NeonPool (NeonPool is a
    // strict subset of its surface), so the default factory needs no cast.
    this.#pool = options.pool ?? poolFactory(options.url);
    this.#schema = options.schema;
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
    // Neon serverless Postgres, primary endpoint: linearizable read-after-write,
    // snapshot scans, transactional atomic + compare-and-swap batches, and
    // single range-scoped DELETEs for deletePrefix/deleteRange.
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
    // Create the configured schema first so the schema-qualified CREATE TABLE
    // resolves. Skipped entirely for the default (unqualified) deployment.
    if (this.#schema !== undefined) {
      await this.#pool.query(buildPostgresCreateSchema(this.#schema));
    }
    await this.#pool.query(this.#queries.createTable);
    await this.#assertKeyCollation();
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
      `NeonStorage requires the ${this.#queries.tableReference} table's "key" column to use COLLATE "C" (found ${found}). A table created without COLLATE "C" sorts keys by the database locale, which breaks Weft's lexicographic prefix scans. Use a fresh table, or recreate it as: CREATE TABLE ${this.#queries.tableReference} (key TEXT COLLATE "C" PRIMARY KEY, value BYTEA NOT NULL).`,
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
    await this.#pool.query(this.#queries.upsertValueByKey, [key, toBytea(value)]);
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

  async deletePrefix(prefix: string): Promise<number> {
    await this.#ensureTable();
    const [rangeStart, rangeEnd] = buildPostgresPrefixRangeParameters(prefix);
    const result = await this.#pool.query(this.#queries.deleteKeysByPrefix, [rangeStart, rangeEnd]);
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
    const [rangeStart, rangeEnd] = buildPostgresPrefixRangeParameters(prefix);
    const result = await this.#pool.query(this.#queries.countKeysByPrefix, [rangeStart, rangeEnd]);
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
      | typeof PG_BEGIN_SERIALIZABLE
      | typeof PG_BEGIN_READ_COMMITTED
      | typeof PG_BEGIN_READ_ONLY,
    runner: (client: NeonPoolClient) => Promise<T>,
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
    await this.#ensureTable();
    await this.#withTransaction(PG_BEGIN_READ_COMMITTED, async (client) => {
      await writeBatchNetEffect(client, this.#queries, resolveBatchNetEffect(operations));
    });
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
    assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

    await this.#ensureTable();

    // Resolve the write net effect once, outside the retry loop — it is
    // deterministic input, so recomputing per retry would be wasted work.
    const netEffect = resolveBatchNetEffect(operations);

    // SERIALIZABLE is required, not SELECT...FOR UPDATE: a condition with
    // expectedValue null asserts a key is ABSENT, and a row lock cannot lock a
    // nonexistent row — two concurrent absent-checks would both pass. Under
    // SERIALIZABLE the conflicting transaction is aborted (40001, or 40P01 when
    // it deadlocks), so exactly one writer wins. Retry the whole transaction
    // (re-reading every condition) on a retryable abort, bounded by the cap.
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt += 1) {
      try {
        return await this.#withTransaction(
          PG_BEGIN_SERIALIZABLE,
          async (client) => {
            if (!(await conditionsHold(client, this.#queries, conditions))) {
              return false;
            }
            await writeBatchNetEffect(client, this.#queries, netEffect);
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
    }

    // Never silently return false on exhaustion: that is indistinguishable from a
    // precondition mismatch and would corrupt compare-and-swap callers. The cause
    // carries the last abort (40001 serialization failure or 40P01 deadlock).
    throw new Error(
      `conditionalBatch exhausted ${MAX_SERIALIZATION_RETRIES} retries after retryable transaction failures`,
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
