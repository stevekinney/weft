import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import type { BatchOperation, ConditionalBatchCondition } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serializeCheckpoint } from './checkpoint.ts';
import { Engine } from './engine.ts';
import { CURRENT_CHECKPOINT_SCHEMA_VERSION, type Checkpoint, workflow } from './types.ts';

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

/** Write a fake checkpoint history entry directly to storage. */
async function writeCheckpointHistory(
  storage: MemoryStorage | BunSQLiteStorage,
  workflowId: string,
  step: number,
): Promise<void> {
  const checkpoint: Checkpoint = {
    workflowId,
    step,
    locals: { counter: step },
    accumulatedResults: [],
    searchAttributes: {},
    version: '1.0.0',
    schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
    createdAt: 1000 + step * 100,
  };
  await storage.put(KEYS.checkpointHistory(workflowId, step), serializeCheckpoint(checkpoint));
}

/** Read the sorted set of steps still present in checkpoint history for a workflow. */
async function listHistorySteps(
  storage: MemoryStorage | BunSQLiteStorage,
  workflowId: string,
): Promise<number[]> {
  const prefix = `${KEYS.checkpoint(workflowId)}:`;
  const steps: number[] = [];
  for await (const [key] of storage.scan(prefix)) {
    steps.push(Number.parseInt(key.slice(prefix.length), 10));
  }
  return steps.toSorted((a, b) => a - b);
}

class FailingMemoryStorage extends MemoryStorage {
  override async batch(_operations: BatchOperation[]): Promise<void> {
    throw new Error('storage refused the prune batch');
  }
  override async conditionalBatch(
    _conditions: ConditionalBatchCondition[],
    _operations: BatchOperation[],
  ): Promise<boolean> {
    throw new Error('storage refused the prune batch');
  }
}

class FailingBunSQLiteStorage extends BunSQLiteStorage {
  override async batch(_operations: BatchOperation[]): Promise<void> {
    throw new Error('storage refused the prune batch');
  }
  override async conditionalBatch(
    _conditions: ConditionalBatchCondition[],
    _operations: BatchOperation[],
  ): Promise<boolean> {
    throw new Error('storage refused the prune batch');
  }
}

/**
 * Simulates a concurrent `onTerminalConflict: 'start-new'` run replacement
 * landing between `pruneCheckpoints()`'s anchor read of the live checkpoint
 * and its destructive batch: the first `get()` of `targetKey` (the anchor
 * read) is answered honestly, then the stored value is overwritten in place
 * before the read even returns, standing in for the replacement's own write.
 */
class ReplacementRaceMemoryStorage extends MemoryStorage {
  #targetKey: string;
  #triggered = false;
  constructor(targetKey: string) {
    super();
    this.#targetKey = targetKey;
  }
  override async get(key: string): Promise<Uint8Array | null> {
    const value = await super.get(key);
    if (key === this.#targetKey && !this.#triggered) {
      this.#triggered = true;
      await super.put(this.#targetKey, new Uint8Array([9, 9, 9]));
    }
    return value;
  }
}

class ReplacementRaceBunSQLiteStorage extends BunSQLiteStorage {
  #targetKey: string;
  #triggered = false;
  constructor(targetKey: string) {
    super(':memory:');
    this.#targetKey = targetKey;
  }
  override async get(key: string): Promise<Uint8Array | null> {
    const value = await super.get(key);
    if (key === this.#targetKey && !this.#triggered) {
      this.#triggered = true;
      await super.put(this.#targetKey, new Uint8Array([9, 9, 9]));
    }
    return value;
  }
}

const adapters = [
  { name: 'MemoryStorage', create: () => new MemoryStorage() },
  { name: 'BunSQLiteStorage', create: () => new BunSQLiteStorage(':memory:') },
] as const;

describe('Engine.pruneCheckpoints', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  for (const { name, create } of adapters) {
    describe(name, () => {
      it('keeps only the newest keepLast checkpoint history entries', async () => {
        const storage = create();
        for (const step of [1, 2, 3, 4, 5]) {
          await writeCheckpointHistory(storage, 'wf-1', step);
        }

        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'noop' }).execute(async function* () {
            return null;
          }),
        );

        const result = await engine.pruneCheckpoints('wf-1', { keepLast: 2 });
        expect(result).toEqual({ removed: 3, retained: 2 });
        expect(await listHistorySteps(storage, 'wf-1')).toEqual([4, 5]);
      });

      it('deletes every history entry when keepLast is 0', async () => {
        const storage = create();
        for (const step of [1, 2, 3]) {
          await writeCheckpointHistory(storage, 'wf-1', step);
        }

        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'noop' }).execute(async function* () {
            return null;
          }),
        );

