import { Pool } from '@neondatabase/serverless';

import { normalizeDeleteRangeOptions, type DeleteRangeOptions } from './delete-range.ts';
import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from './interface.ts';
import {
  buildPostgresKeyRangeDelete,
  buildPostgresKeyRangeSelect,
  buildPostgresKeyValueRangeSelect,
  buildPostgresPrefixRangeParameters,
  PG_BEGIN_READ_COMMITTED,
  PG_BEGIN_SERIALIZABLE,
  PG_COMMIT,
  PG_COUNT_KEYS_BY_PREFIX,
  PG_CREATE_KEY_VALUE_TABLE,
  PG_DELETE_KEYS_BY_PREFIX,
  PG_DELETE_VALUE_BY_KEY,
  PG_ROLLBACK,
  PG_SELECT_KEY_PRESENCE,
  PG_SELECT_VALUE_BY_KEY,
  PG_UPSERT_VALUE_BY_KEY,
} from './postgres-key-value-queries.ts';
import { assertReadOnlyQuery } from './read-only-query.ts';
import { scopedStorage } from './scoped-storage.ts';

/**
 * The Postgres `SQLSTATE` for a serialization failure. A `SERIALIZABLE`
 * transaction that conflicts with a concurrent transaction is aborted with this
 * code; the only correct response is to retry the whole transaction from the
 * start (re-reading every condition), which is what `conditionalBatch` does.
 */
const POSTGRES_SERIALIZATION_FAILURE = '40001';

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
 * Minimal structural view of a node-postgres query result. The Neon serverless
 * driver and PGlite both return an object with a `rows` array; nothing else is
 * needed here, so the adapter depends only on this shape rather than the full
 * driver types. Keeping the seam minimal is what lets the PGlite test backend
 * stand in for the real `Pool` without pulling the optional dependency's types
 * into the build.
 */
type NeonQueryResult = {
  rows: Array<Record<string, unknown>>;
};

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

function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === POSTGRES_SERIALIZATION_FAILURE
  );
}

/**
 * Normalize a BYTEA value read back from Postgres into a `Uint8Array`. The Neon
 * driver returns a Node `Buffer`, which may be a view onto a larger pooled
 * `ArrayBuffer`; `new Uint8Array(buffer)` copies the bytes into a standalone
 * array so the value cannot be corrupted by buffer reuse. PGlite already returns
 * a `Uint8Array`, and copying it is harmless.
 */
function toStorageValue(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) {
    return new Uint8Array(raw);
  }
  // Some drivers hand back an ArrayBuffer or array-like; coerce defensively.
  return new Uint8Array(raw as ArrayBufferLike);
}

/**
 * Bind a storage value for a BYTEA parameter. node-postgres serializes a Node
 * `Buffer` as BYTEA; a bare `Uint8Array` can serialize incorrectly. `Buffer` is
 * a `Uint8Array` subclass, so PGlite accepts the same bound value — keeping a
 * single bind path means the PGlite test exercises exactly what Neon runs.
 */
