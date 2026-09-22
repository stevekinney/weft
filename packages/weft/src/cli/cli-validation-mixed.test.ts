import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { executeValidate } from './index.ts';
import { expandGlobEntryPaths } from './utilities.ts';

const publicEntryPointUrl = import.meta.resolve('../index.ts');

function createTemporaryTypeScriptPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), `${prefix}-`)), 'module.ts');
}

function removeTemporaryTypeScriptPath(filePath: string): void {
  rmSync(dirname(filePath), { force: true, recursive: true });
}

describe('executeValidate', () => {
  it('does not return a literal glob when all matches are intentionally ignored', async () => {
    const workspacePath = join(tmpdir(), `weft-validate-ignored-only-${crypto.randomUUID()}`);
    const examplePath = join(workspacePath, 'examples');

    try {
      mkdirSync(examplePath, { recursive: true });
      await Bun.write(join(examplePath, 'only.test.ts'), 'export const testWorkflow = "clean";');

      expect(expandGlobEntryPaths([join(workspacePath, 'examples/*.ts')])).resolves.toEqual([]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('reports a validation load error instead of throwing when a glob root is missing', async () => {
    const missingGlobPath = join(
      tmpdir(),
      `weft-validate-missing-glob-${crypto.randomUUID()}`,
      'examples/**/*.ts',
    );

    const result = await executeValidate({
      entryPaths: [missingGlobPath],
      json: true,
    });

    expect(result.exitCode).toBe(2);
    const parsed: {
      entries: Array<{ entryPath: string; loadError?: string }>;
      hasLoadErrors: boolean;
    } = JSON.parse(result.stdout);
    expect(parsed.hasLoadErrors).toBe(true);
    expect(parsed.entries[0]).toMatchObject({
      entryPath: missingGlobPath,
    });
    expect(parsed.entries[0]?.loadError).toContain('Cannot find module');
  });

  it('returns exitCode 2 when a clean entry and a missing entry are validated together', async () => {
    const cleanEntryPath = createTemporaryTypeScriptPath('weft-validate-mixed-clean');

    try {
      await Bun.write(
        cleanEntryPath,
        [
          `import type { WorkflowDefinition } from "${publicEntryPointUrl}";`,
          'export const cleanWorkflow: WorkflowDefinition = {',
          '  name: "cleanWorkflow",',
          '  handler: async function* () { return "clean"; },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({
        entryPaths: [cleanEntryPath, '/does/not/exist/entry.ts'],
        json: false,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain(cleanEntryPath);
      expect(result.stdout).toContain('No issues found.');
      expect(result.stderr).toContain('/does/not/exist/entry.ts');
    } finally {
      removeTemporaryTypeScriptPath(cleanEntryPath);
    }
  });

  it('returns exitCode 1 when a clean entry and an invalid entry are validated together', async () => {
    const cleanEntryPath = createTemporaryTypeScriptPath('weft-validate-mixed-clean');
    const invalidEntryPath = createTemporaryTypeScriptPath('weft-validate-mixed-invalid');

    try {
      await Bun.write(
        cleanEntryPath,
        [
          `import type { WorkflowDefinition } from "${publicEntryPointUrl}";`,
          'export const cleanWorkflow: WorkflowDefinition = {',
          '  name: "cleanWorkflow",',
          '  handler: async function* () { return "clean"; },',
          '};',
        ].join('\n'),
      );
      await Bun.write(
        invalidEntryPath,
        [
          `import type { WorkflowDefinition } from "${publicEntryPointUrl}";`,
          `import { activity } from "${publicEntryPointUrl}";`,
          'export const sendEmail = activity({',
          '  name: "sendEmail",',
          '  idempotent: false,',
          '  execute: async () => undefined,',
          '});',
          'export const invalidWorkflow: WorkflowDefinition = {',
          '  name: "invalidWorkflow",',
          '  handler: async function* (_ctx, input) {',
          '    return yield* sendEmail(input);',
          '  },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({
        entryPaths: [cleanEntryPath, invalidEntryPath],
        json: false,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(cleanEntryPath);
      expect(result.stdout).toContain(invalidEntryPath);
      expect(result.stdout).toContain('stateful-without-compensator');
      expect(result.stderr).toBeUndefined();
    } finally {
      removeTemporaryTypeScriptPath(cleanEntryPath);
      removeTemporaryTypeScriptPath(invalidEntryPath);
    }
  });

  it('returns a stable JSON envelope for mixed load and validation outcomes', async () => {
    const invalidEntryPath = createTemporaryTypeScriptPath('weft-validate-json-invalid');

    try {
      await Bun.write(
        invalidEntryPath,
        [
          `import type { WorkflowDefinition } from "${publicEntryPointUrl}";`,
          `import { activity } from "${publicEntryPointUrl}";`,
          'export const sendEmail = activity({',
          '  name: "sendEmail",',
          '  idempotent: false,',
          '  execute: async () => undefined,',
          '});',
          'export const invalidWorkflow: WorkflowDefinition = {',
          '  name: "invalidWorkflow",',
          '  handler: async function* (_ctx, input) {',
          '    return yield* sendEmail(input);',
          '  },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({
        entryPaths: [invalidEntryPath, '/does/not/exist/entry.ts'],
        json: true,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBeUndefined();
      expect(JSON.parse(result.stdout)).toMatchObject({
        valid: false,
        hasLoadErrors: true,
        hasValidationErrors: true,
        entries: [
          {
            entryPath: invalidEntryPath,
            valid: false,
            issues: [
              expect.objectContaining({
                code: 'stateful-without-compensator',
              }),
            ],
          },
          {
            entryPath: '/does/not/exist/entry.ts',
            loadError: expect.any(String),
          },
        ],
      });
    } finally {
      removeTemporaryTypeScriptPath(invalidEntryPath);
    }
  });
});
