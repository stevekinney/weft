/**
 * Runs a fixture in a sandbox where no optional storage-driver peer dependency is installed, so a
 * fixture spawned there proves a module graph does not need one merely to be imported.
 *
 * A Bun runtime plugin's `onResolve` was tried first and rejected: it only intercepts a specifier
 * Bun's own resolver would otherwise fail to find, and every driver here genuinely is installed in
 * this workspace. The sandbox reproduces "a consumer without this optional peer installed" with
 * Bun's real resolution algorithm: it holds a copy of this package's `src` and manifests, and a
 * `node_modules` that links every dependency of this package except the optional drivers. Nothing
 * outside the sandbox changes. An earlier version renamed the drivers out of the shared
 * `node_modules` instead, and a typecheck running beside the test then failed to find them.
 *
 * @module storage/block-optional-storage-drivers.test-support
 */
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Top-level `node_modules` entries (a scope or a package) that hold optional storage drivers. */
export const OPTIONAL_STORAGE_DRIVER_ENTRIES = [
  '@libsql',
  '@neondatabase',
  'lmdb',
  'pg',
  'better-sqlite3',
] as const;

const OPTIONAL_ENTRIES = new Set<string>(OPTIONAL_STORAGE_DRIVER_ENTRIES);

async function linkDependencies(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (OPTIONAL_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
    const from = join(source, entry.name);
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      await linkDependencies(from, join(target, entry.name));
    } else {
      // A dangling link left by an earlier install resolves to nothing a fixture could import;
      // any other failure would leave a required dependency out, so it propagates.
      const resolved = await realpath(from).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (resolved !== undefined) await symlink(resolved, join(target, entry.name));
    }
  }
}

/**
 * Run `body` with the root of a sandbox copy of the package at `packageRoot` whose
 * `node_modules` lacks every optional storage driver, then remove the sandbox, even if `body`
 * throws.
 */
export async function withOptionalStorageDriversAbsent<T>(
  packageRoot: string,
  body: (sandboxRoot: string) => Promise<T>,
): Promise<T> {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'weft-without-optional-drivers-'));
  try {
    await cp(join(packageRoot, 'src'), join(sandboxRoot, 'src'), { recursive: true });
    for (const manifest of ['package.json', 'tsconfig.json']) {
      await cp(join(packageRoot, manifest), join(sandboxRoot, manifest));
    }
    await linkDependencies(join(packageRoot, 'node_modules'), join(sandboxRoot, 'node_modules'));
    return await body(sandboxRoot);
  } finally {
    await rm(sandboxRoot, { recursive: true, force: true });
  }
}
