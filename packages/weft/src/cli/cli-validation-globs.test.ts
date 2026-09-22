import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeValidate } from './index.ts';
import { expandGlobEntryPaths } from './utilities.ts';

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

      expect(expandGlobEntryPaths([join(workspacePath, 'examples/**/*.ts')])).resolves.toEqual([
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

      expect(expandGlobEntryPaths([join(workspacePath, 'examples/**/*.test.ts')])).resolves.toEqual(
        [join(workspacePath, 'examples/order-processing/src.test.ts')],
      );
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
        expandGlobEntryPaths([join(workspacePath, 'examples/**/tests/**/*.ts')]),
      ).resolves.toEqual([
        join(workspacePath, 'examples/order-processing/tests/order-processing.test.ts'),
      ]);
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
        expandGlobEntryPaths([join(workspacePath, 'examples/order-processing/tests/**/*.ts')]),
      ).resolves.toEqual([
        join(workspacePath, 'examples/order-processing/tests/order-processing.test.ts'),
      ]);
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

      expect(expandGlobEntryPaths([join(workspacePath, 'examples/**/*.ts')])).resolves.toEqual([
        join(workspacePath, 'examples/order-processing/src.ts'),
      ]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