        const result = await engine.pruneCheckpoints('wf-1', { keepLast: 0 });
        expect(result).toEqual({ removed: 3, retained: 0 });
        expect(await listHistorySteps(storage, 'wf-1')).toEqual([]);
      });

      it('is a no-op when keepLast is at least the entry count', async () => {
        const storage = create();
        for (const step of [1, 2]) {
          await writeCheckpointHistory(storage, 'wf-1', step);
        }

        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'noop' }).execute(async function* () {
            return null;
          }),
        );

        const result = await engine.pruneCheckpoints('wf-1', { keepLast: 5 });
        expect(result).toEqual({ removed: 0, retained: 2 });
        expect(await listHistorySteps(storage, 'wf-1')).toEqual([1, 2]);
      });

      it('never deletes the live checkpoint key', async () => {
        const storage = create();
        for (const step of [1, 2, 3]) {
          await writeCheckpointHistory(storage, 'wf-1', step);
        }
        await storage.put(KEYS.checkpoint('wf-1'), new Uint8Array([1, 2, 3]));

        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'noop' }).execute(async function* () {
            return null;
          }),
        );

        await engine.pruneCheckpoints('wf-1', { keepLast: 1 });
        expect(await storage.get(KEYS.checkpoint('wf-1'))).not.toBeNull();
      });

      it('is a no-op that never throws on an unknown workflow', async () => {
        const storage = create();
        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'noop' }).execute(async function* () {
            return null;
          }),
        );

        const result = await engine.pruneCheckpoints('nonexistent', { keepLast: 5 });
        expect(result).toEqual({ removed: 0, retained: 0 });
      });

      it('rejects with the storage adapter error when the prune batch fails', async () => {
        const storage =
          name === 'MemoryStorage'
            ? new FailingMemoryStorage()
            : new FailingBunSQLiteStorage(':memory:');
        for (const step of [1, 2, 3]) {
          await writeCheckpointHistory(storage, 'wf-1', step);
        }

        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'noop' }).execute(async function* () {
            return null;
          }),
        );

        await expect(engine.pruneCheckpoints('wf-1', { keepLast: 1 })).rejects.toThrow(
          'storage refused the prune batch',
        );
        // The rejected batch never committed — all three entries remain.
        expect(await listHistorySteps(storage, 'wf-1')).toEqual([1, 2, 3]);
      });

      it('fences the destructive batch against a concurrent run replacement', async () => {
        const liveCheckpointKey = KEYS.checkpoint('wf-1');
        const storage =
          name === 'MemoryStorage'
            ? new ReplacementRaceMemoryStorage(liveCheckpointKey)
            : new ReplacementRaceBunSQLiteStorage(liveCheckpointKey);
        for (const step of [1, 2, 3]) {
          await writeCheckpointHistory(storage, 'wf-1', step);
        }
        await storage.put(liveCheckpointKey, new Uint8Array([1, 2, 3]));

        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'noop' }).execute(async function* () {
            return null;
          }),
        );

        await expect(engine.pruneCheckpoints('wf-1', { keepLast: 1 })).rejects.toThrow(
          'lost its CAS race',
        );
        // The replacement's rewritten checkpoint bytes failed the fence before
        // any history entry was deleted.
        expect(await listHistorySteps(storage, 'wf-1')).toEqual([1, 2, 3]);
        expect(await storage.get(liveCheckpointKey)).toEqual(new Uint8Array([9, 9, 9]));
      });

      it('rejects and deletes nothing when the signal is already aborted', async () => {
        const storage = create();
        for (const step of [1, 2, 3]) {
          await writeCheckpointHistory(storage, 'wf-1', step);
        }

        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'noop' }).execute(async function* () {
            return null;
          }),
        );

        const controller = new AbortController();
        controller.abort();

        await expect(
          engine.pruneCheckpoints('wf-1', { keepLast: 1, signal: controller.signal }),
        ).rejects.toThrow();
        expect(await listHistorySteps(storage, 'wf-1')).toEqual([1, 2, 3]);
      });

      it('is safe to call on a terminal (completed) workflow', async () => {
        const storage = create();
        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'multi-step' }).execute(async function* (ctx) {
            for (let i = 0; i < 5; i++) {
              yield* ctx.run(async () => null);
            }
            return 'done';
          }),
        );

        const handle = await engine.start('multi-step', null);
        await handle.result();
        await flush();

        const result = await engine.pruneCheckpoints(handle.id, { keepLast: 2 });
        expect(result.retained).toBe(2);
        expect(await listHistorySteps(storage, handle.id)).toHaveLength(2);
      });
    });
  }

  it('rejects synchronously for an invalid keepLast option', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'noop' }).execute(async function* () {
        return null;
      }),
    );

    await expect(engine.pruneCheckpoints('wf-1', { keepLast: -1 })).rejects.toThrow(
      'keepLast must be a non-negative integer',
    );
    await expect(engine.pruneCheckpoints('wf-1', { keepLast: 1.5 })).rejects.toThrow(
      'keepLast must be a non-negative integer',
    );
  });
});
