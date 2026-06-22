import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'bun:test';

import type * as DurableActivityModule from './durable-activity.ts';

describe('durableActivity portability', () => {
  it('keeps package-root browser imports buildable without process.getBuiltinModule', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weft-durable-activity-portability-'));
    const originalProcess = globalThis.process;
    try {
      const entrypoint = join(directory, 'entry.ts');
      await writeFile(
        entrypoint,
        [
          `import { durableActivity } from ${JSON.stringify(join(process.cwd(), 'src/index.ts'))};`,
          'delete (globalThis as { process?: unknown }).process;',
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
      await import(pathToFileURL(outputPath!).href);
    } finally {
      Object.defineProperty(globalThis, 'process', {
        configurable: true,
        value: originalProcess,
        writable: true,
      });
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('keeps async helper scope active when process.getBuiltinModule is absent', async () => {
    const originalProcess = globalThis.process;
    const moduleUrl = new URL(
      `./durable-activity.ts?fallback=${crypto.randomUUID()}`,
      import.meta.url,
    );
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: {},
      writable: true,
    });
    try {
      const { durableActivity, runWithDurableActivityScope } = (await import(
        moduleUrl.href
      )) as typeof DurableActivityModule;
      const dispatches: string[] = [];
      const result = await runWithDurableActivityScope(
        {
          dispatch: async <TResult>(
            invocation: DurableActivityModule.DurableActivityInvocation,
          ) => {
            dispatches.push(String(invocation.activity));
            return 'fallback-result' as TResult;
          },
        },
        async () => {
          await Promise.resolve();
          return durableActivity<string>('fallbackTool');
        },
      );

      expect(result).toBe('fallback-result');
      expect(dispatches).toEqual(['fallbackTool']);
    } finally {
      Object.defineProperty(globalThis, 'process', {
        configurable: true,
        value: originalProcess,
        writable: true,
      });
    }
  });
});
