/**
 * Temporarily hides every optional storage-driver peer dependency from this
 * workspace's `node_modules`, so a fixture spawned while they're hidden
 * proves a module graph does not need one merely to be imported.
 *
 * A Bun runtime plugin's `onResolve` was tried first and rejected: it only
 * intercepts a specifier Bun's own resolver would otherwise fail to find.
 * Every driver here genuinely IS installed in this workspace (proven with
 * `bun --preload <plugin> zz-probe.ts` importing `@libsql/client/web`
 * directly — it resolved fine despite the plugin), so a plugin-based block
 * is a no-op for the exact case this gate needs to simulate. Actually
 * renaming the package directories out of the way is the only mechanism
 * that reproduces "a consumer without this optional peer installed" using
 * Bun's real resolution algorithm rather than a hook that only fires for
 * specifiers that were already going to fail.
 *
 * @module storage/block-optional-storage-drivers.test-support
 */
import { rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

const OPTIONAL_STORAGE_DRIVER_PACKAGES = [
  '@libsql',
  '@neondatabase',
  'lmdb',
  'pg',
  'better-sqlite3',
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `body` with every optional storage-driver package directory renamed
 * out of `weftRoot`'s `node_modules`, then restore them — even if `body`
 * throws. A package this workspace never installed (`better-sqlite3` isn't,
 * today) is simply skipped rather than treated as an error.
 */
export async function withOptionalStorageDriversHidden<T>(
  weftRoot: string,
  body: () => Promise<T>,
): Promise<T> {
  const nodeModules = join(weftRoot, 'node_modules');
  const hidden: Array<{ from: string; to: string }> = [];
  try {
    for (const name of OPTIONAL_STORAGE_DRIVER_PACKAGES) {
      const from = join(nodeModules, name);
      if (!(await exists(from))) continue;
      const to = join(nodeModules, `.hidden-${name}`);
      await rename(from, to);
      hidden.push({ from, to });
    }
    return await body();
  } finally {
    for (const { from, to } of hidden.toReversed()) {
      await rename(to, from).catch(() => {});
    }
  }
}
