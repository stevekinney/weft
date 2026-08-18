import { $ } from 'bun';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRatchetStash,
  RATCHET_STASH_MESSAGE,
  restoreRatchetStash,
  withRatchetStash,
} from './pre-commit.ts';
import {
  error,
  fileChangedBetween,
  getStagedFiles,
  header,
  info,
  isContinuousIntegration,
  printGitStatistics,
  success,
  warning,
} from './utilities.ts';

const temporaryRepositories = new Set<string>();

async function createRepository(): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'weft-precommit-stash-'));
  temporaryRepositories.add(repositoryRoot);
  await $`git -C ${repositoryRoot} init --quiet`.quiet();
  await $`git -C ${repositoryRoot} config user.email test@example.com`.quiet();
  await $`git -C ${repositoryRoot} config user.name "Weft Test"`.quiet();
  await Bun.write(join(repositoryRoot, 'tracked.txt'), 'base\n');
  await $`git -C ${repositoryRoot} add tracked.txt`.quiet();
  await $`git -C ${repositoryRoot} commit --quiet -m base`.quiet();
  return repositoryRoot;
}

async function stashList(repositoryRoot: string): Promise<string> {
  return $`git -C ${repositoryRoot} stash list --format=%H%x20%gs`.text();
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRepositories].map((repositoryRoot) =>
      rm(repositoryRoot, { recursive: true, force: true }),
    ),
  );
  temporaryRepositories.clear();
});

describe('markdown ratchet stash lifecycle', () => {
  it('returns no stash identity when there are no unstaged changes', async () => {
    const repositoryRoot = await createRepository();
    await expect(createRatchetStash(repositoryRoot)).resolves.toBeUndefined();
    expect(await stashList(repositoryRoot)).toBe('');
  });

  it('leaves no stash entry after a passing operation', async () => {
    const repositoryRoot = await createRepository();
    await Bun.write(join(repositoryRoot, 'tracked.txt'), 'base\nunstaged\n');
    const before = await stashList(repositoryRoot);

    await withRatchetStash(repositoryRoot, async () => {
      expect(await Bun.file(join(repositoryRoot, 'tracked.txt')).text()).toBe('base\n');
    });

    expect(await Bun.file(join(repositoryRoot, 'tracked.txt')).text()).toBe('base\nunstaged\n');
    expect(await stashList(repositoryRoot)).toBe(before);
  });

  it('leaves no stash entry after a failing operation', async () => {
    const repositoryRoot = await createRepository();
    await Bun.write(join(repositoryRoot, 'tracked.txt'), 'base\nunstaged\n');
    const before = await stashList(repositoryRoot);

    await expect(
      withRatchetStash(repositoryRoot, async () => {
        throw new Error('ratchet failed');
      }),
    ).rejects.toThrow('ratchet failed');

    expect(await Bun.file(join(repositoryRoot, 'tracked.txt')).text()).toBe('base\nunstaged\n');
    expect(await stashList(repositoryRoot)).toBe(before);
  });

  it('restores and drops its own SHA when another stash becomes the stack head', async () => {
    const repositoryRoot = await createRepository();
    await Bun.write(join(repositoryRoot, 'tracked.txt'), 'base\nratchet change\n');
    const ratchetStash = await createRatchetStash(repositoryRoot);
    expect(ratchetStash).toBeDefined();
    if (ratchetStash === undefined) throw new Error('Expected a ratchet stash');

    await Bun.write(join(repositoryRoot, 'concurrent.txt'), 'other work\n');
    await $`git -C ${repositoryRoot} stash push -u -m concurrent-session`.quiet();

    await restoreRatchetStash(repositoryRoot, ratchetStash);

    expect(await Bun.file(join(repositoryRoot, 'tracked.txt')).text()).toBe(
      'base\nratchet change\n',
    );
    expect(await Bun.file(join(repositoryRoot, 'concurrent.txt')).exists()).toBe(false);
    const remaining = await stashList(repositoryRoot);
    expect(remaining).toContain('concurrent-session');
    expect(remaining).not.toContain(RATCHET_STASH_MESSAGE);
  });

  for (const [signal, expectedExitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    it(`restores and drops its own stash before exiting on ${signal}`, async () => {
      const repositoryRoot = await createRepository();
      await Bun.write(join(repositoryRoot, 'tracked.txt'), 'base\ninterrupted change\n');
      const fixturePath = join(repositoryRoot, 'interrupt-fixture.ts');
      const preCommitPath = fileURLToPath(new URL('./pre-commit.ts', import.meta.url));
      await Bun.write(
        fixturePath,
        `import { withRatchetStash } from ${JSON.stringify(preCommitPath)};
await withRatchetStash(${JSON.stringify(repositoryRoot)}, async () => {
  process.send?.('ready');
  await new Promise(() => {});
});
`,
      );

      let markReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const subprocess = Bun.spawn(['bun', fixturePath], {
        cwd: repositoryRoot,
        stdout: 'pipe',
        stderr: 'pipe',
        ipc(message) {
          if (message === 'ready') markReady?.();
        },
      });

      // fixed delay: hang guard on the signal-cleanup subprocess
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Interrupt fixture did not become ready')), 2_000),
        ),
      ]);
      subprocess.kill(signal);
      const exitCode = await Promise.race([
        subprocess.exited,
        // fixed delay: hang guard on the signal-cleanup subprocess
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Interrupted fixture did not exit')), 2_000),
        ),
      ]);

      expect(exitCode).toBe(expectedExitCode);
      expect(await Bun.file(join(repositoryRoot, 'tracked.txt')).text()).toBe(
        'base\ninterrupted change\n',
      );
      expect(await stashList(repositoryRoot)).not.toContain(RATCHET_STASH_MESSAGE);
    });
  }
});

describe('hook utilities', () => {
  it('reports CI state, formats messages, and inspects Git changes', async () => {
    const repositoryRoot = await createRepository();
    const originalWorkingDirectory = process.cwd();
    const originalContinuousIntegration = process.env['CI'];
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const logError = spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      process.env['CI'] = 'true';
      expect(isContinuousIntegration()).toBe(true);
      process.env['CI'] = '1';
      expect(isContinuousIntegration()).toBe(true);
      process.env['CI'] = 'false';
      expect(isContinuousIntegration()).toBe(false);

      header('pre-commit checks');
      info('information');
      success('success');
      warning('warning');
      error('error');
      expect(log).toHaveBeenCalledTimes(4);
      expect(logError).toHaveBeenCalledTimes(1);

      process.chdir(repositoryRoot);
      await Bun.write(join(repositoryRoot, 'staged.txt'), 'staged\n');
      await $`git add staged.txt`.quiet();
      expect(await getStagedFiles()).toEqual(['staged.txt']);

      const previousOutput = await $`git rev-parse HEAD`.text();
      const previous = previousOutput.trim();
      await $`git commit --quiet -m staged`.quiet();
      const nextOutput = await $`git rev-parse HEAD`.text();
      const next = nextOutput.trim();
      expect(await fileChangedBetween('staged.txt', previous, next)).toBe(true);
      expect(await fileChangedBetween('tracked.txt', previous, next)).toBe(false);
      await printGitStatistics(previous, next);
    } finally {
      process.chdir(originalWorkingDirectory);
      if (originalContinuousIntegration === undefined) delete process.env['CI'];
      else process.env['CI'] = originalContinuousIntegration;
      log.mockRestore();
      logError.mockRestore();
    }
  });
});
