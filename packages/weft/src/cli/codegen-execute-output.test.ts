import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { HANG_GUARD_MILLISECONDS } from "../../test-support/embedded/testing/src/hang-guard.ts";
import { CodegenEmitError, CodegenPackageNameError } from './codegen-emit-registry.ts';
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
      timeoutMs: HANG_GUARD_MILLISECONDS,
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
      timeoutMs: HANG_GUARD_MILLISECONDS,
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
      timeoutMs: HANG_GUARD_MILLISECONDS,
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
      timeoutMs: HANG_GUARD_MILLISECONDS,
      json: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed: Record<string, unknown> = JSON.parse(result.stderr ?? '');
    expect(parsed['ok']).toBe(false);
    expect(parsed['error']).toContain('--from file not found');
  });

  it('reports a rename failure and removes the temporary file when the output path is a directory', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    mkdirSync(out);
    const result = await executeCodegen({
      from: REGISTRY_FIXTURE,
      out,
      timeoutMs: HANG_GUARD_MILLISECONDS,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`to '${out}': `);
    expect(result.stderr).toContain('codegen: failed to rename');
    expect(readdirSync(dir)).toEqual(['weft.d.ts']);
  });

  it('emits an empty worker workflow map for a registry with no workflows', async () => {
    const dir = makeTempDir();
    const from = join(dir, 'registry.json');
    const out = join(dir, 'worker.ts');
    writeFileSync(
      from,
      JSON.stringify({
        registryVersion: 2,
        generatedAt: new Date(0).toISOString(),
        workflows: [],
        activeRevisions: {},
        activities: {},
      }),
    );
    const result = await executeCodegen({
      from,
      out,
      target: 'worker',
      timeoutMs: HANG_GUARD_MILLISECONDS,
    });
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(out).text()).toContain('type __WeftGeneratedWorkerWorkflows = {};');
  });

  it('reports an emitter refusal as a diagnostic, not as an unexpected failure', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const refusing = (error: Error) => (): string => {
      throw error;
    };

    const emitRefusal = await executeCodegen(
      { from: REGISTRY_FIXTURE, out, timeoutMs: HANG_GUARD_MILLISECONDS },
      {
        registry: refusing(new CodegenEmitError('cannot emit this schema')),
        worker: refusing(new Error('unused')),
      },
    );
    expect(emitRefusal.exitCode).toBe(1);
    expect(emitRefusal.stderr).toBe('codegen: cannot emit this schema');

    const packageNameRefusal = await executeCodegen(
      { from: REGISTRY_FIXTURE, out, target: 'worker', timeoutMs: HANG_GUARD_MILLISECONDS },
      {
        registry: refusing(new Error('unused')),
        worker: refusing(new CodegenPackageNameError('bad package name')),
      },
    );
    expect(packageNameRefusal.exitCode).toBe(1);
    expect(packageNameRefusal.stderr).toBe('codegen: bad package name');
    expect(existsSync(out)).toBe(false);
  });

  it('reports an unexpected emitter failure with its message instead of rejecting', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const failing = (): string => {
      throw new TypeError('emitter exploded');
    };
    const registryFailure = await executeCodegen(
      { from: REGISTRY_FIXTURE, out, timeoutMs: HANG_GUARD_MILLISECONDS },
      { registry: failing, worker: failing },
    );
    expect(registryFailure.exitCode).toBe(1);
    expect(registryFailure.stderr).toBe('codegen: unexpected emitter failure: emitter exploded');

    const nonErrorFailure = await executeCodegen(
      { from: REGISTRY_FIXTURE, out, target: 'worker', timeoutMs: HANG_GUARD_MILLISECONDS },
      {
        registry: failing,
        worker: () => {
          throw 'a thrown string';
        },
      },
    );
    expect(nonErrorFailure.stderr).toBe('codegen: unexpected emitter failure: a thrown string');
    expect(existsSync(out)).toBe(false);
  });
});

afterAll(() => {
  expect(tempDirs).toHaveLength(0);
});
