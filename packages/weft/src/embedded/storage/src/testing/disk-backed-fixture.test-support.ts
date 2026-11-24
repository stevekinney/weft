/**
 * A disposable path for a disk-backed storage test, shared by every package whose tests open a
 * database file.
 *
 * @module testing/disk-backed-fixture
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** The sidecar files SQLite keeps beside a database in WAL mode. */
export const sqliteDatabaseSidecarSuffixes = ['-wal', '-shm'] as const;

/** Where {@link createDiskBackedTestFixture} puts a fixture and what its cleanup removes. */
export type DiskBackedTestFixtureOptions = {
  prefix: string;
  suffix?: string;
  recursive?: boolean;
  sidecarSuffixes?: readonly string[];
};

/** A fixture path under the system temporary directory and the cleanup that removes it. */
export type DiskBackedTestFixture = {
  path: string;
  cleanup: () => void;
};

function removeFixturePathBestEffort(path: string, recursive = false): void {
  try {
    rmSync(path, { force: true, recursive });
  } catch {
    // Test fixture cleanup is intentionally best-effort so teardown does not
    // mask the original assertion failure when a backend still holds a file.
  }
}

function assertSafeFixturePathPart(value: string, name: string): void {
  if (value.length === 0 || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error(`${name} must be a plain filename fragment`);
  }
}

function assertFixturePathInsideTemporaryDirectory(path: string): void {
  const temporaryDirectory = resolve(tmpdir());
  const relativePath = relative(temporaryDirectory, path);

  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(
      'Disk-backed test fixture path must stay inside the system temporary directory',
    );
  }
}

/**
 * Reserve a unique path under the system temporary directory for a disk-backed storage test, with a
 * best-effort cleanup that removes it and its sidecars. Fragments that could escape the temporary
 * directory are refused before cleanup can target them.
 *
 * @param options - the path's prefix and suffix, whether to remove it recursively, and its sidecars
 */
export function createDiskBackedTestFixture(
  options: DiskBackedTestFixtureOptions,
): DiskBackedTestFixture {
  assertSafeFixturePathPart(options.prefix, 'Fixture prefix');
  if (options.suffix !== undefined) {
    assertSafeFixturePathPart(options.suffix, 'Fixture suffix');
  }
  for (const sidecarSuffix of options.sidecarSuffixes ?? []) {
    assertSafeFixturePathPart(sidecarSuffix, 'Fixture sidecar suffix');
  }

  const path = resolve(
    join(tmpdir(), `${options.prefix}-${crypto.randomUUID()}${options.suffix ?? ''}`),
  );
  assertFixturePathInsideTemporaryDirectory(path);

  return {
    path,
    cleanup: () => {
      for (const sidecarSuffix of options.sidecarSuffixes ?? []) {
        const sidecarPath = resolve(`${path}${sidecarSuffix}`);
        assertFixturePathInsideTemporaryDirectory(sidecarPath);
        removeFixturePathBestEffort(sidecarPath);
      }
      removeFixturePathBestEffort(path, options.recursive ?? false);
    },
  };
}
