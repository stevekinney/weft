import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { resolveCliEnvironment } from '../runtime/environment-configuration.ts';
import { loadBetterSqlite3ForTest } from './node-sqlite-loader.ts';
import { NodeSQLiteStorage } from './node-sqlite.ts';

// The loader distinguishes the three ways a better-sqlite3 load can fail, because
// their remedies differ and a single catch-all sentence hid an unbuilt binding
// behind "the dependency is missing" for three investigations (COR-1278).
const MISSING_BETTER_SQLITE_ERROR =
  'NodeSQLiteStorage requires the optional peer dependency "better-sqlite3". Install it in your application with: bun add better-sqlite3 (or npm install better-sqlite3).';
const UNBUILT_BETTER_SQLITE_BINDING_ERROR =
  'NodeSQLiteStorage found "better-sqlite3" installed, but its native binding was never compiled';
const REFUSED_BETTER_SQLITE_BINDING_ERROR =
  'NodeSQLiteStorage could not load the "better-sqlite3" native binding in this runtime.';

// better-sqlite3 uses native bindings that aren't supported in Bun.
// Bun launches the native integration cases in a Node subprocess and checks
// their terminal result alongside the injected-constructor tests below.
const IS_BUN = typeof globalThis.Bun !== 'undefined';

type FakeRow = { key: string; value: Uint8Array };

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function createFakeDatabaseConstructor() {
  let closed = false;
  const values = new Map<string, Uint8Array>();
  const preparedSql = new Set<string>();
  const pragmas: string[] = [];

  class FakeDatabase {
    pragma(source: string): void {
      pragmas.push(source);
    }

    exec(): void {}

    prepare(source: string) {
      preparedSql.add(source);

      if (source === 'SELECT value FROM kv WHERE key = ?') {
        return {
          get(key: string) {
            const value = values.get(key);
            return value ? { value } : undefined;
          },
          run() {},
          all() {
            return [];
          },
        };
      }

      if (
        source ===
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ) {
        return {
          run(key: string, value: Uint8Array) {
            values.set(key, new Uint8Array(value));
          },
          get() {
            return undefined;
          },
          all() {
            return [];
          },
        };
      }

      if (source === 'DELETE FROM kv WHERE key = ?') {
        return {
          run(key: string) {
            values.delete(key);
          },
          get() {
            return undefined;
          },
          all() {
            return [];
          },
        };
      }

      if (source.startsWith('SELECT key, value FROM kv WHERE ')) {
        return {
          run() {},
          get() {
            return undefined;
          },
          all(...parameters: unknown[]): FakeRow[] {
            let index = 0;
            const prefix = parameters[index++] as string;
            const prefixEnd = parameters[index++] as string;
            const gt = source.includes('key > ?') ? (parameters[index++] as string) : undefined;
            const gte = source.includes('key >= ? AND key < ? AND key >= ?')
              ? (parameters[index++] as string)
              : undefined;
            const lt = source.includes('key < ? AND key < ? ORDER')
              ? (parameters[index++] as string)
              : undefined;
            const lte = source.includes('key <= ?') ? (parameters[index++] as string) : undefined;
            const limit = source.includes('LIMIT ?') ? (parameters[index++] as number) : undefined;

            let rows = [...values.entries()]
              .filter(([key]) => key >= prefix && key < prefixEnd)
              .filter(([key]) => (gt === undefined ? true : key > gt))
              .filter(([key]) => (gte === undefined ? true : key >= gte))
              .filter(([key]) => (lt === undefined ? true : key < lt))
              .filter(([key]) => (lte === undefined ? true : key <= lte))
              .toSorted(([left], [right]) => compareKeys(left, right))
              .map(([key, value]) => ({ key, value: new Uint8Array(value) }));

            if (source.includes('ORDER BY key DESC')) {
              rows = rows.toReversed();
            }

            if (limit !== undefined) {
              rows = rows.slice(0, limit);
            }

            return rows;
          },
        };
      }

      throw new Error(`Unexpected SQL in fake database: ${source}`);
    }

    transaction<TArguments extends unknown[], TResult>(fn: (...entries: TArguments) => TResult) {
      return (...entries: unknown[]): unknown => fn(...(entries as TArguments));
    }

    close(): void {
      closed = true;
    }
  }

  return {
    Database: FakeDatabase as unknown as new (path: string) => FakeDatabase,
    isClosed: () => closed,
    preparedSql,
    pragmas,
  };
}

