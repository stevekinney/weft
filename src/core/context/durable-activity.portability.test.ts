import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'bun:test';

interface BunEntrypointResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

const textDecoder = new TextDecoder();

function runBunEntrypoint(entrypoint: string): BunEntrypointResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, entrypoint],
    cwd: process.cwd(),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stderr: textDecoder.decode(result.stderr),
    stdout: textDecoder.decode(result.stdout),
  };
}

function expectEntrypointSuccess(result: BunEntrypointResult): void {
  if (result.exitCode === 0) {
    return;
  }
  throw new Error(
    [
      `Expected isolated Bun entrypoint to exit 0, received ${String(result.exitCode)}.`,
      result.stdout.length > 0 ? `stdout:\n${result.stdout}` : '',
      result.stderr.length > 0 ? `stderr:\n${result.stderr}` : '',
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

describe('durableActivity portability', () => {
  it('keeps package-root browser imports buildable without process.getBuiltinModule', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weft-durable-activity-portability-'));
    try {
      const entrypoint = join(directory, 'entry.ts');
      await writeFile(
        entrypoint,
        [
          `import { durableActivity } from ${JSON.stringify(join(process.cwd(), 'src/index.ts'))};`,
          'void durableActivity;',
        ].join('\n'),
      );

      const result = await Bun.build({
        entrypoints: [entrypoint],
        target: 'browser',
        format: 'esm',
        outdir: directory,
        external: ['@opentelemetry/api', 'lmdb', '@libsql/client', '@neondatabase/serverless'],
      });

      expect(result.success).toBe(true);
      const outputPath = result.outputs.find((output) => output.path.endsWith('.js'))?.path;
      expect(outputPath).toBeDefined();
      const runner = join(directory, 'run-built-browser-bundle.ts');
      await writeFile(
        runner,
        [
          'delete (globalThis as { process?: unknown }).process;',
          `await import(${JSON.stringify(pathToFileURL(outputPath!).href)});`,
        ].join('\n'),
      );
      expectEntrypointSuccess(runBunEntrypoint(runner));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('keeps async helper scope active when process.getBuiltinModule is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weft-durable-activity-fallback-'));
    const moduleUrl = new URL(
      `./durable-activity.ts?fallback=${crypto.randomUUID()}`,
      import.meta.url,
    );
    try {
      const runner = join(directory, 'run-fallback-scope.ts');
      await writeFile(
        runner,
        [
          "Object.defineProperty(globalThis, 'process', {",
          '  configurable: true,',
          '  value: {},',
          '  writable: true,',
          '});',
          `const { durableActivity, runWithDurableActivityScope } = await import(${JSON.stringify(
            moduleUrl.href,
          )});`,
          'const dispatches = [];',
          'const result = await runWithDurableActivityScope(',
          '  {',
          '    dispatch: async (invocation) => {',
          '      dispatches.push(String(invocation.activity));',
          "      return 'fallback-result';",
          '    },',
          '  },',
          '  async () => {',
          '    await Promise.resolve();',
          "    return durableActivity('fallbackTool');",
          '  },',
          ');',
          "if (result !== 'fallback-result') {",
          '  throw new Error(`Unexpected fallback result: ${String(result)}`);',
          '}',
          'if (JSON.stringify(dispatches) !== \'["fallbackTool"]\') {',
          '  throw new Error(`Unexpected fallback dispatches: ${JSON.stringify(dispatches)}`);',
          '}',
        ].join('\n'),
      );

      expectEntrypointSuccess(runBunEntrypoint(runner));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects overlapping fallback scopes instead of dispatching through the wrong memo', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weft-durable-activity-overlap-'));
    const moduleUrl = new URL(
      `./durable-activity.ts?overlap=${crypto.randomUUID()}`,
      import.meta.url,
    );
    try {
      const runner = join(directory, 'run-overlapping-fallback-scopes.ts');
      await writeFile(
        runner,
        [
          "Object.defineProperty(globalThis, 'process', {",
          '  configurable: true,',
          '  value: {},',
          '  writable: true,',
          '});',
          `const { durableActivity, DurableActivityScopeError, runWithDurableActivityScope } = await import(${JSON.stringify(
            moduleUrl.href,
          )});`,
          'const firstCanContinue = Promise.withResolvers();',
          'const secondCanFinish = Promise.withResolvers();',
          'let firstDispatched = false;',
          'const first = runWithDurableActivityScope(',
          '  {',
          '    dispatch: async () => {',
          '      firstDispatched = true;',
          "      throw new Error('first scope should not dispatch while fallback scope is ambiguous');",
          '    },',
          '  },',
          '  async () => {',
          '    await firstCanContinue.promise;',
          "    return durableActivity('firstTool');",
          '  },',
          ');',
          'const second = runWithDurableActivityScope(',
          '  {',
          "    dispatch: async () => 'second-result',",
          '  },',
          '  async () => {',
          '    await secondCanFinish.promise;',
          "    return 'second-done';",
          '  },',
          ');',
          'firstCanContinue.resolve();',
          'let rejectedWithScopeError = false;',
          'try {',
          '  await first;',
          '} catch (error) {',
          '  rejectedWithScopeError =',
          '    error instanceof DurableActivityScopeError &&',
          "    String(error.message).includes('cannot resolve a unique ctx.memo() scope');",
          '}',
          'if (!rejectedWithScopeError) {',
          "  throw new Error('Expected overlapping fallback durableActivity() to reject with DurableActivityScopeError');",
          '}',
          'if (firstDispatched) {',
          "  throw new Error('Ambiguous fallback scope dispatched through an owner');",
          '}',
          'secondCanFinish.resolve();',
          'const secondResult = await second;',
          "if (secondResult !== 'second-done') {",
          '  throw new Error(`Unexpected second scope result: ${String(secondResult)}`);',
          '}',
        ].join('\n'),
      );

      expectEntrypointSuccess(runBunEntrypoint(runner));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
