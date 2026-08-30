import { createLazyPostgresPool } from './lazy-postgres-pool.ts';
import {
  PostgresKeyValueStorage,
  type PostgresKeyValueStorageOptions,
  type PostgresPool,
  type PostgresPoolClient,
} from './postgres-key-value-storage.ts';

export type { PostgresPool, PostgresPoolClient };

/**
 * Configuration for connecting to a standard Postgres database over the ordinary
 * wire protocol via the `pg` (node-postgres) driver. Alias of the shared
 * {@link PostgresKeyValueStorageOptions}; `url` is optional and required only when
 * no `pool` is supplied.
 *
 * @example
 * ```ts
 * import { PostgresStorage, type PostgresStorageOptions } from '@lostgradient/weft/storage/postgres';
 *
 * const options: PostgresStorageOptions = {
 *   url: 'postgresql://user:password@localhost:5432/weft',
 * };
 * await using storage = new PostgresStorage(options);
 * ```
 */
export type PostgresStorageOptions = PostgresKeyValueStorageOptions;

/**
 * Construct the `pg` default pool for `url`, deferring the `pg` import until the
 * pool is first used, so the injected-pool path (tests, a shared application pool)
 * needs zero `pg` install. The lazy-import memoization, dispose guards, and
 * missing-dependency error live in {@link createLazyPostgresPool}; this factory
 * only supplies HOW to load the driver.
 *
 * A `pg.Pool` structurally satisfies {@link PostgresPool}: `query(sql, params)`,
 * `connect()`, and `end()` line up, a `pg.PoolClient` provides `query`/`release`,
 * and a `pg.QueryResult` (`{ rows, rowCount }`) satisfies the value mapper. The
 * default export is used so `pg`'s CommonJS interop resolves the `Pool`
 * constructor under both Bun and Node.
 */
function postgresPoolFactory(url: string): PostgresPool {
  return createLazyPostgresPool(url, {
    driverName: 'pg',
    storageName: 'PostgresStorage',
    loadPool: (connectionString) =>
      import('pg').then(({ default: pg }) => new pg.Pool({ connectionString })),
  });
}

/**
 * Storage adapter backed by a standard Postgres server over the ordinary wire
 * protocol via the `pg` (node-postgres) driver. A thin
 * {@link PostgresKeyValueStorage} subclass whose only job is to supply the `pg`
 * default pool factory; all storage behavior (SQL, value mapping,
 * transactions/retry, schema/table qualification) lives in the driver-agnostic
 * base. Implements the same `Storage` interface as the SQLite adapters over a
 * single `kv(key TEXT COLLATE "C", value BYTEA)` table.
 *
 * Use this instead of {@link NeonStorage} when connecting to a self-hosted or
 * managed Postgres over TCP — including sharing the same database as your
 * application's tables by pointing `schema` at a dedicated Weft schema. The Neon
 * serverless (WebSocket) driver is not required and never imported.
 *
 * **Endpoint assumption.** `capabilities()` reports `readAfterWrite:
 * 'linearizable'`, which holds for the **primary** endpoint. A read-replica
 * connection string would violate that guarantee — point this adapter at the
 * primary.
 *
 * @example
 * ```ts
 * import { PostgresStorage } from '@lostgradient/weft/storage/postgres';
 * import { Engine } from '@lostgradient/weft';
 *
 * await using storage = new PostgresStorage({
 *   url: process.env['DATABASE_URL']!,
 * });
 * await using engine = new Engine({ storage });
 * ```
 */
export class PostgresStorage extends PostgresKeyValueStorage {
  /**
   * @param options Connection configuration ({@link PostgresStorageOptions}).
   * @param poolFactory Internal seam for constructing the owned pool from `url`.
   *   Defaults to lazily importing the real `pg` `Pool`; tests inject a fake to
   *   exercise owned-pool teardown without a network. Used only when no `pool` is
   *   supplied; an injected `pool` stays caller-owned.
   */
  constructor(
    options: PostgresStorageOptions,
    poolFactory: (url: string) => PostgresPool = postgresPoolFactory,
  ) {
    super(options, poolFactory);
  }
}
