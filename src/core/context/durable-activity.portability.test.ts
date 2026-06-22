import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'bun:test';

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
});