describe('NodeSQLiteStorage', () => {
  it('throws a clear runtime error when the better-sqlite3 package is missing', () => {
    // Inject a throwing module resolver instead of mocking `node:module`. Bun's
    // `mock.module('node:module', ...)` patches the CJS loader process-wide and
    // `mock.restore()` does not revert it, which poisons `require()` for every
    // later test in the same process. The injected-resolver seam tests the same
    // missing-dependency path with no global side effect.
    expect(() =>
      loadBetterSqlite3ForTest(() => {
        const error = new Error("Cannot find module 'better-sqlite3'") as Error & { code: string };
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }),
    ).toThrow(MISSING_BETTER_SQLITE_ERROR);
  });

  it('reports a refused native binding as a runtime problem, not a missing package', () => {
    // Simulate better-sqlite3's native binding failing to dlopen under Bun: the
    // require itself rejects with ERR_DLOPEN_FAILED. The compiled addon is present,
    // so telling the caller to install the package would be wrong advice.
    expect(() =>
      loadBetterSqlite3ForTest(() => {
        const error = new Error("'better-sqlite3' is not yet supported in Bun.") as Error & {
          code: string;
        };
        error.code = 'ERR_DLOPEN_FAILED';
        throw error;
      }),
    ).toThrow(REFUSED_BETTER_SQLITE_BINDING_ERROR);
  });

  it('reports an uncompiled native binding as an install-script problem', () => {
    // The package is on disk and requirable; only `build/better_sqlite3.node` is
    // absent, which is what an install with lifecycle scripts suppressed leaves
    // behind. The remedy is a rebuild, not an install.
    expect(() =>
      loadBetterSqlite3ForTest(() => {
        throw new Error(
          'Could not locate the bindings file. Tried: /node_modules/better-sqlite3/build/better_sqlite3.node',
        );
      }),
    ).toThrow(UNBUILT_BETTER_SQLITE_BINDING_ERROR);
  });

  it('names the underlying failure rather than only the guidance', () => {
    // The whole point of the change: the real error is in the message, not buried
    // on `cause` where no assertion or test reporter prints it.
    expect(() =>
      loadBetterSqlite3ForTest(() => {
        throw new Error(
          'Could not locate the bindings file. Tried: /node_modules/better-sqlite3/build/better_sqlite3.node',
        );
      }),
    ).toThrow('Underlying error: Could not locate the bindings file.');
  });

  if (IS_BUN) {
    it('throws a clear runtime error when better-sqlite3 is unavailable', () => {
      expect(() => new NodeSQLiteStorage(':memory:')).toThrow(REFUSED_BETTER_SQLITE_BINDING_ERROR);
    });
  }
});

it('supports the adapter behavior under Bun when a database constructor is injected', async () => {
  const fake = createFakeDatabaseConstructor();
  const storage = new NodeSQLiteStorage(':memory:', fake.Database);

  // capabilities() is only reachable once an instance exists; under Bun the real
  // better-sqlite3 binding cannot load, so the injected fake constructor is the
  // only way to construct an instance and exercise this method here.
  expect(storage.capabilities()).toEqual({
    persistence: 'ephemeral',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: false,
  });

  await storage.put('a:1', new Uint8Array([1]));
  await storage.put('a:2', new Uint8Array([2]));
  await storage.put('b:1', new Uint8Array([3]));

  expect(await storage.get('a:1')).toEqual(new Uint8Array([1]));
  expect(await storage.get('missing')).toBeNull();

  const allKeys: string[] = [];
  for await (const [key] of storage.scan('')) {
    allKeys.push(key);
  }
  expect(allKeys).toEqual(['a:1', 'a:2', 'b:1']);

  const forward: [string, Uint8Array][] = [];
  for await (const entry of storage.scan('a:')) {
    forward.push(entry);
  }
  expect(forward.map(([key]) => key)).toEqual(['a:1', 'a:2']);

  const reverse: string[] = [];
  for await (const [key] of storage.scan('a:', { reverse: true, limit: 1 })) {
    reverse.push(key);
  }
  expect(reverse).toEqual(['a:2']);

  expect(
    await storage.conditionalBatch(
      [{ key: 'a:1', expectedValue: new Uint8Array([1]) }],
      [{ type: 'put', key: 'a:4', value: new Uint8Array([5]) }],
    ),
  ).toBe(true);
  expect(await storage.get('a:4')).toEqual(new Uint8Array([5]));

  expect(
    await storage.conditionalBatch(
      [{ key: 'a:1', expectedValue: new Uint8Array([9]) }],
      [{ type: 'delete', key: 'a:4' }],
    ),
  ).toBe(false);
  expect(await storage.get('a:4')).toEqual(new Uint8Array([5]));

  await storage.batch([
    { type: 'put', key: 'a:3', value: new Uint8Array([4]) },
    { type: 'delete', key: 'b:1' },
  ]);

  expect(storage.scanStatementCacheSize).toBeGreaterThan(0);
  expect(await storage.get('a:3')).toEqual(new Uint8Array([4]));
  expect(await storage.get('b:1')).toBeNull();
  await storage.delete('a:2');
  expect(await storage.get('a:2')).toBeNull();

  storage[Symbol.dispose]();

  expect(fake.isClosed()).toBe(true);
  expect(fake.pragmas).toEqual([
    'journal_mode = WAL',
    'synchronous = NORMAL',
    'cache_size = -64000',
    'mmap_size = 268435456',
    'temp_store = MEMORY',
    'wal_autocheckpoint = 10000',
  ]);
  expect([...fake.preparedSql]).toContain('SELECT value FROM kv WHERE key = ?');
});

