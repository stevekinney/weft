import { describe, expect, test } from 'bun:test';

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const a2aDirectory = import.meta.dir;
const TEST_FILE_PATTERN = /\.test\.ts$/;
const BUN_GLOBAL_PATTERN = /\bBun\./;

/** Files under `directory`, other than `*.test.ts`, that mention the `Bun` global. */
async function bunGlobalReferences(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const offenders: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || TEST_FILE_PATTERN.test(entry.name)) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    if (BUN_GLOBAL_PATTERN.test(await readFile(path, 'utf8'))) {
      offenders.push(relative(directory, path));
    }
  }
  return offenders.toSorted();
}

describe('A2A kit portability', () => {
  test('no non-test file under src/a2a/ uses the Bun global', async () => {
    expect(await bunGlobalReferences(a2aDirectory)).toEqual([]);
  });

  test('reports every non-test file that uses the Bun global, at any depth, and ignores tests', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'weft-a2a-portability-'));
    try {
      await mkdir(join(fixture, 'nested'));
      await writeFile(join(fixture, 'clean.ts'), 'export const value = 1;\n');
      await writeFile(
        join(fixture, 'nested', 'serve.ts'),
        'Bun.serve({ fetch: () => new Response() });\n',
      );
      await writeFile(
        join(fixture, 'serve.test.ts'),
        'Bun.serve({ fetch: () => new Response() });\n',
      );
      await writeFile(join(fixture, 'fixture.test-support.ts'), 'export const file = Bun.file;\n');

      expect(await bunGlobalReferences(fixture)).toEqual([
        'fixture.test-support.ts',
        join('nested', 'serve.ts'),
      ]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
