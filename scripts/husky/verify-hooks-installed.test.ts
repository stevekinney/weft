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
});
