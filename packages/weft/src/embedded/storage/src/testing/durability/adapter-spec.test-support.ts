/**
 * The adapter-independent half of the on-disk durability suites: what a spec for a disk-backed
 * SQLite adapter provides, the per-test fixture directories, and the helpers every spec shares.
 *
 * A spec carries its adapter, the module specifier a child entrypoint imports it from, and, for
 * adapters with a raw same-file SQLite handle, the source that opens that handle. Each adapter's
 * package defines its specs and runs the suites with them; storage runs them against no adapter.
 *
 * @module testing/durability/adapter-spec
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StorageCapabilities } from '../../capabilities.ts';
import { resolveStorageEnvironment } from '../../environment-configuration.ts';
import type { BatchOperation, Storage } from '../../interface.ts';

/** The row `PRAGMA wal_checkpoint(TRUNCATE)` reports. */
export type WalCheckpointRow = { busy: number; log: number; checkpointed: number };

/** Evidence returned by {@link OpenedAdapter.checkpoint}. */
export type CheckpointResult = {
  /** True when the WAL was reset by `PRAGMA wal_checkpoint(TRUNCATE)`. */
  truncated: boolean;
  /** Raw passthrough row, for diagnostics. */
  raw: unknown;
};

/** Handle returned by {@link AdapterSpec.open}. */
export type OpenedAdapter = {
  storage: Storage;
  databasePath: string;
  /** Force a full WAL checkpoint and report whether it truncated. */
  checkpoint(): Promise<CheckpointResult>;
  /** Close the adapter and any side connections opened for diagnostics. */
  close(): Promise<void>;
  /**
   * Build a batch the adapter accepts but whose `failAtIndex`-th entry
   * triggers a SQLite constraint violation inside the adapter's own native
   * transaction. `totalEntries` is the full batch length, including the
   * failing entry. Test-only; uses casts to construct an invalid put.
   */
  makeFailingBatch(failAtIndex: number, totalEntries: number): BatchOperation[];
};

/** How a child entrypoint imports and opens a spec's adapter. */
export type AdapterChildModule = {
  /** The module specifier (a `file:` URL or a package specifier) the child imports the adapter from. */
  readonly moduleSpecifier: string;
  /** The adapter class's export name in that module. */
  readonly exportName: string;
  /** The JavaScript expression, over a `path` variable, passed to the adapter's constructor. */
  readonly constructorArgument: string;
};

/** A disk-backed SQLite adapter under test. */
export type AdapterSpec = {
  /** The adapter's name, used in suite titles. */
  name: string;
  /** Whether `${path}-wal` / `${path}-shm` sidecars are part of the on-disk surface. */
  exposesStandardSidecars: boolean;
  /** The capabilities the adapter reports, which the batch-atomicity suite asserts. */
  expectedCapabilities: StorageCapabilities;
  /** How a child entrypoint imports and opens the adapter. */
  child: AdapterChildModule;
  /** Open the adapter on a database file. */
  open(databasePath: string): Promise<OpenedAdapter>;
};

/** How a child entrypoint opens a raw same-file SQLite handle beside the adapter. */
export type RawHandleHooks = {
  /** Import lines the raw-handle source needs. */
  readonly childImports: string;
  /**
   * Statements, over a `databasePath` variable, that bind `database` to a raw handle with the
   * adapter's pragmas mirrored. The handle has `exec(sql)` and `prepare(sql).run(...values)`.
   */
  readonly openSource: string;
};

/**
 * An {@link AdapterSpec} for an adapter that exposes a raw same-file SQLite handle (`bun:sqlite` or
 * `better-sqlite3`) outside the adapter's own API. libSQL's local-file client does not compose with
 * the raw-handle pattern, so Turso has no such spec.
 */
export type RawHandleAdapterSpec = AdapterSpec & {
  /** How a child opens the raw handle. */
  rawHandle: RawHandleHooks;
};

/**
 * Build a `mid:` batch whose `failAtIndex`-th entry carries a NULL value.
 *
 * The KV schema (`@lostgradient/storage/sql`'s `sqlite-key-value-queries.ts`) declares
 * `value BLOB NOT NULL`, so a NULL value violates the column constraint and
 * the adapter's native transaction rolls back.
 */
export function makeNullValueFailingBatch(
  failAtIndex: number,
  totalEntries: number,
): BatchOperation[] {
  const operations: BatchOperation[] = [];
  for (let index = 0; index < totalEntries; index++) {
    const key = `mid:${index.toString().padStart(6, '0')}`;
    if (index === failAtIndex) {
      // Intentional constraint violation: NULL into `value BLOB NOT NULL`
      // forces SQLITE_CONSTRAINT inside the adapter's native transaction,
      // which rolls back all prior puts in the same batch.
      operations.push({ type: 'put', key, value: null as unknown as Uint8Array });
    } else {
      operations.push({ type: 'put', key, value: new Uint8Array([index & 0xff]) });
    }
  }
  return operations;
}

/**
 * A checkpoint is considered "fully checkpointed" only when the pragma row
 * reports `busy === 0` AND every WAL frame is mirrored into the main
 * database (`log === checkpointed`). The TRUNCATE variant additionally
 * resets the WAL file itself — after a successful run the `-wal` file is
 * either absent or zero bytes.
 */
export function isFullyCheckpointed(
  row: WalCheckpointRow | undefined,
  databasePath: string,
): boolean {
  if (row === undefined) return false;
  if (row.busy !== 0) return false;
  if (row.log !== row.checkpointed) return false;
  const walPath = `${databasePath}-wal`;
  if (!existsSync(walPath)) return true;
  return statSync(walPath).size === 0;
}

/**
 * Best-effort close of an {@link OpenedAdapter}, suppressing any error so a
 * duplicate close in a `finally` block does not mask the primary assertion
 * failure that caused us to reach the finally in the first place.
 */
export async function closeIfOpen(handle: OpenedAdapter | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // best-effort — see JSDoc for why we swallow.
  }
}

/**
 * Per-test fixture tracker.
 *
 * Each test owns its own scope so a later passing test's cleanup never
 * removes a prior failing test's preserved directories. Set
 * `WEFT_KEEP_DURABILITY_FIXTURES=1` in the environment to retain
 * directories regardless of outcome.
 */
export class FixtureScope {
  /**
   * Make a fresh directory under the system temporary directory, owned by this scope.
   *
   * @param label - a plain fragment naming the directory's purpose
   */
  readonly #directories: string[] = [];
  #failed = false;

  makeTempDirectory(label: string): string {
    const directory = join(tmpdir(), `weft-durability-${label}-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    this.#directories.push(directory);
    return directory;
  }

  /** Keep this scope's directories at cleanup, because its test failed. */
  markFailed(): void {
    this.#failed = true;
  }

  /** Remove this scope's directories, unless its test failed or fixtures are kept. */
  cleanup(): void {
    if (this.#failed) return;
    if (resolveStorageEnvironment().keepDurabilityFixtures) return;
    while (this.#directories.length > 0) {
      const directory = this.#directories.pop();
      if (directory === undefined) break;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}
