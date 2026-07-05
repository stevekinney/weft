import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { write } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { IMPLEMENTATION_FILE_SIZE_LIMIT } from './check-implementation-file-sizes.ts';

const scriptPath = join(import.meta.dir, 'check-implementation-file-sizes.ts');

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(root: string): RunResult {
  const result = Bun.spawnSync(['bun', 'run', scriptPath, '--root', root]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function writeFixtureFile(
  root: string,
  relativePath: string,
  lineCount: number,
): Promise<void> {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, '..'), { recursive: true });
  await write(
    absolutePath,
    Array.from({ length: lineCount }, () => 'export {};').join('\n') + '\n',
  );
}

describe('check-implementation-file-sizes', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'implementation-size-check-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes when no implementation files exceed the line threshold', async () => {
    await writeFixtureFile(root, 'src/small.ts', IMPLEMENTATION_FILE_SIZE_LIMIT);

    const result = run(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0 implementation file(s)');
  });

  it('fails when an oversized implementation file is not classified', async () => {
    await writeFixtureFile(root, 'src/oversized.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);

    const result = run(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('without a classification');
    expect(result.stderr).toContain('src/oversized.ts');
  });

  it('excludes generated, test, and spec files from the implementation scan', async () => {
    await writeFixtureFile(
      root,
      'src/generated/operation-client.ts',
      IMPLEMENTATION_FILE_SIZE_LIMIT + 1,
    );
    await writeFixtureFile(root, 'src/large.test.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'scripts/large.spec.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);

    const result = run(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0 implementation file(s)');
  });

  it('does not fail just because classified files are absent from a fixture root', async () => {
    const result = run(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0 implementation file(s)');
  });
});
