/**
 * Built-output smoke test for `@lostgradient/weft/storage/auto`.
 *
 * Runs `resolveDefaultStorage()` and constructs an `Engine` against the
 * resolved storage from the dist bundle. Catches regressions where source
 * tests pass but the built package's import paths break (e.g. `.ts` vs `.js`
 * suffix, `dist/storage/auto` not emitted, externalized packages missing).
 *
 * Run with: `bun run build && bun run scripts/smoke-storage-auto.ts`
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileStepWorkflow, Engine, workflow } from '../dist/index.js';
import { resolveDefaultStorage } from '../dist/storage/auto.js';

const tempDir = join(tmpdir(), `weft-smoke-${Date.now()}`);
const storagePath = join(tempDir, 'weft.db');
process.env['WEFT_DEFAULT_STORAGE_PATH'] = storagePath;

function formatSmokeValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {}

  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

try {
  const storage = await resolveDefaultStorage();
  if (storage === null || storage === undefined) {
    throw new Error('smoke-storage-auto: resolveDefaultStorage returned no storage');
  }
  const engine = new Engine({ storage });
  if (!(engine instanceof Engine)) {
    throw new Error('smoke-storage-auto: new Engine did not return an Engine instance');
  }
  engine.register(workflow({ name: 'hello' }).execute(compileStepWorkflow(async () => 'world')));
  const handle = await engine.start('hello');
  const result = await handle.result();
  if (result !== 'world') {
    const actual = formatSmokeValue(result);
    throw new Error(`smoke-storage-auto: expected 'world', got ${actual}`);
  }
  engine[Symbol.dispose]();
  if (typeof (storage as { [Symbol.dispose]?: () => void })[Symbol.dispose] === 'function') {
    (storage as { [Symbol.dispose]: () => void })[Symbol.dispose]();
  }
  process.stdout.write('smoke-storage-auto: OK\n');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env['WEFT_DEFAULT_STORAGE_PATH'];
}
