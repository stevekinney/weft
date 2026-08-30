/**
 * Per-adapter spec shared by the on-disk durability test suite.
 *
 * Each spec opens a disk-backed SQLite adapter, exposes its WAL-checkpoint
 * passthrough, and provides a deterministic in-transaction failure trigger
 * for {@link OpenedAdapter.makeFailingBatch}. The spec is internal to the
 * durability tests; nothing here is re-exported from the public testing
 * surface.
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { BunSQLiteStorage } from '../bun-sql.ts';
import type { BatchOperation, Storage } from '../interface.ts';
import { NodeSQLiteStorage } from '../node-sqlite.ts';
import { TursoStorage } from '../turso.ts';

type BetterSqliteRow = { busy: number; log: number; checkpointed: number };

/** Matches the surface of `BetterSqliteDatabase` in `src/storage/node-sqlite.ts`. */
type BetterSqliteDatabase = {
  pragma(source: string): unknown;
  close(): void;
};

type BetterSqliteConstructor = new (path: string) => BetterSqliteDatabase;

let cachedBetterSqlite: BetterSqliteConstructor | undefined;

function loadBetterSqlite3Locally(): BetterSqliteConstructor {
  if (cachedBetterSqlite !== undefined) return cachedBetterSqlite;
  // `createRequire` because this project is ESM and better-sqlite3 is a CJS
  // native binding. The intersection covers both ESM-default-export and
  // direct-export wrapper shapes — same pattern as `node-sqlite.ts`.
  const requireFromHere = createRequire(import.meta.url);
  const mod = requireFromHere('better-sqlite3') as BetterSqliteConstructor & {
    default?: BetterSqliteConstructor;
  };
  cachedBetterSqlite = typeof mod.default === 'function' ? mod.default : mod;
  return cachedBetterSqlite;
}

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

/** A disk-backed SQLite adapter under test. */
export type AdapterSpec = {
  name: 'BunSQLiteStorage' | 'NodeSQLiteStorage' | 'TursoStorage';
  /** Whether `${path}-wal` / `${path}-shm` sidecars are part of the on-disk surface. */
  exposesStandardSidecars: boolean;
  open(databasePath: string): Promise<OpenedAdapter>;
};

/**
 * Subset of {@link AdapterSpec} for adapters that expose a raw same-file
 * SQLite handle (`bun:sqlite` or `better-sqlite3`) outside the adapter's
 * own API. Excludes Turso because libSQL's local-file client does not
 * compose with the raw-handle pattern.
 */
export type BunOrNodeAdapterSpec = AdapterSpec & {
  name: 'BunSQLiteStorage' | 'NodeSQLiteStorage';
};

/**
 * Build a `mid:` batch whose `failAtIndex`-th entry carries a NULL value.
 *
 * The KV schema (`src/storage/sqlite-key-value-queries.ts`) declares
 * `value BLOB NOT NULL`, so a NULL value violates the column constraint and
 * the adapter's native transaction rolls back.
 */
