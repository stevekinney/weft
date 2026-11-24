import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Names for the files and directories a test creates.
 *
 * A name built from `process.pid` is unique only among the processes alive at the time: the
 * operating system reuses process ids, so a later run builds the path an earlier run used, opens
 * the database that run left behind, and inherits its rows (COR-1619). Every helper here takes its
 * uniqueness from `mkdtemp` or `crypto.randomUUID()` instead, and
 * `scripts/check-process-identifier-test-paths.ts` fails the build for a test that names a path
 * after the process id.
 */

/** Directories this module made, and the directory that holds each path it handed out. */
const directories = new Set<string>();
const directoryOfPath = new Map<string, string>();

/**
 * Makes a fresh directory under the operating system's temporary directory with `mkdtemp`, and
 * returns its absolute path. The caller removes it with {@link removeTemporaryPath}, in a
 * `finally` or an `afterEach`.
 */
export function createTemporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `${label}-`));
  directories.add(directory);
  return directory;
}

/**
 * Returns a path for a file (or a directory, for a store that makes its own) inside a fresh
 * `mkdtemp` directory, so a database and the `-wal` and `-shm` files beside it share one owner
 * that {@link removeTemporaryPath} removes in a single call. The path itself does not exist yet.
 */
export function createTemporaryPath(label: string, extension = ''): string {
  const directory = createTemporaryDirectory(label);
  const path = join(directory, `${label}${extension}`);
  directoryOfPath.set(path, directory);
  return path;
}

/**
 * Removes the directory that {@link createTemporaryPath} or {@link createTemporaryDirectory} made
 * for `path`, with everything in it. Removing twice is harmless. A path this module did not hand
 * out is refused, so a typo can never delete a directory the test does not own.
 */
export function removeTemporaryPath(path: string): void {
  const directory = directoryOfPath.get(path) ?? (directories.has(path) ? path : undefined);
  if (directory === undefined) {
    throw new Error(`removeTemporaryPath: ${path} was not made by createTemporaryPath`);
  }
  rmSync(directory, { recursive: true, force: true });
}

/**
 * A file name that is unique across runs, for a file that has to stay where it is: next to the
 * source it imports, for example, so relative imports resolve. The caller removes the file in a
 * `finally`. Prefer {@link createTemporaryPath} for anything that can live under the temporary
 * directory.
 */
export function uniqueFileName(label: string, extension = ''): string {
  return `${label}-${crypto.randomUUID()}${extension}`;
}
