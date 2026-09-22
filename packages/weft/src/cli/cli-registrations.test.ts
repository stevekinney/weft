import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadRegistrationsFromModule } from './validation.ts';

const publicEntryPointUrl = import.meta.resolve('../index.ts');

it('keeps filesystem workflow loading in the CLI while exposing the HTTP client', async () => {
  const publicApi = await import('../index.ts');
  expect(publicApi.HttpClient).toBeFunction();
  expect(publicApi).not.toHaveProperty('loadRegistrationsFromModule');
  expect(publicApi).not.toHaveProperty('validateRegistrations');
  expect(publicApi).not.toHaveProperty('formatValidationReport');
});

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

describe('loadRegistrationsFromModule', () => {
  it('extracts WorkflowDefinition from named exports', async () => {
    const entryPath = createTemporaryTypeScriptPath('weft-load-named');
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
      const result = await loadRegistrationsFromModule(entryPath);
      expect('myWorkflow' in result.registrations).toBe(true);
      expect(result.activities).toHaveLength(0);
      const iterator = invokeFixtureWorkflow(result.registrations['myWorkflow']!.handler);
      expect(iterator.next()).resolves.toEqual({ value: 'done', done: true });
    } finally {
      removeTemporaryTypeScriptPath(entryPath);
    }
  });

  it('extracts ActivityDefinition from named exports', async () => {
    const entryPath = createTemporaryTypeScriptPath('weft-load-activity');
    try {
      await Bun.write(
        entryPath,
        [
          'import type { ActivityDefinition } from "./src/core/types.ts";',
          'export const sendEmail: ActivityDefinition = {',
          '  name: "sendEmail",',
          '  execute: async (input: unknown) => input,',
          '};',
        ].join('\n'),
      );
      const result = await loadRegistrationsFromModule(entryPath);
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0]!.name).toBe('sendEmail');
      expect(result.activities[0]!.execute('payload')).resolves.toBe('payload');
    } finally {
      removeTemporaryTypeScriptPath(entryPath);
    }
  });

  it('rejects with an error for a non-existent file', async () => {
    expect(loadRegistrationsFromModule('/does/not/exist/workflow.ts')).rejects.toThrow();
  });

  it('returns empty registrations and activities for a module with no matching exports', async () => {
    const entryPath = createTemporaryTypeScriptPath('weft-load-empty');
    try {
      await Bun.write(entryPath, 'export const foo = 42;\n');
      const result = await loadRegistrationsFromModule(entryPath);
      expect(Object.keys(result.registrations)).toHaveLength(0);
      expect(result.activities).toHaveLength(0);
    } finally {
      removeTemporaryTypeScriptPath(entryPath);
    }
  });
});