function makeNullValueFailingBatch(failAtIndex: number, totalEntries: number): BatchOperation[] {
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
 * Issue `PRAGMA wal_checkpoint(TRUNCATE)` against the given database file.
 *
 * Opens a short-lived sibling `bun:sqlite` connection on the same file
 * because the adapter's own `query()` passthrough rejects parenthesized
 * PRAGMA statements (see `read-only-query.ts`). The sibling is finalized
 * before returning. The primary adapter connection MAY still be open at
 * this point — bun:sqlite with WAL mode supports multiple writers on the
 * same file. TRUNCATE will report `busy !== 0` if the primary is
 * holding a transaction snapshot at the moment of the call, and
 * {@link isFullyCheckpointed} will return false in that case so the
 * caller can detect the partial checkpoint. The WAL durability test
 * runs `checkpoint()` immediately after open and before any other work
 * on the checkpointer handle, so no read snapshot is held in practice.
 */
function bunSqliteCheckpoint(databasePath: string): CheckpointResult {
  const database = new Database(databasePath);
  try {
    const rows = database
      .prepare<
        { busy: number; log: number; checkpointed: number },
        []
      >('PRAGMA wal_checkpoint(TRUNCATE)')
      .all();
    const raw = rows[0];
    return { truncated: isFullyCheckpointed(raw, databasePath), raw };
  } finally {
    database.close();
  }
}

/**
 * A checkpoint is considered "fully checkpointed" only when the pragma row
 * reports `busy === 0` AND every WAL frame is mirrored into the main
 * database (`log === checkpointed`). The TRUNCATE variant additionally
 * resets the WAL file itself — after a successful run the `-wal` file is
 * either absent or zero bytes.
 */
function isFullyCheckpointed(row: BetterSqliteRow | undefined, databasePath: string): boolean {
  if (row === undefined) return false;
  if (row.busy !== 0) return false;
  if (row.log !== row.checkpointed) return false;
  const walPath = `${databasePath}-wal`;
  if (!existsSync(walPath)) return true;
  return statSync(walPath).size === 0;
}

const bunSqliteSpec: BunOrNodeAdapterSpec = {
  name: 'BunSQLiteStorage',
  exposesStandardSidecars: true,
  async open(databasePath: string) {
    const storage = new BunSQLiteStorage(databasePath);
    return {
      storage,
      databasePath,
      async checkpoint(): Promise<CheckpointResult> {
        return bunSqliteCheckpoint(databasePath);
      },
      async close(): Promise<void> {
        storage[Symbol.dispose]();
      },
      makeFailingBatch: makeNullValueFailingBatch,
    };
  },
};

const nodeSqliteSpec: BunOrNodeAdapterSpec = {
  name: 'NodeSQLiteStorage',
  exposesStandardSidecars: true,
  async open(databasePath: string) {
    const storage = new NodeSQLiteStorage(databasePath);
    return {
      storage,
      databasePath,
      async checkpoint(): Promise<CheckpointResult> {
        const BetterSqlite3Constructor = loadBetterSqlite3Locally();
        const database = new BetterSqlite3Constructor(databasePath);
        try {
          const raw = database.pragma('wal_checkpoint(TRUNCATE)') as
            | readonly BetterSqliteRow[]
            | BetterSqliteRow;
          const row = Array.isArray(raw) ? raw[0] : raw;
          return { truncated: isFullyCheckpointed(row, databasePath), raw };
        } finally {
          database.close();
        }
      },
      async close(): Promise<void> {
        storage[Symbol.dispose]();
      },
      makeFailingBatch: makeNullValueFailingBatch,
    };
  },
};

const tursoSpec: AdapterSpec = {
  name: 'TursoStorage',
  // libSQL local-file may or may not expose standard sidecars depending on
  // the bundled client. Treat as false by default; the sidecar test routes
  // Turso to a libSQL-shaped equivalent (write/close/reopen with a fresh
  // client against the same `file:` URL).
  exposesStandardSidecars: false,
  async open(databasePath: string) {
    const storage = new TursoStorage({ url: `file:${databasePath}` });
    return {
      storage,
      databasePath,
      async checkpoint(): Promise<CheckpointResult> {
        // Turso's local-file client controls its own checkpointing; we do
        // not have a stable passthrough. The sidecar test does not call
        // checkpoint() for Turso, so this is a no-op success.
        return { truncated: true, raw: { note: 'libsql local-file: no explicit pragma path' } };
      },
      async close(): Promise<void> {
        storage[Symbol.dispose]();
      },
      makeFailingBatch: makeNullValueFailingBatch,
    };
  },
};

/**
 * Whether `better-sqlite3` is loadable in the current runtime. Bun cannot
 * load better-sqlite3's native bindings (oven-sh/bun#4290), so Node-SQLite
 * integration tests run only when the suite is invoked under Node. Mirrors
 * the gating pattern in `src/storage/node-sqlite.test.ts`.
 */
const IS_BUN = typeof globalThis.Bun !== 'undefined';
let nodeSqliteAvailable: boolean | undefined;
function canLoadNodeSqlite(): boolean {
  if (nodeSqliteAvailable !== undefined) return nodeSqliteAvailable;
  if (IS_BUN) {
    nodeSqliteAvailable = false;
    return false;
  }
  try {
    new NodeSQLiteStorage(':memory:')[Symbol.dispose]();
    nodeSqliteAvailable = true;
  } catch {
    nodeSqliteAvailable = false;
  }
  return nodeSqliteAvailable;
}

/** All adapter specs available in the current runtime. */
export function availableAdapterSpecs(): readonly AdapterSpec[] {
  const specs: AdapterSpec[] = [bunSqliteSpec, tursoSpec];
  if (canLoadNodeSqlite()) specs.push(nodeSqliteSpec);
  return specs;
}

/** Bun+Node specs only — used by tests that require a raw client path. */
export function availableBunNodeAdapterSpecs(): readonly BunOrNodeAdapterSpec[] {
  const specs: BunOrNodeAdapterSpec[] = [bunSqliteSpec];
  if (canLoadNodeSqlite()) specs.push(nodeSqliteSpec);
  return specs;
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
  readonly #directories: string[] = [];
  #failed = false;

  makeTempDirectory(label: string): string {
    const directory = join(tmpdir(), `weft-durability-${label}-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    this.#directories.push(directory);
    return directory;
  }

  markFailed(): void {
    this.#failed = true;
  }

  cleanup(): void {
    if (this.#failed) return;
    if (process.env['WEFT_KEEP_DURABILITY_FIXTURES'] === '1') return;
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
