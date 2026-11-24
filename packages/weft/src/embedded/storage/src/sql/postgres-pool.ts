import type { NeonQueryResult } from './neon-value-mapping.ts';
import type { SerializationRetryOptions } from './serialization-retry.ts';

/**
 * The pool seam and options every Postgres-wire storage adapter shares, split out of
 * `postgres-key-value-storage.ts` to keep that module focused on the `Storage` implementation.
 *
 * @module storage/postgres-pool
 */

/**
 * A connection that can run a single interactive transaction. Obtained from
 * {@link PostgresPool.connect}; `release()` returns it to the pool. Both
 * `batch()` and `conditionalBatch()` drive `BEGIN`/`COMMIT`/`ROLLBACK` over one
 * of these so every statement in a transaction lands on the same connection —
 * `pool.query()` alone may scatter statements across pooled connections, which
 * would make a multi-statement batch non-atomic.
 */
export type PostgresPoolClient = {
  query(sql: string, parameters?: unknown[]): Promise<NeonQueryResult>;
  release(): void;
};

/**
 * Minimal structural view of a node-postgres `Pool`. Both the `pg` `Pool` and
 * the Neon serverless `Pool` satisfy this; the PGlite test backend is wrapped to
 * satisfy it too. `query()` runs a single statement on a pooled connection (used
 * for the single-statement hot paths); `connect()` pins a connection for an
 * interactive transaction; `end()` tears the pool down.
 */
export type PostgresPool = {
  query(sql: string, parameters?: unknown[]): Promise<NeonQueryResult>;
  connect(): Promise<PostgresPoolClient>;
  end(): Promise<void>;
};

/**
 * Configuration shared by every Postgres-wire storage adapter (the native `pg`
 * {@link PostgresPool}-backed adapter and the Neon serverless one).
 */
export type PostgresKeyValueStorageOptions = {
  /**
   * Postgres connection string. Required only when no `pool` is supplied — the
   * adapter builds its own pool from this via the subclass's `poolFactory`. When
   * `pool` is given, `url` is ignored and may be omitted entirely.
   */
  url?: string;
  /**
   * Optional pre-built pool. Pass this to reuse a pool you manage (for example a
   * test backend such as PGlite, or a shared application pool), instead of having
   * the adapter construct its own from `url`. When supplied, `url` is ignored and
   * **ownership stays with the caller**: disposing the adapter does NOT close an
   * injected pool, so it can be shared across adapters and the caller remains
   * responsible for ending it. A pool the adapter constructs itself (from `url`)
   * IS closed on disposal.
   */
  pool?: PostgresPool;
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
  /**
   * How `conditionalBatch` backs off between `SERIALIZABLE` attempts. Defaults to a real
   * `setTimeout` sleep and `Math.random`; inject both to keep tests deterministic.
   */
  serializationRetry?: SerializationRetryOptions;
  /**
   * The clock each write's time is read from, in milliseconds since the Unix epoch. Defaults to
   * `Date.now`. Every put in one batch or conditional batch shares one reading.
   */
  now?: () => number;
};
