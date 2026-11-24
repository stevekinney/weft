/**
 * One racing process of the cross-process SQLite contention tests. It runs under Bun for
 * `BunSQLiteStorage` and under Node for `NodeSQLiteStorage`, so it imports only what both
 * runtimes provide, and it imports the adapter from the module specifier its caller passes.
 *
 * Usage: `<runtime> sqlite-contention-child.test-support.ts <module> <export> <database> <mode> <tag>`
 *
 * The child opens the database, writes `ready-<tag>` beside it, and waits for a `go` file before
 * it races, so both processes start together instead of one finishing before the other boots.
 * It writes one JSON line, a `SqliteContentionReport`, to stdout. A throwing attempt is counted
 * and its message recorded; it never ends the run, because how many attempts threw is what the
 * parent asserts on.
 *
 * @module storage/sqlite-contention-child
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Storage } from '../interface.ts';
import {
  SQLITE_CONTENTION_ATTEMPTS_PER_PROCESS,
  SQLITE_CONTENTION_BATCH_PREFIX,
  SQLITE_CONTENTION_COUNTER_KEY,
  SQLITE_CONTENTION_KEYS_PER_BATCH,
  type SqliteContentionMode,
  type SqliteContentionReport,
} from './sqlite-contention.test-support.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the race needs of an adapter: both SQLite adapters implement `conditionalBatch`. */
type RacingStorage = Storage & Required<Pick<Storage, 'conditionalBatch'>> & Disposable;

async function openStorage(
  moduleSpecifier: string,
  exportName: string,
  databasePath: string,
): Promise<RacingStorage> {
  const adapterModule = (await import(moduleSpecifier)) as Record<string, unknown>;
  const Adapter = Object.hasOwn(adapterModule, exportName) ? adapterModule[exportName] : undefined;
  if (typeof Adapter !== 'function') {
    throw new TypeError(`${moduleSpecifier} has no adapter export named ${exportName}`);
  }
  return new (Adapter as new (path: string) => RacingStorage)(databasePath);
}

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

async function race(
  storage: RacingStorage,
  mode: SqliteContentionMode,
  tag: string,
): Promise<SqliteContentionReport> {
  const attempts = SQLITE_CONTENTION_ATTEMPTS_PER_PROCESS;
  const report: SqliteContentionReport = {
    tag,
    mode,
    attempts,
    committed: 0,
    rejected: 0,
    threw: 0,
    errors: [],
  };
  const errors = new Map<string, number>();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (mode === 'conditionalBatch') {
        const current = await storage.get(SQLITE_CONTENTION_COUNTER_KEY);
        const value = Number(decoder.decode(current ?? undefined));
        const committed = await storage.conditionalBatch(
          [{ key: SQLITE_CONTENTION_COUNTER_KEY, expectedValue: current }],
          [
            {
              type: 'put',
              key: SQLITE_CONTENTION_COUNTER_KEY,
              value: encoder.encode(String(value + 1)),
            },
          ],
        );
        if (committed) report.committed += 1;
        else report.rejected += 1;
      } else {
        await storage.batch(
          Array.from({ length: SQLITE_CONTENTION_KEYS_PER_BATCH }, (_, index) => ({
            type: 'put' as const,
            key: `${SQLITE_CONTENTION_BATCH_PREFIX}${tag}:${attempt}:${index}`,
            value: encoder.encode(`${tag}:${attempt}`),
          })),
        );
        report.committed += 1;
      }
    } catch (error) {
      report.threw += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.set(message, (errors.get(message) ?? 0) + 1);
    }
  }

  report.errors = [...errors];
  return report;
}

const [, , moduleSpecifier, exportName, databasePath, modeName, tag] = process.argv;
if (
  moduleSpecifier === undefined ||
  exportName === undefined ||
  databasePath === undefined ||
  (modeName !== 'conditionalBatch' && modeName !== 'batch') ||
  tag === undefined
) {
  throw new Error(
    `usage: <module> <export> <database> <conditionalBatch|batch> <tag>; got ${process.argv.slice(2).join(' ')}`,
  );
}

const directory = dirname(databasePath);
const storage = await openStorage(moduleSpecifier, exportName, databasePath);
try {
  writeFileSync(join(directory, `ready-${tag}`), '');
  await waitForFile(join(directory, 'go'));
  const report = await race(storage, modeName, tag);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  storage[Symbol.dispose]();
}
