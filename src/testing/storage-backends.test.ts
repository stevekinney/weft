import { afterEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { restoreRealTimers, useFakeTimers } from './fake-timers.ts';
import {
  createDiskBackedTestFixture,
  flush,
  sqliteDatabaseSidecarSuffixes,
  teardown,
  waitForWorkflowStatus,
} from './storage-backends.ts';

afterEach(() => {
  restoreRealTimers();
});

describe('waitForWorkflowStatus', () => {
  it('returns once the workflow reaches the requested status', async () => {
    let reads = 0;
    const engine = {
      get: mock(async () => {
        reads += 1;
        return { status: reads > 1 ? 'completed' : 'running' };
      }),
    };

    await expect(
      waitForWorkflowStatus(engine as never, 'workflow-1', 'completed', 500),
    ).resolves.toBeUndefined();
  });

  it('throws when the workflow never reaches the requested status before timeout', async () => {
    const engine = {
      get: mock(async () => ({ status: 'running' })),
    };

    await expect(
      waitForWorkflowStatus(engine as never, 'workflow-1', 'completed', 20),
    ).rejects.toThrow('Expected workflow "workflow-1" to reach status "completed"');
  });
});

describe('storage backend testing helpers', () => {
  it('cleans up SQLite fixture files and sidecars', async () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'weft-storage-helper-sqlite',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });

    await Bun.write(fixture.path, 'database');
    await Bun.write(`${fixture.path}-wal`, 'wal');
    await Bun.write(`${fixture.path}-shm`, 'shm');

    await fixture.cleanup();

    expect(existsSync(fixture.path)).toBe(false);
    expect(existsSync(`${fixture.path}-wal`)).toBe(false);
    expect(existsSync(`${fixture.path}-shm`)).toBe(false);
  });

  it('cleans up recursive LMDB fixture directories', async () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'weft-storage-helper-lmdb',
      recursive: true,
    });
    const nestedDirectory = join(fixture.path, 'data.mdb');

    mkdirSync(nestedDirectory, { recursive: true });
    await Bun.write(join(nestedDirectory, 'lock'), 'lock');

    await fixture.cleanup();

    expect(existsSync(fixture.path)).toBe(false);
  });

  it('continues best-effort cleanup after a sidecar removal failure', async () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'weft-storage-helper-best-effort',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const nonRecursiveSidecarDirectory = `${fixture.path}-wal`;

    try {
      mkdirSync(nonRecursiveSidecarDirectory, { recursive: true });
      await Bun.write(join(nonRecursiveSidecarDirectory, 'lock'), 'lock');
      await Bun.write(fixture.path, 'database');

      expect(() => fixture.cleanup()).not.toThrow();
      expect(existsSync(fixture.path)).toBe(false);
    } finally {
      rmSync(nonRecursiveSidecarDirectory, { force: true, recursive: true });
      fixture.cleanup();
    }
  });

  it('rejects path-like fixture fragments before cleanup can target them', () => {
    expect(() => createDiskBackedTestFixture({ prefix: '../outside' })).toThrow(
      'Fixture prefix must be a plain filename fragment',
    );

    expect(() =>
      createDiskBackedTestFixture({
        prefix: 'weft-storage-helper',
        suffix: '../outside',
      }),
    ).toThrow('Fixture suffix must be a plain filename fragment');

    expect(() =>
      createDiskBackedTestFixture({
        prefix: 'weft-storage-helper',
        sidecarSuffixes: ['/outside'],
      }),
    ).toThrow('Fixture sidecar suffix must be a plain filename fragment');
  });

  it('flush resolves without throwing', async () => {
    await expect(flush()).resolves.toBeUndefined();
  });

  it('flush advances pending zero-delay timers under fake timers', async () => {
    useFakeTimers();

    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);

    await flush();

    expect(fired).toBe(true);
  });

  it('teardown disposes the engine, flushes, and runs storage cleanup', async () => {
    const dispose = mock(() => {});
    const storageCleanup = mock(() => {});

    await expect(
      teardown({ [Symbol.dispose]: dispose } as never, storageCleanup),
    ).resolves.toBeUndefined();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(storageCleanup).toHaveBeenCalledTimes(1);
  });
});