function resolveNativeNode(searchPath: string): string {
  for (const directory of searchPath.split(delimiter).filter(existsSync)) {
    const candidate = Bun.which('node', { PATH: directory });
    if (candidate === null) continue;
    const identity = Bun.spawnSync([
      candidate,
      '--eval',
      'process.stdout.write(process.versions.bun ? "bun" : process.release.name)',
    ]);
    if (identity.exitCode === 0 && identity.stdout.toString() === 'node') return candidate;
  }
  throw new Error('Native SQLite integration requires Node.js.');
}

it('resolves native Node when a filesystem Bun shim shadows PATH', () => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-node-runtime-'));
  try {
    symlinkSync(process.execPath, join(directory, 'node'));
    const runtime = resolveNativeNode(
      [directory, resolveCliEnvironment().path ?? ''].join(delimiter),
    );
    const identity = Bun.spawnSync([runtime, '-p', 'typeof process.versions.bun']);
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.toString().trim()).toBe('undefined');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects a PATH containing only a filesystem Bun shim', () => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-node-runtime-'));
  try {
    symlinkSync(process.execPath, join(directory, 'node'));
    expect(() => resolveNativeNode(directory)).toThrow(
      'Native SQLite integration requires Node.js.',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Summarize a failed integration child for the assertion message.
 *
 * The raw TAP of 21 identically-failing cases buries the one line that matters
 * under repetition, and the distinct `error:` values are what identify the
 * cause. Surfacing them — deduplicated, with the child's stderr, which carries
 * anything that failed before TAP started — is what turns "0 pass 21 fail" into
 * a diagnosis without a second run (COR-1278).
 */
function describeChildFailure(stdout: string, stderr: string): string {
  const errors = [
    ...new Set(
      stdout
        .split('\n')
        .filter((line) => line.trimStart().startsWith('error:'))
        .map((line) => line.trim()),
    ),
  ];
  const sections = [
    errors.length > 0 ? `distinct child errors:\n${errors.join('\n')}` : '',
    stderr.trim() ? `child stderr:\n${stderr.trim()}` : '',
    `full TAP:\n${stdout}`,
  ];
  return sections.filter((section) => section.length > 0).join('\n\n');
}

it('runs all native SQLite integration cases under Node', async () => {
  // Bun's run.bun setting can inject both virtual and filesystem Node shims.
  // Verify runtime identity while preserving the inherited runtime managers.
  const environment = {
    ...process.env,
    PATH: (resolveCliEnvironment().path ?? '').split(delimiter).filter(existsSync).join(delimiter),
  };
  const runtime = resolveNativeNode(environment.PATH);
  const child = Bun.spawn({
    cmd: [
      runtime,
      '--test',
      '--test-reporter=tap',
      new URL('./node-sqlite-native.integration.ts', import.meta.url).pathname,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
    env: environment,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, describeChildFailure(stdout, stderr)).toBe(0);
  expect(stdout).toContain('# tests 21');
  expect(stdout).toContain('# pass 21');
  expect(stdout).toContain('# skipped 0');
});
