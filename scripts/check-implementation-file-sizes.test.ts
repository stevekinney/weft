import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { write } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  CLASSIFIED_OVERSIZED_IMPLEMENTATION_FILES,
  IMPLEMENTATION_FILE_SIZE_LIMIT,
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
    await writeFixtureFile(root, 'src/large.test-d.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'src/large.test.svelte', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'scripts/large.spec.ts', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);
    await writeFixtureFile(root, 'tests/large.spec.svelte', IMPLEMENTATION_FILE_SIZE_LIMIT + 1);

    const result = run(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0 implementation file(s)');
  });

  it('does not fail just because classified files are absent from a fixture root', async () => {
    const result = run(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0 implementation file(s)');
  });

  it('keeps the contributor documentation table synchronized with the enforced classifications', async () => {
    const documentationRows = await readDocumentationClassificationRows();
    const expectedRows = CLASSIFIED_OVERSIZED_IMPLEMENTATION_FILES.map((entry) => ({
      path: entry.path,
      classification: classificationLabel(entry.classification),
      rationale: entry.rationale,
    }));

    expect(documentationRows).toEqual(expectedRows);
  });
});
