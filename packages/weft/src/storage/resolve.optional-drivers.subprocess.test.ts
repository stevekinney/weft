import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  OPTIONAL_STORAGE_DRIVER_ENTRIES,
  withOptionalStorageDriversAbsent,
} from './block-optional-storage-drivers.test-support.ts';

import {
  outcomeOf,
  rethrow,
  SCENARIO_HANG_GUARD_MILLISECONDS,
} from '../testing/module-scope-scenario.test-support.ts';

const weftRoot = import.meta.dir + '/../..';

async function runFixture(relativePath: string): Promise<{ exitCode: number; stderr: string }> {
  return withOptionalStorageDriversAbsent(weftRoot, async (sandboxRoot) => {
    const proc = Bun.spawn(['bun', relativePath], {
      timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
      cwd: sandboxRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, FORCE_COLOR: '0' },
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
  });
}

// These gates run fixtures in fresh Bun processes in a sandbox without the optional storage drivers, which
// takes seconds on a loaded host. The scenarios below run at module scope, off Bun's five-second
// per-test clock; each test rethrows its scenario's outcome.

/**
 * Regression coverage for COR-1230: the mirror's consumer smoke test failed
 * importing `@lostgradient/weft`'s `.` and `./storage/resolve` entry points
 * with "Cannot find module '@libsql/client/web'" — a package declared only
 * as an optional peer dependency. The cause was `storage/turso.ts` importing
 * `@libsql/client/web` at module top level, so anything that merely
 * *imported* `resolve.ts` (or `index.ts`, which re-exports every backend)
 * pulled in Turso's driver whether or not Turso was ever selected.
 *
 * Each gate spawns a fresh Bun process with every optional storage-driver
 * peer dependency (`@libsql/client`, `@neondatabase/serverless`,
 * `better-sqlite3`, `lmdb`, `pg`) actually renamed out of `node_modules` for
 * the duration of the run, so it fails the exact same way a real consumer
 * without those peers installed would — the same shape of failure the
 * mirror's smoke test hit.
 */
const scenario1 = await outcomeOf(async () => {
  const { exitCode, stderr } = await runFixture(
    'src/storage/resolve-without-optional-drivers-fixture.ts',
  );
  if (exitCode !== 0) {
    throw new Error(
      `resolve-without-optional-drivers fixture failed (exit ${exitCode}).\nstderr:\n${stderr}`,
    );
  }
  expect(exitCode).toBe(0);
});

const scenario2 = await outcomeOf(async () => {
  const { exitCode, stderr } = await runFixture('src/storage/turso-driver-deferred-fixture.ts');
  if (exitCode !== 0) {
    throw new Error(`turso-driver-deferred fixture failed (exit ${exitCode}).\nstderr:\n${stderr}`);
  }
  expect(exitCode).toBe(0);
});

describe('storage/resolve (optional-driver subprocess gates)', () => {
  it('resolves the memory backend when no optional storage driver is installed', () =>
    rethrow(scenario1));

  it("defers Turso's driver import to first use rather than construction", () =>
    rethrow(scenario2));

  it('links every dependency but the optional drivers into a sandbox it removes afterwards', async () => {
    const seen = await withOptionalStorageDriversAbsent(weftRoot, async (sandboxRoot) => ({
      sandboxRoot,
      drivers: OPTIONAL_STORAGE_DRIVER_ENTRIES.filter((entry) =>
        existsSync(join(sandboxRoot, 'node_modules', entry)),
      ),
      zod: existsSync(join(sandboxRoot, 'node_modules', 'zod', 'package.json')),
      source: existsSync(join(sandboxRoot, 'src', 'storage', 'resolve.ts')),
    }));
    expect(seen.drivers).toEqual([]);
    expect(seen.zod).toBe(true);
    expect(seen.source).toBe(true);
    expect(existsSync(seen.sandboxRoot)).toBe(false);
    // The shared install the rest of the suite and a concurrent typecheck read is untouched.
    expect(existsSync(join(weftRoot, 'node_modules', 'lmdb'))).toBe(true);
  });

  it('skips a dangling dependency link instead of failing to build the sandbox', async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'weft-optional-drivers-dangling-'));
    try {
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      mkdirSync(join(packageRoot, 'node_modules', '@scope'), { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), '{}');
      writeFileSync(join(packageRoot, 'tsconfig.json'), '{}');
      symlinkSync(
        join(packageRoot, 'missing'),
        join(packageRoot, 'node_modules', '@scope', 'gone'),
      );
      const linked = await withOptionalStorageDriversAbsent(packageRoot, async (sandboxRoot) =>
        existsSync(join(sandboxRoot, 'node_modules', '@scope', 'gone')),
      );
      expect(linked).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('fails to build the sandbox when a dependency link cannot be resolved for another reason', async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'weft-optional-drivers-loop-'));
    try {
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      mkdirSync(join(packageRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), '{}');
      writeFileSync(join(packageRoot, 'tsconfig.json'), '{}');
      // Two links that point at each other: realpath fails with ELOOP, not ENOENT.
      symlinkSync(
        join(packageRoot, 'node_modules', 'second'),
        join(packageRoot, 'node_modules', 'first'),
      );
      symlinkSync(
        join(packageRoot, 'node_modules', 'first'),
        join(packageRoot, 'node_modules', 'second'),
      );
      expect(
        await throwingRejectionOf(
          withOptionalStorageDriversAbsent(packageRoot, async () => 'unused'),
        ),
      ).toThrow(/ELOOP|too many/i);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