function toBytea(value: Uint8Array): Buffer {
  return Buffer.from(value);
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
   * Optional pre-built pool. Provided so a test backend (e.g. PGlite) can stand
   * in for the real Neon serverless pool; production callers pass only `url` and
   * the adapter constructs the real pool. When supplied, `url` is ignored.
   */
  pool?: NeonPool;
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
  #initialized = false;

  constructor(options: NeonStorageOptions) {
    // The structural NeonPool type is a subset of the driver's Pool surface; the
    // driver is externalized in the build, so importing it at module top mirrors
    // the Turso adapter and keeps it out of bundles that never select Neon.
    this.#pool =
      options.pool ?? (new Pool({ connectionString: options.url }) as unknown as NeonPool);
  }

  capabilities(): StorageCapabilities {
    // Neon serverless Postgres, primary endpoint. A committed write is visible to
    // any later read through the same instance (linearizable on the primary);
    // each statement observes a consistent snapshot; batch() and conditionalBatch()
    // run inside a single transaction (atomic, compare-and-swap); deletePrefix and
    // deleteRange are single range-scoped DELETEs.
    return {
      persistence: 'remote',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  async #ensureTable(): Promise<void> {
    if (this.#initialized) return;
    await this.#pool.query(PG_CREATE_KEY_VALUE_TABLE);
    this.#initialized = true;
  }

  async get(key: string): Promise<Uint8Array | null> {
    await this.#ensureTable();
    const result = await this.#pool.query(PG_SELECT_VALUE_BY_KEY, [key]);
    const row = result.rows[0];
    if (row === undefined) return null;
    const raw = row['value'];
    if (raw === null || raw === undefined) return null;
    return toStorageValue(raw);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.#ensureTable();
    await this.#pool.query(PG_UPSERT_VALUE_BY_KEY, [key, toBytea(value)]);
  }

  async delete(key: string): Promise<void> {
    await this.#ensureTable();
    await this.#pool.query(PG_DELETE_VALUE_BY_KEY, [key]);
  }

  async has(key: string): Promise<boolean> {
    await this.#ensureTable();
    const result = await this.#pool.query(PG_SELECT_KEY_PRESENCE, [key]);
    return result.rows.length > 0;
  }

  async deletePrefix(prefix: string): Promise<number> {
    await this.#ensureTable();
    const [rangeStart, rangeEnd] = buildPostgresPrefixRangeParameters(prefix);
    const result = await this.#pool.query(PG_DELETE_KEYS_BY_PREFIX, [rangeStart, rangeEnd]);
    return result.rows.length;
  }

  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    await this.#ensureTable();
    const normalized = normalizeDeleteRangeOptions(options);
    const { parameters, sql } = buildPostgresKeyRangeDelete(prefix, normalized);
    const result = await this.#pool.query(sql, parameters);
    return result.rows.length;
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    await this.#ensureTable();
    const { parameters, sql } = buildPostgresKeyValueRangeSelect(prefix, options);
    const result = await this.#pool.query(sql, parameters);
    for (const row of result.rows) {
      yield [row['key'] as string, toStorageValue(row['value'])];
    }
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    await this.#ensureTable();
    const { parameters, sql } = buildPostgresKeyRangeSelect(prefix, options);
    const result = await this.#pool.query(sql, parameters);
    for (const row of result.rows) {
      yield row['key'] as string;
    }
  }

  async count(prefix: string): Promise<number> {
    await this.#ensureTable();
    const [rangeStart, rangeEnd] = buildPostgresPrefixRangeParameters(prefix);
    const result = await this.#pool.query(PG_COUNT_KEYS_BY_PREFIX, [rangeStart, rangeEnd]);
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
   */
  async #withTransaction<T>(
    beginStatement: typeof PG_BEGIN_SERIALIZABLE | typeof PG_BEGIN_READ_COMMITTED,
    runner: (client: NeonPoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query(beginStatement);
      try {
        const result = await runner(client);
        await client.query(PG_COMMIT);
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
    if (operations.length === 0) return;
    await this.#ensureTable();
    await this.#withTransaction(PG_BEGIN_READ_COMMITTED, async (client) => {
      await applyBatchOperations(client, operations);
    });
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    await this.#ensureTable();

    // SERIALIZABLE is required, not SELECT...FOR UPDATE: a condition with
    // expectedValue null asserts a key is ABSENT, and a row lock cannot lock a
    // nonexistent row — two concurrent absent-checks would both pass. Under
    // SERIALIZABLE the conflicting transaction is aborted with 40001 instead, so
    // exactly one writer wins. Retry the whole transaction (re-reading every
    // condition) on 40001, bounded by the retry cap.
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt += 1) {
      try {
        return await this.#withTransaction(PG_BEGIN_SERIALIZABLE, async (client) => {
          for (const condition of conditions) {
            const result = await client.query(PG_SELECT_VALUE_BY_KEY, [condition.key]);
            const raw = result.rows[0]?.['value'];
            const currentValue = raw === null || raw === undefined ? null : toStorageValue(raw);
            if (!storageValuesEqual(currentValue, condition.expectedValue)) {
              return false;
            }
          }
          await applyBatchOperations(client, operations);
          return true;
        });
      } catch (error) {
        if (!isSerializationFailure(error)) {
          throw error;
        }
        lastError = error;
      }
    }

    // Never silently return false on exhaustion: that is indistinguishable from a
    // precondition mismatch and would corrupt compare-and-swap callers.
    throw new Error(
      `conditionalBatch exhausted ${MAX_SERIALIZATION_RETRIES} serialization retries`,
      { cause: lastError },
    );
  }

  async query<T>(sql: string, parameters?: unknown[]): Promise<T[]> {
    await this.#ensureTable();
    assertReadOnlyQuery(sql);
    const result = await this.#pool.query(sql, parameters ?? []);
    return result.rows as T[];
  }

  [Symbol.dispose](): void {
    // Storage requires a synchronous dispose, but pool teardown is async. Fire it
    // and swallow rejection so a teardown error never surfaces as an unhandled
    // rejection. `await using` callers get the awaited path via asyncDispose.
    void this.#pool.end().catch(() => {
      // Best-effort teardown.
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#pool.end();
  }
}

/**
 * Apply a batch of put/delete operations on an already-open transaction client.
 * Shared by `batch()` and the write phase of `conditionalBatch()`.
 */
async function applyBatchOperations(
  client: NeonPoolClient,
  operations: BatchOperation[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.type === 'put') {
      await client.query(PG_UPSERT_VALUE_BY_KEY, [operation.key, toBytea(operation.value)]);
    } else {
      await client.query(PG_DELETE_VALUE_BY_KEY, [operation.key]);
    }
  }
}
