/**
 * What the cross-process SQLite contention tests share: the race's size, the shape of what each
 * racing process reports, and the checks the parent runs on the combined result. It imports
 * nothing from `bun:test`, because the Node integration suite loads it too.
 *
 * Two OS processes open one database file and race through `BunSQLiteStorage` or
 * `NodeSQLiteStorage`. In `conditionalBatch` mode every attempt reads a counter and swaps it for
 * the value plus one, guarded on what it read, so a lost race must come back as `false`. In
 * `batch` mode every attempt writes a block of keys that no other attempt writes. Neither mode
 * may throw: a process that meets the other's write lock waits for it (COR-1624).
 *
 * @module storage/sqlite-contention
 */
import { fileURLToPath } from 'node:url';

/** Attempts each racing process makes. */
export const SQLITE_CONTENTION_ATTEMPTS_PER_PROCESS = 500;

/** Keys one `batch` attempt writes, so the write lock is held across several statements. */
export const SQLITE_CONTENTION_KEYS_PER_BATCH = 10;

/** The key the `conditionalBatch` race increments. */
export const SQLITE_CONTENTION_COUNTER_KEY = 'contention:counter';

/** The prefix every key the `batch` race writes starts with. */
export const SQLITE_CONTENTION_BATCH_PREFIX = 'contention:batch:';

/** Which operation the two racing processes contend with. */
export type SqliteContentionMode = 'conditionalBatch' | 'batch';

/**
 * The path of the racing-process entrypoint. A caller runs it as
 * `<runtime> <path> <module> <export> <database> <conditionalBatch|batch> <tag>`, where `<module>`
 * is the module specifier its adapter is imported from and `<export>` the adapter's export name.
 */
export const sqliteContentionChildPath: string = fileURLToPath(
  new URL('./sqlite-contention-child.test-support.ts', import.meta.url),
);

/** One racing process's report, written to its stdout as a single JSON line. */
export type SqliteContentionReport = {
  tag: string;
  mode: SqliteContentionMode;
  attempts: number;
  /** Attempts that committed: `conditionalBatch` returned `true`, or `batch` resolved. */
  committed: number;
  /** Attempts `conditionalBatch` answered `false` because another process got there first. */
  rejected: number;
  /** Attempts that threw, and how often each error message occurred. */
  threw: number;
  errors: [message: string, count: number][];
};

/** Parse the last JSON line a racing process wrote, or explain what it wrote instead. */
export function parseSqliteContentionReport(
  tag: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): SqliteContentionReport {
  const lines = stdout.trim().split('\n');
  const last = lines.at(-1);
  if (exitCode !== 0 || last === undefined || !last.startsWith('{')) {
    throw new Error(
      `racing process ${tag} exited with ${String(exitCode)} and no report\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return JSON.parse(last) as SqliteContentionReport;
}

/**
 * What a race got wrong, as one message per violation. Empty means the race held, so a test
 * asserts the list equals `[]` and a failure prints every violation at once.
 *
 * `finalCounter` is the counter's value once both processes exit (`conditionalBatch` mode) and
 * `batchKeyCount` the number of keys under {@link SQLITE_CONTENTION_BATCH_PREFIX} (`batch` mode).
 */
export function describeSqliteContentionViolations(
  mode: SqliteContentionMode,
  reports: SqliteContentionReport[],
  observed: { finalCounter: number; batchKeyCount: number },
): string[] {
  const violations: string[] = [];
  if (reports.length !== 2) violations.push(`expected 2 reports, got ${reports.length}`);

  for (const report of reports) {
    if (report.attempts < SQLITE_CONTENTION_ATTEMPTS_PER_PROCESS) {
      violations.push(`${report.tag} made ${report.attempts} attempts`);
    }
    if (report.threw > 0) {
      violations.push(
        `${report.tag} threw on ${report.threw} of ${report.attempts} attempts: ${JSON.stringify(report.errors)}`,
      );
    }
    if (report.committed + report.rejected + report.threw !== report.attempts) {
      violations.push(`${report.tag}'s outcomes do not sum to its ${report.attempts} attempts`);
    }
  }

  const committed = reports.reduce((sum, report) => sum + report.committed, 0);
  if (mode === 'conditionalBatch' && observed.finalCounter !== committed) {
    violations.push(`counter ended at ${observed.finalCounter}, ${committed} attempts committed`);
  }
  if (mode === 'batch') {
    const expectedKeys = committed * SQLITE_CONTENTION_KEYS_PER_BATCH;
    if (observed.batchKeyCount !== expectedKeys) {
      violations.push(`${observed.batchKeyCount} keys stored, expected ${expectedKeys}`);
    }
    const rejected = reports.reduce((sum, report) => sum + report.rejected, 0);
    if (rejected !== 0) violations.push(`${rejected} plain batch attempts reported a rejection`);
  }
  return violations;
}
