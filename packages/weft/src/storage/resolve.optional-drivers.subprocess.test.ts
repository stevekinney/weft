import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withOptionalStorageDriversHidden } from './block-optional-storage-drivers.test-support.ts';

const weftRoot = import.meta.dir + '/../..';

async function runFixture(relativePath: string): Promise<{ exitCode: number; stderr: string }> {
  return withOptionalStorageDriversHidden(weftRoot, async () => {
    const proc = Bun.spawn(['bun', relativePath], {
      cwd: weftRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, FORCE_COLOR: '0' },
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
  });
}

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
describe('storage/resolve (optional-driver subprocess gates)', () => {
  it('resolves the memory backend when no optional storage driver is installed', async () => {
    const { exitCode, stderr } = await runFixture(
      'src/storage/resolve-without-optional-drivers-fixture.ts',
    );
    if (exitCode !== 0) {
      throw new Error(
        `resolve-without-optional-drivers fixture failed (exit ${exitCode}).\nstderr:\n${stderr}`,
      );
    }
    expect(exitCode).toBe(0);
  }, 30_000);

  it("defers Turso's driver import to first use rather than construction", async () => {
    const { exitCode, stderr } = await runFixture('src/storage/turso-driver-deferred-fixture.ts');
    if (exitCode !== 0) {
      throw new Error(
        `turso-driver-deferred fixture failed (exit ${exitCode}).\nstderr:\n${stderr}`,
      );
    }
    expect(exitCode).toBe(0);
  }, 30_000);

  it('skips a package that is not installed under the given root rather than treating it as an error', async () => {
    // `weftRoot` here has no `node_modules` at all, so every optional
    // storage-driver package's `exists()` check reports false — the same
    // "not installed" path a workspace missing a subset of the optional
    // peers takes in production, distinct from the "installed, temporarily
    // renamed" path the other tests in this file exercise.
    const emptyRoot = import.meta.dir;
    let bodyRan = false;
    const result = await withOptionalStorageDriversHidden(emptyRoot, async () => {
      bodyRan = true;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(bodyRan).toBe(true);
  });

  it('still resolves with the body result when restoring a hidden package fails', async () => {
    // The restore rename (`node_modules/.hidden-pg` -> `node_modules/pg`) is
    // best-effort: if something removes the hidden copy while it is hidden
    // (a crashed process, a concurrent cleanup), `withOptionalStorageDriversHidden`
    // must not let that failure mask the body's own result or throw past it.
    const tempRoot = mkdtempSync(join(tmpdir(), 'weft-optional-drivers-restore-'));
    try {
      const pgDir = join(tempRoot, 'node_modules', 'pg');
      await mkdir(pgDir, { recursive: true });
      await writeFile(join(pgDir, 'package.json'), JSON.stringify({ name: 'pg' }));

      const result = await withOptionalStorageDriversHidden(tempRoot, async () => {
        // Delete the hidden copy while it's still hidden, so the restore
        // rename in `finally` has nothing to rename from.
        await rm(join(tempRoot, 'node_modules', '.hidden-pg'), {
          recursive: true,
          force: true,
        });
        return 'body-result';
      });

      expect(result).toBe('body-result');
      // Neither the original nor the hidden copy exists — the failed
      // restore was swallowed, not silently retried or re-created.
      expect(existsSync(pgDir)).toBe(false);
      expect(existsSync(join(tempRoot, 'node_modules', '.hidden-pg'))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
