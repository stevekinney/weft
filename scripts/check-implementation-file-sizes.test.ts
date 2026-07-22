import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { write } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  assertUniqueClassifications,
  CLASSIFIED_OVERSIZED_IMPLEMENTATION_FILES,
  IMPLEMENTATION_FILE_SIZE_LIMIT,
  runCli,
  type OversizedImplementationFileClassification,
} from './check-implementation-file-sizes.ts';

const scriptPath = join(import.meta.dir, 'check-implementation-file-sizes.ts');
const repositoryRoot = join(import.meta.dir, '..');
const developmentSetupPath = join(
  repositoryRoot,
  'documentation/contributing/development-setup.md',
);

type RunResult = { exitCode: number; stdout: string; stderr: string };
type DocumentationRow = { path: string; classification: string; rationale: string };

function run(root: string): RunResult {
  const result = Bun.spawnSync(['bun', 'run', scriptPath, '--root', root]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function runDirect(argv: readonly string[]): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...values: unknown[]): void => {
    stdout.push(values.map(String).join(' '));
  };
  console.error = (...values: unknown[]): void => {
    stderr.push(values.map(String).join(' '));
  };

  try {
    const exitCode = await runCli(argv);
    return {
      exitCode,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
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

function classificationLabel(
  classification: OversizedImplementationFileClassification,
): 'Justified exception' | 'Tracked separately' {
  return classification === 'justified-exception' ? 'Justified exception' : 'Tracked separately';
}

async function readDocumentationClassificationRows(): Promise<DocumentationRow[]> {
  const markdown = await Bun.file(developmentSetupPath).text();
  return markdown
    .split('\n')
    .map((line): DocumentationRow | null => {
      const match = /^\| `([^`]+)`\s+\|\s+([^|]+?)\s+\|\s+(.+?)\s+\|$/.exec(line);
      if (!match) return null;
      const classification = match[2].trim();
      if (classification !== 'Justified exception' && classification !== 'Tracked separately') {
        return null;
      }
      return {
        path: match[1],
        classification,
        rationale: match[3].trim(),
      };
    })
    .filter((row): row is DocumentationRow => row !== null);
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

  it('passes direct execution for empty and threshold-sized implementation files', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await write(join(root, 'src/empty.ts'), '');
    await write(
      join(root, 'src/small-no-newline.ts'),
      Array.from({ length: IMPLEMENTATION_FILE_SIZE_LIMIT }, () => 'export {};').join('\n'),
    );

    const result = await runDirect(['--root', root]);

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

  it('fails direct execution when an oversized implementation file is not classified', async () => {
    await writeFixtureFile(root, 'src/oversized.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);

    const result = await runDirect(['--root', root]);

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
    await writeFixtureFile(root, 'src/large.test-d.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'src/large.test.svelte', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'scripts/large.spec.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'tests/large.spec.svelte', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);

    const result = run(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0 implementation file(s)');
  });

  it('excludes generated, test, and spec files during direct execution', async () => {
    await writeFixtureFile(
      root,
      'src/generated/operation-client.ts',
      IMPLEMENTATION_FILE_SIZE_LIMIT + 1,
    );
    await writeFixtureFile(root, 'src/large.test.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'src/large.test-d.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'src/large.test.svelte', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'scripts/large.spec.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'tests/large.spec.svelte', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);

    const result = await runDirect(['--root', root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0 implementation file(s)');
  });

  it('does not fail just because classified files are absent from a fixture root', async () => {
    const result = run(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0 implementation file(s)');
  });

  it('fails when an existing classified implementation file is no longer oversized', async () => {
    const classifiedPath = CLASSIFIED_OVERSIZED_IMPLEMENTATION_FILES[0].path;
    const stillOversizedPath = CLASSIFIED_OVERSIZED_IMPLEMENTATION_FILES[1].path;
    await writeFixtureFile(root, classifiedPath, IMPLEMENTATION_FILE_SIZE_LIMIT);
    await writeFixtureFile(root, stillOversizedPath, IMPLEMENTATION_FILE_SIZE_LIMIT + 1);

    const result = await runDirect(['--root', root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('classified implementation file(s) at or below 500 lines');
    expect(result.stderr).toContain(`  500 ${classifiedPath}`);
    expect(result.stderr).toContain('Remove stale classifications from the executable registry');
  });

  it('prints usage without scanning when help is requested', async () => {
    const result = await runDirect(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: bun scripts/check-implementation-file-sizes.ts');
  });

  it('rejects unknown arguments', async () => {
    await expect(runCli(['--unknown'])).rejects.toThrow('Unknown argument: --unknown');
  });

  it('rejects duplicate oversized-file classifications', () => {
    expect(() =>
      assertUniqueClassifications([
        {
          path: 'src/example.ts',
          classification: 'justified-exception',
          rationale: 'First classification for duplicate detection.',
        },
        {
          path: 'src/example.ts',
          classification: 'tracked-elsewhere',
          rationale: 'Second classification for duplicate detection.',
        },
      ]),
    ).toThrow('Duplicate oversized-file classification for src/example.ts');
  });

  it('keeps documentation byte-for-byte aligned on classification paths, labels, and rationales', async () => {
    const documentationRows = await readDocumentationClassificationRows();
    const expectedRows = CLASSIFIED_OVERSIZED_IMPLEMENTATION_FILES.map((entry) => ({
      path: entry.path,
      classification: classificationLabel(entry.classification),
      rationale: entry.rationale,
    }));

    expect(documentationRows).toEqual(expectedRows);
  });
});
