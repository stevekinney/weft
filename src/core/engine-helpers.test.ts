import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  cleanupPartialStreamChunks,
  createCleanupErrorReporter,
  createExpiredResponseCleanupTick,
  createHandleCacheFinalizer,
  executeRunAllBranches,
} from './engine-helpers.ts';

describe('engine helpers', () => {
  it('cleanupPartialStreamChunks deletes chunk keys and stream metadata', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'wf-stream';
    const key = 'stream-key';
    const writtenKeys = ['chunk-1', 'chunk-2'];

    for (const writtenKey of writtenKeys) {
      await storage.put(writtenKey, new Uint8Array([1, 2, 3]));
    }
    await storage.put(KEYS.streamMetadata(workflowId, key), new Uint8Array([4, 5, 6]));

    await cleanupPartialStreamChunks(storage, workflowId, key, writtenKeys, () => {
      throw new Error('cleanup callback should not fire');
    });

    expect(await storage.get('chunk-1')).toBeNull();
    expect(await storage.get('chunk-2')).toBeNull();
    expect(await storage.get(KEYS.streamMetadata(workflowId, key))).toBeNull();
  });

  it('cleanupPartialStreamChunks returns early when there are no written chunk keys', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'wf-stream';
    const key = 'stream-key';

    await storage.put(KEYS.streamMetadata(workflowId, key), new Uint8Array([4, 5, 6]));

    const failures: unknown[] = [];
    await cleanupPartialStreamChunks(storage, workflowId, key, [], (_source, error) => {
      failures.push(error);
    });

    expect(failures).toHaveLength(0);
    expect(await storage.get(KEYS.streamMetadata(workflowId, key))).not.toBeNull();
  });

  it('cleanupPartialStreamChunks reports storage batch failures through the callback', async () => {
    const realStorage = new MemoryStorage();
    const storage: WeftStorage = {
      capabilities: realStorage.capabilities.bind(realStorage),
      get: realStorage.get.bind(realStorage),
      put: realStorage.put.bind(realStorage),
      delete: realStorage.delete.bind(realStorage),
      scan: realStorage.scan.bind(realStorage),
      batch: async () => {
        throw new Error('batch exploded');
      },
      [Symbol.dispose]() {
        realStorage[Symbol.dispose]();
      },
    };

    const failures: Array<{ source: string; error: unknown; workflowId: string }> = [];

    await cleanupPartialStreamChunks(
      storage,
      'wf-stream',
      'stream-key',
      ['chunk-1'],
      (source, error, workflowId) => {
        failures.push({ source, error, workflowId });
      },
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]!.source).toBe('cleanupPartialStreamChunks');
    expect((failures[0]!.error as Error).message).toBe('batch exploded');
    expect(failures[0]!.workflowId).toBe('wf-stream');
  });

  it('createCleanupErrorReporter preserves the workflow identifier', () => {
    const failures: Array<{ source: string; error: unknown; workflowId: string }> = [];

    const report = createCleanupErrorReporter((source, error, workflowId) => {
      failures.push({ source, error, workflowId });
    }, 'wf-123');

    report('cleanupPartialStreamChunks', new Error('cleanup failed'), 'ignored-workflow');

    expect(failures).toHaveLength(1);
    expect(failures[0]!.source).toBe('cleanupPartialStreamChunks');
    expect((failures[0]!.error as Error).message).toBe('cleanup failed');
    expect(failures[0]!.workflowId).toBe('wf-123');
  });

  it('createHandleCacheFinalizer removes only stale workflow handles from the cache', () => {
    const liveHandle = { id: 'live-handle' };
    const staleEntry = { ref: { deref: () => undefined } };
    const liveEntry = { ref: { deref: () => liveHandle } };
    const handleCache = new Map<
      string,
      {
        ref: {
          deref: () => { id: string } | undefined;
        };
      }
    >([
      ['wf-1', staleEntry],
      ['wf-2', liveEntry],
    ]);

    const finalize = createHandleCacheFinalizer(handleCache);
    finalize('wf-1');
    finalize('wf-2');

    expect(handleCache.has('wf-1')).toBe(false);
    expect(handleCache.get('wf-2')).toBe(liveEntry);
  });

  it('createExpiredResponseCleanupTick runs the cleanup cycle', async () => {
    let cleanupCalls = 0;
    const cleanupTick = createExpiredResponseCleanupTick(
      {
        async cleanupExpiredResponses() {
          cleanupCalls++;
          return 0;
        },
      },
      () => {
        throw new Error('cleanup error callback should not fire');
      },
    );

    cleanupTick();
    await sleepForTesting(0);

    expect(cleanupCalls).toBe(1);
  });

  it('createExpiredResponseCleanupTick reports cleanup failures through the callback', async () => {
    const failures: Array<{ source: string; error: unknown }> = [];
    const cleanupTick = createExpiredResponseCleanupTick(
      {
        async cleanupExpiredResponses() {
          throw new Error('cleanup exploded');
        },
      },
      (source, error) => {
        failures.push({ source, error });
      },
    );

    cleanupTick();
    await sleepForTesting(0);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.source).toBe('cleanupExpiredResponses');
    expect((failures[0]!.error as Error).message).toBe('cleanup exploded');
  });

  it('executeRunAllBranches resolves every branch result by name', async () => {
    const results = await executeRunAllBranches(
      {
        alpha: [(value: string) => value.toUpperCase(), 'one'],
        beta: [(count: number) => count * 2, 21],
      },
      async (fn, input) => fn(input),
    );

    expect(results).toEqual({ alpha: 'ONE', beta: 42 });
  });
});
