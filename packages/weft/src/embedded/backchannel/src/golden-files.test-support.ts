/**
 * Test-only helpers for byte-exact golden files: the canonical writer (object keys sorted
 * recursively by code unit, two-space indentation, one trailing newline), the directory
 * rewrite the update scripts use, and the comparison the golden tests use.
 *
 * Weft has no testing export, so Bureau keeps its own copy of the same few lines
 * (`packages/bureau/src/http/golden-files.test-support.ts`).
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** The `info.version` every golden document carries, so a version bump leaves the files alone. */
export const GOLDEN_VERSION = '0.0.0-golden';

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    sorted[key] = sortKeys(entry);
  }
  return sorted;
}

/** The golden bytes for a value: sorted keys, two-space indentation, trailing newline. */
export function formatGoldenJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** Set `info.version` on a built or fetched document to {@link GOLDEN_VERSION}. */
export function withGoldenVersion(document: Record<string, unknown>): Record<string, unknown> {
  const info = document['info'];
  if (info === null || typeof info !== 'object' || Array.isArray(info)) {
    throw new TypeError('A golden document needs an info object.');
  }
  return { ...document, info: { ...info, version: GOLDEN_VERSION } };
}

/** Replace a golden directory with exactly these files, removing anything else in it. */
export async function writeGoldenDirectory(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) await Bun.write(join(directory, name), text);
}

/** The file names in a golden directory, sorted. */
export async function listGoldenDirectory(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  return names.toSorted();
}

/** The message a comparison fails with, or `undefined` when it passes. */
export async function goldenFailure(comparison: Promise<void>): Promise<string | undefined> {
  try {
    await comparison;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Throw, naming the file and the update command, when the directory differs from the expected
 * files by a byte or holds a file that is not expected.
 */
export async function assertGoldenDirectory(
  directory: string,
  files: Readonly<Record<string, string>>,
  updateCommand: string,
): Promise<void> {
  for (const name of await listGoldenDirectory(directory)) {
    if (!Object.hasOwn(files, name)) {
      throw new Error(`${name} is not a golden file; remove it or run \`${updateCommand}\`.`);
    }
  }
  for (const [name, text] of Object.entries(files)) {
    const file = Bun.file(join(directory, name));
    if (!(await file.exists())) {
      throw new Error(`${name} is missing; run \`${updateCommand}\`.`);
    }
    if ((await file.text()) !== text) {
      throw new Error(`${name} differs from what is generated; run \`${updateCommand}\`.`);
    }
  }
}
