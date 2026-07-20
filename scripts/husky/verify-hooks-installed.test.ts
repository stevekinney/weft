import { $ } from 'bun';
import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyHooksInstalled } from './verify-hooks-installed.ts';

const tempDirectories: string[] = [];

function createTempRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-verify-hooks-'));
  tempDirectories.push(dir);
  return dir;
}

async function initializeGitRepository(repoRoot: string): Promise<void> {
  await $`git -C ${repoRoot} init --quiet`.quiet();
}

function writeExecutable(path: string, contents = '#!/usr/bin/env sh\nexit 0\n'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const dir = tempDirectories.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('verifyHooksInstalled', () => {
  it('passes when core.hooksPath is set and both dispatcher and tracked hook exist', async () => {
    const repoRoot = createTempRepository();
    await initializeGitRepository(repoRoot);
    await $`git -C ${repoRoot} config core.hooksPath .husky/_`.quiet();
    writeExecutable(join(repoRoot, '.husky/_/pre-commit'));
    writeExecutable(join(repoRoot, '.husky/pre-commit'));

    expect(await verifyHooksInstalled(repoRoot)).toEqual({ ok: true });
  });

  it('fails when core.hooksPath is unset', async () => {
    const repoRoot = createTempRepository();
    await initializeGitRepository(repoRoot);

    const result = await verifyHooksInstalled(repoRoot);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/core\.hooksPath/);
  });

  it('fails when core.hooksPath points somewhere else', async () => {
    const repoRoot = createTempRepository();
    await initializeGitRepository(repoRoot);
    await $`git -C ${repoRoot} config core.hooksPath .git/hooks`.quiet();

    const result = await verifyHooksInstalled(repoRoot);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/expected "\.husky\/_"/);
  });

  it('fails when the husky-generated dispatcher is missing', async () => {
    const repoRoot = createTempRepository();
    await initializeGitRepository(repoRoot);
    await $`git -C ${repoRoot} config core.hooksPath .husky/_`.quiet();
    writeExecutable(join(repoRoot, '.husky/pre-commit'));

    const result = await verifyHooksInstalled(repoRoot);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/dispatcher isn't present/);
  });

  it('fails when the dispatcher exists but is not executable', async () => {
    const repoRoot = createTempRepository();
    await initializeGitRepository(repoRoot);
    await $`git -C ${repoRoot} config core.hooksPath .husky/_`.quiet();
    mkdirSync(join(repoRoot, '.husky/_'), { recursive: true });
    writeFileSync(join(repoRoot, '.husky/_/pre-commit'), '#!/usr/bin/env sh\nexit 0\n');
    chmodSync(join(repoRoot, '.husky/_/pre-commit'), 0o644);
    writeExecutable(join(repoRoot, '.husky/pre-commit'));

    const result = await verifyHooksInstalled(repoRoot);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/dispatcher isn't present/);
  });

  it('fails when the tracked .husky/pre-commit source is missing', async () => {
    const repoRoot = createTempRepository();
    await initializeGitRepository(repoRoot);
    await $`git -C ${repoRoot} config core.hooksPath .husky/_`.quiet();
    writeExecutable(join(repoRoot, '.husky/_/pre-commit'));

    const result = await verifyHooksInstalled(repoRoot);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/\.husky\/pre-commit is missing/);
  });

  it('passes when the tracked .husky/pre-commit source is readable but not executable', async () => {
    // Husky's dispatcher runs this file via `sh -e "$s"`, not execve — a
    // checkout that doesn't preserve the executable bit (core.filemode=false,
    // some Windows setups) still works. Only the generated .husky/_/pre-commit
    // dispatcher needs +x, since git execs that one directly.
    const repoRoot = createTempRepository();
    await initializeGitRepository(repoRoot);
    await $`git -C ${repoRoot} config core.hooksPath .husky/_`.quiet();
    writeExecutable(join(repoRoot, '.husky/_/pre-commit'));
    mkdirSync(join(repoRoot, '.husky'), { recursive: true });
    writeFileSync(join(repoRoot, '.husky/pre-commit'), '#!/usr/bin/env sh\nexit 0\n');
    chmodSync(join(repoRoot, '.husky/pre-commit'), 0o644);

    expect(await verifyHooksInstalled(repoRoot)).toEqual({ ok: true });
  });
});

describe('verify-hooks-installed CLI', () => {
  it("exits 0 without checking anything when HUSKY=0 (husky's own install opt-out)", async () => {
    // node_modules/husky/index.js: `if (process.env.HUSKY === '0') return 'HUSKY=0 skip
    // install'` — husky itself skips setting core.hooksPath for CI/Docker/container
    // builds that intentionally don't want hooks. This verifier must not turn that
    // supported no-op into a failed `bun install`.
    // Only cwd for the spawned process; the script resolves repoRoot from its own
    // file location (import.meta.dir), not cwd, but HUSKY=0 must short-circuit
    // before that resolution or any verification ever runs, so this repo's own
    // (real, correctly-wired) hooks state is irrelevant to what's under test here.
    const repoRoot = createTempRepository();
    await initializeGitRepository(repoRoot);

    const scriptPath = join(import.meta.dir, 'verify-hooks-installed.ts');
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', scriptPath],
      cwd: repoRoot,
      env: { ...process.env, HUSKY: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain('HUSKY=0');
  });
});
