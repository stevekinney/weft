import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { executeValidate } from './index.ts';
import { expandGlobEntryPaths, splitGlobPattern } from './utilities.ts';

describe('executeValidate', () => {
  it('expands a single glob to its matching files in alphabetical order', async () => {
    // The order-processing example is the multi-file glob target, so it pins the
    // within-glob sort contract (a single glob's matches are emitted sorted,
    // independent of filesystem enumeration order).
    const result = await executeValidate({
      entryPaths: ['src/cli/__fixtures__/validation/order-processing/src/**/*.ts'],
      json: true,
    });

    expect(result.exitCode).toBe(0);
    const parsed: { entries: Array<{ entryPath: string }> } = JSON.parse(result.stdout);
    const entryPaths = parsed.entries.map((entry) => entry.entryPath);
    expect(entryPaths.length).toBeGreaterThan(1);
    expect(entryPaths).toEqual([...entryPaths].toSorted());
  });

  it('expands absolute glob patterns for retained workflow fixture validation', async () => {
    const result = await executeValidate({
      entryPaths: [
        join(process.cwd(), 'src/cli/__fixtures__/validation/hello-world/src/**/*.ts'),
        join(process.cwd(), 'src/cli/__fixtures__/validation/order-processing/src/**/*.ts'),
      ],
      json: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      join(process.cwd(), 'src/cli/__fixtures__/validation/hello-world/src/index.ts'),
    );
    expect(result.stdout).toContain(
      join(
        process.cwd(),
        'src/cli/__fixtures__/validation/order-processing/src/workflows/order.ts',
      ),
    );
  });

  it('normalizes Windows-style glob separators for retained workflow fixture validation', async () => {
    const result = await executeValidate({
      entryPaths: [
        String.raw`src\cli\__fixtures__\validation\hello-world\src\**\*.ts`,
        String.raw`src\cli\__fixtures__\validation\order-processing\src\**\*.ts`,
      ],
      json: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('src/cli/__fixtures__/validation/hello-world/src/index.ts');
    expect(result.stdout).toContain(
      'src/cli/__fixtures__/validation/order-processing/src/workflows/order.ts',
    );
  });

  it('deduplicates validate entries when a glob and explicit path match the same file', async () => {
    const result = await executeValidate({
      entryPaths: [
        'src/cli/__fixtures__/validation/hello-world/src/**/*.ts',
        'src/cli/__fixtures__/validation/order-processing/src/**/*.ts',
        'src/cli/__fixtures__/validation/hello-world/src/index.ts',
      ],
      json: true,
    });

    expect(result.exitCode).toBe(0);

    const parsed: {
      entries: Array<{ entryPath: string }>;
      valid: boolean;
      hasLoadErrors: boolean;
      hasValidationErrors: boolean;
    } = JSON.parse(result.stdout);

    expect(parsed).toMatchObject({
      valid: true,
      hasLoadErrors: false,
      hasValidationErrors: false,
    });
    const validatedEntryPaths = parsed.entries.map((entry) => entry.entryPath);
    expect(validatedEntryPaths).toContain(
      'src/cli/__fixtures__/validation/hello-world/src/index.ts',
    );
    expect(validatedEntryPaths).toContain(
      'src/cli/__fixtures__/validation/order-processing/src/workflows/order.ts',
    );
    expect(new Set(validatedEntryPaths).size).toBe(validatedEntryPaths.length);
  });

  it('prunes nested node_modules directories before expanding validation globs', async () => {
    const workspacePath = join(tmpdir(), `weft-validate-glob-prune-${crypto.randomUUID()}`);
    const examplePath = join(workspacePath, 'examples', 'order-processing');
    const nestedPackagePath = join(examplePath, 'node_modules', 'weft', 'examples', 'recursive');

    try {
      mkdirSync(nestedPackagePath, { recursive: true });
      await Bun.write(join(examplePath, 'src.ts'), 'export const workflow = "clean";');
      await Bun.write(
        join(examplePath, 'src.test.ts'),
        'throw new Error("test file should be ignored");',
      );
      await Bun.write(
        join(nestedPackagePath, 'bad.ts'),
        'throw new Error("node_modules should be ignored");',
      );

      expect(await expandGlobEntryPaths([join(workspacePath, 'examples/**/*.ts')])).toEqual([
        join(workspacePath, 'examples/order-processing/src.ts'),
      ]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('includes test files when validation globs explicitly target tests', async () => {
    const workspacePath = join(tmpdir(), `weft-validate-explicit-test-glob-${crypto.randomUUID()}`);
    const examplePath = join(workspacePath, 'examples', 'order-processing');

    try {
      mkdirSync(examplePath, { recursive: true });
      await Bun.write(join(examplePath, 'src.ts'), 'export const workflow = "clean";');
      await Bun.write(join(examplePath, 'src.test.ts'), 'export const testWorkflow = "clean";');

      expect(await expandGlobEntryPaths([join(workspacePath, 'examples/**/*.test.ts')])).toEqual([
        join(workspacePath, 'examples/order-processing/src.test.ts'),
      ]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('includes test files when validation globs explicitly target a tests directory', async () => {
    const workspacePath = join(tmpdir(), `weft-validate-tests-directory-${crypto.randomUUID()}`);
    const testsPath = join(workspacePath, 'examples', 'order-processing', 'tests');

    try {
      mkdirSync(testsPath, { recursive: true });
      await Bun.write(
        join(testsPath, 'order-processing.test.ts'),
        'export const workflow = "test";',
      );

      expect(
        await expandGlobEntryPaths([join(workspacePath, 'examples/**/tests/**/*.ts')]),
      ).toEqual([join(workspacePath, 'examples/order-processing/tests/order-processing.test.ts')]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('includes test files when the scan root explicitly targets a tests directory', async () => {
    const workspacePath = join(tmpdir(), `weft-validate-tests-scanroot-${crypto.randomUUID()}`);
    const testsPath = join(workspacePath, 'examples', 'order-processing', 'tests');

    try {
      mkdirSync(testsPath, { recursive: true });
      await Bun.write(
        join(testsPath, 'order-processing.test.ts'),
        'export const workflow = "test";',
      );

      expect(
        await expandGlobEntryPaths([
          join(workspacePath, 'examples/order-processing/tests/**/*.ts'),
        ]),
      ).toEqual([join(workspacePath, 'examples/order-processing/tests/order-processing.test.ts')]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('does not infer test-file intent from absolute checkout path segments', async () => {
    const workspacePath = join(tmpdir(), `weft-test-parent-${crypto.randomUUID()}`);
    const examplePath = join(workspacePath, 'examples', 'order-processing');

    try {
      mkdirSync(examplePath, { recursive: true });
      await Bun.write(join(examplePath, 'src.ts'), 'export const workflow = "clean";');
      await Bun.write(join(examplePath, 'src.test.ts'), 'export const testWorkflow = "clean";');

      expect(await expandGlobEntryPaths([join(workspacePath, 'examples/**/*.ts')])).toEqual([
        join(workspacePath, 'examples/order-processing/src.ts'),
      ]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('does not descend into subdirectories for a pattern that cannot match a nested path', async () => {
    const workspacePath = join(tmpdir(), `weft-flat-glob-${crypto.randomUUID()}`);

    try {
      mkdirSync(join(workspacePath, 'nested'), { recursive: true });
      await Bun.write(join(workspacePath, 'top.ts'), 'export const top = true;');
      await Bun.write(join(workspacePath, 'nested', 'inner.ts'), 'export const inner = true;');

      expect(await expandGlobEntryPaths([join(workspacePath, '*.ts')])).toEqual([
        join(workspacePath, 'top.ts'),
      ]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('rethrows a directory read failure other than a missing scan root', async () => {
    const workspacePath = join(tmpdir(), `weft-file-scan-root-${crypto.randomUUID()}`);

    try {
      mkdirSync(workspacePath, { recursive: true });
      const scanRootThatIsAFile = join(workspacePath, 'not-a-directory');
      await Bun.write(scanRootThatIsAFile, 'plain file');

      expect(
        await rejectionOf(expandGlobEntryPaths([join(scanRootThatIsAFile, '*.ts')])),
      ).toMatchObject({ code: 'ENOTDIR' });
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('keeps a missing scan root as an unexpanded entry path', async () => {
    const missingPattern = join(tmpdir(), `weft-missing-root-${crypto.randomUUID()}`, '*.ts');

    expect(await expandGlobEntryPaths([missingPattern])).toEqual([missingPattern]);
  });
});

describe('splitGlobPattern', () => {
  it('scans the filesystem root for a pattern directly under it', () => {
    expect(splitGlobPattern('/*.ts')).toEqual({ scanRoot: '/', pattern: '*.ts' });
  });

  it('keeps the separator on a Windows drive root so the scan root stays absolute', () => {
    expect(splitGlobPattern('C:/*.ts')).toEqual({ scanRoot: 'C:/', pattern: '*.ts' });
    expect(splitGlobPattern('C:\\*.ts')).toEqual({ scanRoot: 'C:/', pattern: '*.ts' });
  });

  it('splits a nested pattern at the last separator before the first wildcard', () => {
    expect(splitGlobPattern('src/**/*.ts')).toEqual({ scanRoot: 'src', pattern: '**/*.ts' });
    expect(splitGlobPattern('C:/projects/*.ts')).toEqual({
      scanRoot: 'C:/projects',
      pattern: '*.ts',
    });
  });

  it('treats a pattern without a separator as relative to the current directory', () => {
    expect(splitGlobPattern('*.ts')).toEqual({ scanRoot: '.', pattern: '*.ts' });
  });
});
