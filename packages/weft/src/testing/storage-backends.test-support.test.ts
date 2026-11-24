import { afterEach, describe, expect, it, mock } from 'bun:test';

import { restoreRealTimers, useFakeTimers } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import {
  flush,
  storageBackends,
  teardown,
  waitForWorkflowStatus,
} from './storage-backends.test-support.ts';

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

    expect(await waitForWorkflowStatus(engine as never, 'workflow-1', 'completed')).toBeUndefined();
  });

  it('throws when the workflow never reaches the requested status before timeout', async () => {
    const engine = {
      get: mock(async () => ({ status: 'running' })),
    };

    expect(
      await throwingRejectionOf(
        // hang-guard-self-test: the workflow stays running, so no load can make it reach completed
        waitForWorkflowStatus(engine as never, 'workflow-1', 'completed', {
          hangGuardMilliseconds: 20,
        }),
      ),
    ).toThrow('Expected workflow "workflow-1" to reach status "completed"');
  });
});

describe('storageBackends', () => {
  it('holds the three adapters Weft depends on at runtime, in order', () => {
    expect(storageBackends.map((backend) => backend.name)).toEqual([
      'MemoryStorage',
      'BunSQLiteStorage',
      'IndexedDBStorage',
    ]);
  });

  it('builds a fresh storage for each backend and cleans it up', async () => {
    for (const backend of storageBackends) {
      const { storage, cleanup } = backend.factory();
      try {
        await storage.put('probe', new Uint8Array([1]));
        expect(await storage.get('probe')).toEqual(new Uint8Array([1]));
      } finally {
        await cleanup();
      }
    }
  });
});

describe('storage backend testing helpers', () => {
  it('flush resolves without throwing', async () => {
    expect(await flush()).toBeUndefined();
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

    expect(await teardown({ [Symbol.dispose]: dispose } as never, storageCleanup)).toBeUndefined();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(storageCleanup).toHaveBeenCalledTimes(1);
  });
});
