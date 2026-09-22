import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { executeValidate } from './index.ts';
import { loadRegistrationsFromModule } from './validation.ts';

const publicEntryPointUrl = import.meta.resolve('../index.ts');

function createTemporaryTypeScriptPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), `${prefix}-`)), 'module.ts');
}

function removeTemporaryTypeScriptPath(filePath: string): void {
  rmSync(dirname(filePath), { force: true, recursive: true });
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'next' in value &&
    typeof value.next === 'function' &&
    'return' in value &&
    typeof value.return === 'function' &&
    'throw' in value &&
    typeof value.throw === 'function' &&
    Symbol.asyncIterator in value
  );
}

function invokeFixtureWorkflow(handler: unknown): AsyncGenerator<unknown, unknown, unknown> {
  if (typeof handler !== 'function') throw new TypeError('workflow handler is not callable');
  const iterator: unknown = Reflect.apply(handler, undefined, [{}, undefined]);
  if (!isAsyncGenerator(iterator)) {
    throw new TypeError('workflow handler did not return an async iterator');
  }
  return iterator;
}

describe('executeValidate', () => {
  it('returns exitCode 2 and stderr when no entry paths are provided', async () => {
    const result = await executeValidate({ entryPaths: [], json: false });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('entry file path is required');
    expect(result.stdout).toBe('');
  });

  it('returns exitCode 2 and stderr when entry file does not exist', async () => {
    const result = await executeValidate({
      entryPaths: ['/does/not/exist/entry.ts'],
      json: false,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('could not load entry file');
  });

  it('returns exitCode 0 and stdout with no-issues message for a clean module', async () => {
    const entryPath = createTemporaryTypeScriptPath('weft-validate-clean');
    try {
      await Bun.write(
        entryPath,
        [
          `import type { WorkflowDefinition } from "${publicEntryPointUrl}";`,
          'export const myWorkflow: WorkflowDefinition = {',
          '  name: "myWorkflow",',
          '  handler: async function* () { return "done"; },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({ entryPaths: [entryPath], json: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No issues found.');
      const loaded = await loadRegistrationsFromModule(entryPath);
      const iterator = invokeFixtureWorkflow(loaded.registrations['myWorkflow']!.handler);
      expect(iterator.next()).resolves.toEqual({ value: 'done', done: true });
    } finally {
      removeTemporaryTypeScriptPath(entryPath);
    }
  });

  it('returns exitCode 1 when an activity has unbounded retry', async () => {
    const entryPath = createTemporaryTypeScriptPath('weft-validate-error');
    try {
      await Bun.write(
        entryPath,
        [
          'import type { ActivityDefinition } from "./src/core/types.ts";',
          'export const badActivity: ActivityDefinition = {',
          '  name: "badActivity",',
          '  execute: async (input: unknown) => input,',
          '  idempotent: true,',
          '  retry: { maxAttempts: Infinity, initialBackoff: "1s", backoffMultiplier: 2, maxBackoff: "30s" },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({ entryPaths: [entryPath], json: false });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('unbounded-retry');
      const loaded = await loadRegistrationsFromModule(entryPath);
      expect(loaded.activities[0]!.execute('payload')).resolves.toBe('payload');
    } finally {
      removeTemporaryTypeScriptPath(entryPath);
    }
  });

  it('returns valid JSON when json: true', async () => {
    const entryPath = createTemporaryTypeScriptPath('weft-validate-json');
    try {
      await Bun.write(
        entryPath,
        [
          `import type { WorkflowDefinition } from "${publicEntryPointUrl}";`,
          'export const myWorkflow: WorkflowDefinition = {',
          '  name: "myWorkflow",',
          '  handler: async function* () { return "done"; },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({ entryPaths: [entryPath], json: true });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        valid: true,
        hasLoadErrors: false,
        hasValidationErrors: false,
        entries: [
          {
            entryPath,
            valid: true,
            issues: [],
            workflowCount: expect.any(Number),
          },
        ],
      });
      const loaded = await loadRegistrationsFromModule(entryPath);
      const iterator = invokeFixtureWorkflow(loaded.registrations['myWorkflow']!.handler);
      expect(iterator.next()).resolves.toEqual({ value: 'done', done: true });
    } finally {
      removeTemporaryTypeScriptPath(entryPath);
    }
  });

  it('returns exitCode 0 when multiple clean entry files validate', async () => {
    const firstEntryPath = createTemporaryTypeScriptPath('weft-validate-multi-a');
    const secondEntryPath = createTemporaryTypeScriptPath('weft-validate-multi-b');

    try {
      await Bun.write(
        firstEntryPath,
        [
          `import type { WorkflowDefinition } from "${publicEntryPointUrl}";`,
          'export const firstWorkflow: WorkflowDefinition = {',
          '  name: "firstWorkflow",',
          '  handler: async function* () { return "first"; },',
          '};',
        ].join('\n'),
      );
      await Bun.write(
        secondEntryPath,
        [
          `import type { WorkflowDefinition } from "${publicEntryPointUrl}";`,
          'export const secondWorkflow: WorkflowDefinition = {',
          '  name: "secondWorkflow",',
          '  handler: async function* () { return "second"; },',
          '};',
        ].join('\n'),
      );

      const result = await executeValidate({
        entryPaths: [firstEntryPath, secondEntryPath],
        json: false,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(firstEntryPath);
      expect(result.stdout).toContain(secondEntryPath);
      expect(result.stdout).toContain('No issues found.');
    } finally {
      removeTemporaryTypeScriptPath(firstEntryPath);
      removeTemporaryTypeScriptPath(secondEntryPath);
    }
  });

  it('returns exitCode 0 for the retained workflow fixtures validation gate', async () => {
    const result = await executeValidate({
      entryPaths: [
        'src/cli/__fixtures__/validation/hello-world/src/**/*.ts',
        'src/cli/__fixtures__/validation/order-processing/src/**/*.ts',
      ],
      json: false,
    });

    expect(result.exitCode).toBe(0);
    // Globs are validated in argument order, so the hello-world entry precedes
    // the order-processing entries.
    expect(
      result.stdout.indexOf('src/cli/__fixtures__/validation/hello-world/src/index.ts'),
    ).toBeLessThan(
      result.stdout.indexOf(
        'src/cli/__fixtures__/validation/order-processing/src/workflows/order.ts',
      ),
    );
    expect(result.stdout).toContain('src/cli/__fixtures__/validation/hello-world/src/index.ts');
    expect(result.stdout).toContain(
      'src/cli/__fixtures__/validation/order-processing/src/workflows/order.ts',
    );
  });
});
