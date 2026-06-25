import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDefaultStorage } from './auto.ts';

describe('resolveDefaultStorage', () => {
  // All tests run inside an isolated temp directory and route the
  // resolver's path policy through `WEFT_DEFAULT_STORAGE_PATH` so the
  // test never touches the real `${tmpdir()}/weft-default/` location
  // (which would persist across runs and across tests).
  let testTempDir: string;
  let previousEnv: string | undefined;

  beforeEach(() => {
    testTempDir = mkdtempSync(join(tmpdir(), 'weft-auto-test-'));
    previousEnv = process.env['WEFT_DEFAULT_STORAGE_PATH'];
    process.env['WEFT_DEFAULT_STORAGE_PATH'] = join(testTempDir, 'weft.db');
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env['WEFT_DEFAULT_STORAGE_PATH'];
    else process.env['WEFT_DEFAULT_STORAGE_PATH'] = previousEnv;
    rmSync(testTempDir, { recursive: true, force: true });
  });

  it('returns BunSQLiteStorage in the Bun runtime', async () => {
    await using storage = await resolveDefaultStorage();
    expect(storage.constructor.name).toBe('BunSQLiteStorage');
  });

  it('honors WEFT_DEFAULT_STORAGE_PATH and creates the parent directory', async () => {
    const customPath = join(testTempDir, 'nested', 'subdir', 'weft.db');
    process.env['WEFT_DEFAULT_STORAGE_PATH'] = customPath;
    await using storage = await resolveDefaultStorage();
    expect(storage.constructor.name).toBe('BunSQLiteStorage');
    expect(existsSync(join(testTempDir, 'nested', 'subdir'))).toBe(true);
  });

  it('bundles for browser targets without static Node built-ins', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'weft-auto-browser-build-'));
    const entryPath = join(temporaryDirectory, 'entry.ts');
    const autoModulePath = fileURLToPath(new URL('./auto.ts', import.meta.url));

    try {
      await Bun.write(
        entryPath,
        `import { resolveDefaultStorage } from ${JSON.stringify(autoModulePath)};
(globalThis as Record<string, unknown>)['resolveDefaultStorage'] = resolveDefaultStorage;
`,
      );

      const build = await Bun.build({
        entrypoints: [entryPath],
        format: 'iife',
        minify: false,
        target: 'browser',
      });

      expect(build.success).toBe(true);
      const source = await build.outputs[0]!.text();
      expect(source).toContain('resolveDefaultStorage');
      expect(source).toContain('IndexedDBStorage');
      expect(source).toContain('WebExtensionStorage');
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
