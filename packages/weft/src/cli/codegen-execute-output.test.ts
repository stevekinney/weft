import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { executeCodegen } from './codegen.ts';

const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/codegen');
const REGISTRY_FIXTURE = join(FIXTURE_DIR, 'registry.json');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-codegen-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('executeCodegen end-to-end', () => {
  it('rejects passing both --server and --from to executeCodegen directly', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const result = await executeCodegen({
      server: 'http://example.invalid',
      from: REGISTRY_FIXTURE,
      out,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--server and --from cannot be used together');
    expect(existsSync(out)).toBe(false);
  });

  it('emits a single JSON object on stdout with --json on success', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const first = await executeCodegen({
      from: REGISTRY_FIXTURE,
      out,
      timeoutMs: 30_000,
      json: true,
    });
    expect(first.exitCode).toBe(0);
    const parsed: Record<string, unknown> = JSON.parse(first.stdout);
    expect(parsed['ok']).toBe(true);
    expect(parsed['action']).toBe('wrote');
    expect(parsed['out']).toBe(out);
    expect(parsed['workflows']).toBeGreaterThan(0);
    expect(parsed['activities']).toBeGreaterThan(0);

    const second = await executeCodegen({
      from: REGISTRY_FIXTURE,
      out,
      timeoutMs: 30_000,
      json: true,
    });
    expect(second.exitCode).toBe(0);
    const repeat: Record<string, unknown> = JSON.parse(second.stdout);
    expect(repeat['ok']).toBe(true);
    expect(repeat['action']).toBe('unchanged');
    expect(repeat['out']).toBe(out);
    // Counts are included in both `wrote` and `unchanged` payloads so
    // machine consumers see a stable shape.
    expect(repeat['workflows']).toBeGreaterThan(0);
    expect(repeat['activities']).toBeGreaterThan(0);
  });

  it('emits {ok:false,error} on stderr with --json on failure', async () => {
    const dir = makeTempDir();
    const result = await executeCodegen({
      from: join(dir, 'no-such-file.json'),
      out: join(dir, 'weft.d.ts'),
      timeoutMs: 30_000,
      json: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed: Record<string, unknown> = JSON.parse(result.stderr ?? '');
    expect(parsed['ok']).toBe(false);
    expect(parsed['error']).toContain('--from file not found');
  });
});

afterAll(() => {
  expect(tempDirs).toHaveLength(0);
});
