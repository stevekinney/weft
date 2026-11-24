/**
 * The durability suites' spec for `BunSQLiteStorage`: its adapter, the module its child entrypoints
 * import, and the raw `bun:sqlite` handle the suites open beside it. The suites themselves live in
 * `@lostgradient/storage/testing`.
 */

import { Database } from 'bun:sqlite';

import {
  isFullyCheckpointed,
  makeNullValueFailingBatch,
  type CheckpointResult,
  type RawHandleAdapterSpec,
} from "../../../storage/src/testing/index.ts";
import { BunSQLiteStorage } from '../bun-sql.ts';

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
      .prepare<{ busy: number; log: number; checkpointed: number }, []>(
        'PRAGMA wal_checkpoint(TRUNCATE)',
      )
      .all();
    const raw = rows[0];
    return { truncated: isFullyCheckpointed(raw, databasePath), raw };
  } finally {
    database.close();
  }
}

const BUN_SQLITE_RAW_HANDLE = {
  childImports: "import { Database } from 'bun:sqlite';",
  openSource: [
    'const database = new Database(databasePath);',
    "database.exec('PRAGMA journal_mode = WAL');",
    "database.exec('PRAGMA synchronous = NORMAL');",
  ].join('\n'),
};

/** The durability spec for `BunSQLiteStorage`. */
export const bunSqliteSpec: RawHandleAdapterSpec = {
  name: 'BunSQLiteStorage',
  exposesStandardSidecars: true,
  expectedCapabilities: {
    persistence: 'local',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
  child: {
    moduleSpecifier: import.meta.resolve('../bun-sql.ts'),
    exportName: 'BunSQLiteStorage',
    constructorArgument: 'path',
  },
  rawHandle: BUN_SQLITE_RAW_HANDLE,
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
