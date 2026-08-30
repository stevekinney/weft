import { createLazyPostgresPool } from './lazy-postgres-pool.ts';
import {
  PostgresKeyValueStorage,
  type PostgresKeyValueStorageOptions,
  type PostgresPool,
} from './postgres-key-value-storage.ts';

/**
 * Configuration for connecting {@link NeonStorage} to a Neon database.
 * `url` is optional and required only when no `pool` is supplied.
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
export type NeonStorageOptions = PostgresKeyValueStorageOptions;

/**
 * Construct the Neon serverless default pool for `url`, deferring the
 * `@neondatabase/serverless` import until the pool is first used, so the
 * injected-pool path (tests, a shared application pool) needs zero
 * `@neondatabase/serverless` install. The lazy-import memoization, dispose guards,
 * and missing-dependency error live in {@link createLazyPostgresPool}; this
 * factory only supplies HOW to load the driver. The driver's `Pool` is structurally
 * assignable to {@link PostgresPool} (a strict subset of its surface), so no cast
 * is needed; constructing it opens no socket, so deferring only moves the import,
 * not the connection, off the constructor.
 */
function neonPoolFactory(url: string): PostgresPool {
  return createLazyPostgresPool(url, {
    driverName: '@neondatabase/serverless',
    storageName: 'NeonStorage',
    loadPool: (connectionString) =>
      import('@neondatabase/serverless').then(({ Pool }) => new Pool({ connectionString })),
  });
}

/**
 * Storage adapter backed by Neon serverless Postgres for durable, remote
 * deployments. A thin {@link PostgresKeyValueStorage} subclass whose only job is
 * to supply the Neon serverless default pool factory; all storage behavior (SQL,
 * value mapping, transactions/retry, schema/table qualification) lives in the
 * driver-agnostic base. Implements the same `Storage` interface as the SQLite
 * adapters over a single `kv(key TEXT COLLATE "C", value BYTEA)` table, so
 * switching from a local SQLite store to Neon is a configuration change, not a
 * code change.
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
export class NeonStorage extends PostgresKeyValueStorage {
  /**
   * @param options Connection configuration ({@link NeonStorageOptions}).
   * @param poolFactory Internal seam for constructing the owned pool from `url`.
   *   Defaults to lazily importing the real Neon driver `Pool`; tests inject a
   *   fake (for example one whose `end()` rejects) to exercise owned-pool teardown
   *   without a network. Used only when no `pool` is supplied; an injected `pool`
   *   stays caller-owned.
   */
  constructor(
    options: NeonStorageOptions,
    poolFactory: (url: string) => PostgresPool = neonPoolFactory,
  ) {
    super(options, poolFactory);
  }
}
