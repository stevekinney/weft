import type { PostgresPool } from './postgres-key-value-storage.ts';

/**
 * Options for {@link createLazyPostgresPool}.
 */
export type LazyPostgresPoolOptions = {
  /** npm package name of the driver, used in the missing-dependency error. */
  readonly driverName: string;
  /** Adapter class name, used in the missing-dependency error. */
  readonly storageName: string;
  /**
   * Import the driver and construct its connection pool for `url`. Called at most
   * once, on first use. Kept as a callback so this module never imports a specific
   * driver — Neon and Postgres pass their own.
   */
  readonly loadPool: (url: string) => Promise<PostgresPool>;
};

/**
 * Build a {@link PostgresPool} whose driver module is imported lazily on first use
 * and whose owned connection pool is torn down exactly once. Shared by
 * `NeonStorage` and `PostgresStorage`: both differ only in WHICH driver they load,
 * so the lazy-import memoization, the dispose-before/after-use guards, and the
 * actionable "optional peer dependency" error live here once instead of being
 * copy-pasted into each factory.
 *
 * Behavior:
 * - **Lazy + memoized:** `loadPool` runs at most once, on the first
 *   `query`/`connect`. The injected-pool path never reaches here, so it never
 *   imports the driver.
 * - **Disposed is terminal:** after `end()`, any further `query`/`connect` throws
 *   rather than silently building a fresh, unreachable pool (which would leak
 *   connections and keep the process alive — the bug a naive
 *   `if (poolPromise === undefined) return` guard introduces).
 * - **End is safe:** `end()` before first use is a no-op (nothing was built); a
 *   failed import leaves nothing to close.
 * - **Missing driver is actionable:** a module-resolution failure is rewrapped as
 *   an install hint naming the package, matching the SQLite adapters' DX.
 */
export function createLazyPostgresPool(
  url: string,
  options: LazyPostgresPoolOptions,
): PostgresPool {
  let poolPromise: Promise<PostgresPool> | undefined;
  let endPromise: Promise<void> | undefined;
  let disposed = false;

  const resolvePool = (): Promise<PostgresPool> => {
    if (disposed) {
      throw new Error(
        `${options.storageName} pool has been disposed and cannot be reused. Construct a new adapter.`,
      );
    }
    poolPromise ??= options.loadPool(url).catch((error: unknown) => {
      // Let a transient failure (or a since-installed driver) retry on the next
      // call instead of memoizing the rejection forever.
      poolPromise = undefined;
      throw asDriverLoadError(error, options);
    });
    return poolPromise;
  };

  return {
    query: async (sql, parameters) => {
      const pool = await resolvePool();
      return pool.query(sql, parameters);
    },
    connect: async () => {
      const pool = await resolvePool();
      return pool.connect();
    },
    end: async () => {
      disposed = true;
      // Memoized so repeated dispose closes the built pool exactly once.
      endPromise ??= (async () => {
        if (poolPromise === undefined) return;
        // A rejected import has no pool to close; swallow it so dispose stays clean.
        const pool = await poolPromise.catch(() => undefined);
        await pool?.end();
      })();
      return endPromise;
    },
  };
}

const MODULE_NOT_FOUND = /cannot find module|module_not_found|failed to resolve|could not resolve/i;

/**
 * Rewrap a driver-load failure. A missing optional peer dependency becomes an
 * actionable install hint (naming the package + both bun/npm commands); any other
 * failure passes through unchanged (with its original message preserved).
 */
function asDriverLoadError(error: unknown, options: LazyPostgresPoolOptions): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (MODULE_NOT_FOUND.test(message)) {
    return new Error(
      `${options.storageName} requires the optional peer dependency "${options.driverName}". ` +
        `Install it in your application with: bun add ${options.driverName} ` +
        `(or npm install ${options.driverName}).`,
      { cause: error },
    );
  }
  return error instanceof Error ? error : new Error(message);
}
