import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as root from './index.ts';
import * as testing from './testing/index.ts';

/**
 * COR-1192. The root once re-exported the whole testing barrel, which carried the subprocess
 * engine's `Bun.spawn` into the root's browser bundle; the published package's portability gate
 * refused the 0.26.0 release on it, and nothing in this workspace had checked the bundle first.
 * The root keeps the portable testing primitives and leaves process-spawning helpers to
 * `@lostgradient/weft/testing`; the bundle check below is the gate the release tripped on.
 */
describe('the root entry and the testing barrel', () => {
  test('the root exports the portable testing primitives', () => {
    expect(typeof root.TestEngine).toBe('function');
    expect(typeof root.TimeControl).toBe('function');
    expect(typeof root.ActivityMockRegistry).toBe('function');
    expect(typeof root.withChaos).toBe('function');
    expect(typeof root.flushPortableMicrotasks).toBe('function');
  });

  test('the root does not export the subprocess engine, which the testing subpath keeps', () => {
    const rootExports = root as Record<string, unknown>;
    const testingExports = testing as Record<string, unknown>;
    for (const name of ['spawnServerSubprocess', 'withSubprocessServer', 'killAndReboot']) {
      expect(rootExports[name], name).toBeUndefined();
      expect(typeof testingExports[name], name).toBe('function');
    }
  });

  test('the root bundles for the browser without Bun.spawn', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'weft-root-portability-'));
    try {
      const result = await Bun.build({
        entrypoints: [join(import.meta.dir, 'index.ts')],
        outdir,
        target: 'browser',
        format: 'esm',
        minify: false,
        // The same heavy optional dependencies the published package's portability gate leaves out.
        external: ['@opentelemetry/api', 'lmdb', '@libsql/client', '@neondatabase/serverless'],
      });
      expect(result.success, result.logs.map((log) => log.message).join('\n')).toBe(true);
      const bundled = await Promise.all(result.outputs.map((output) => output.text()));
      const occurrences = bundled.join('\n').match(/\bBun\.spawn\b/g) ?? [];
      expect(occurrences).toHaveLength(0);
    } finally {
      await rm(outdir, { recursive: true, force: true });
    }
  });
});
