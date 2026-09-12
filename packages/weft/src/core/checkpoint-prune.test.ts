import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import type { BatchOperation, ConditionalBatchCondition } from '../storage/interface.ts';
import { KEYS, MAX_BATCH_OPERATIONS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serializeCheckpoint } from './checkpoint.ts';
import { Engine } from './engine.ts';
import { CURRENT_CHECKPOINT_SCHEMA_VERSION, type Checkpoint, workflow } from './types.ts';

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

/** Build serialized checkpoint bytes with a given `workflowExecutionToken`. */
function buildCheckpointBytes(
  workflowId: string,
  step: number,
  overrides?: Partial<Checkpoint>,
): Uint8Array {
  const checkpoint: Checkpoint = {
    workflowId,
    step,
    locals: overrides?.locals ?? { counter: step },
    accumulatedResults: overrides?.accumulatedResults ?? [],
    searchAttributes: overrides?.searchAttributes ?? {},
    version: overrides?.version ?? '1.0.0',
    schemaVersion: overrides?.schemaVersion ?? CURRENT_CHECKPOINT_SCHEMA_VERSION,
    createdAt: overrides?.createdAt ?? 1000 + step * 100,
    ...(overrides?.workflowExecutionToken !== undefined
      ? { workflowExecutionToken: overrides.workflowExecutionToken }
      : {}),
  };
  return serializeCheckpoint(checkpoint);
}

/** Write a fake checkpoint history entry directly to storage. */
async function writeCheckpointHistory(
  storage: MemoryStorage | BunSQLiteStorage,
  workflowId: string,
  step: number,
): Promise<void> {
  await storage.put(
    KEYS.checkpointHistory(workflowId, step),
    buildCheckpointBytes(workflowId, step),
  );
}

/** Write the live checkpoint record directly to storage, with a given execution token. */
async function writeLiveCheckpoint(
  storage: MemoryStorage | BunSQLiteStorage,
  workflowId: string,
  step: number,
  workflowExecutionToken: string,
): Promise<void> {
  await storage.put(
    KEYS.checkpoint(workflowId),
    buildCheckpointBytes(workflowId, step, { workflowExecutionToken }),
  );
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
 * Simulates a concurrent `onTerminalConflict: 'start-new'` run replacement:
 * the first `get()` of `targetKey` (the pre-scan fence anchor read) is
 * answered honestly with the ORIGINAL run's checkpoint, then the stored
 * value is overwritten in place with a DIFFERENT execution's checkpoint
 * (a different `workflowExecutionToken`) before the read even returns,
 * standing in for the replacement's own write landing immediately after.
 */
class ReplacementRaceMemoryStorage extends MemoryStorage {
  #targetKey: string;
  #replacementBytes: Uint8Array;
  #triggered = false;
  constructor(targetKey: string, replacementBytes: Uint8Array) {
    super();
    this.#targetKey = targetKey;
    this.#replacementBytes = replacementBytes;
  }
  override async get(key: string): Promise<Uint8Array | null> {
    const value = await super.get(key);
    if (key === this.#targetKey && !this.#triggered) {
      this.#triggered = true;
      await super.put(this.#targetKey, this.#replacementBytes);
    }
    return value;
  }
}

class ReplacementRaceBunSQLiteStorage extends BunSQLiteStorage {
  #targetKey: string;
  #replacementBytes: Uint8Array;
  #triggered = false;
  constructor(targetKey: string, replacementBytes: Uint8Array) {
    super(':memory:');
    this.#targetKey = targetKey;
    this.#replacementBytes = replacementBytes;
  }
  override async get(key: string): Promise<Uint8Array | null> {
    const value = await super.get(key);
    if (key === this.#targetKey && !this.#triggered) {
      this.#triggered = true;
      await super.put(this.#targetKey, this.#replacementBytes);
    }
    return value;
  }
}

/**
 * Simulates a replacement landing strictly AFTER the fence anchor is
 * captured but WHILE the history scan is still enumerating — the specific
 * gap a pre-fix ordering (anchor read after the scan) left open, since that
 * ordering would capture the replacement's own bytes as the anchor instead
 * of failing against them.
 */
class ReplacementDuringScanMemoryStorage extends MemoryStorage {
  #targetKey: string;
  #replacementBytes: Uint8Array;
  #triggered = false;
  constructor(targetKey: string, replacementBytes: Uint8Array) {
    super();
    this.#targetKey = targetKey;
    this.#replacementBytes = replacementBytes;
  }
  override async *keys(prefix: string, options?: Parameters<MemoryStorage['keys']>[1]) {
    if (!this.#triggered) {
      this.#triggered = true;
      await this.put(this.#targetKey, this.#replacementBytes);
    }
    yield* super.keys(prefix, options);
  }
}

/**
 * Simulates ORDINARY progress on the SAME execution — an unrelated
 * checkpoint commit advancing `step`/`locals` while `workflowExecutionToken`
 * stays unchanged — landing between the fence anchor read and the delete
 * phase's re-read. This must NOT be treated as a replacement.
 */
class OrdinaryProgressMemoryStorage extends MemoryStorage {
  #targetKey: string;
  #advancedBytes: Uint8Array;
  #triggered = false;
  constructor(targetKey: string, advancedBytes: Uint8Array) {
    super();
    this.#targetKey = targetKey;
    this.#advancedBytes = advancedBytes;
  }
  override async get(key: string): Promise<Uint8Array | null> {
    const value = await super.get(key);
    if (key === this.#targetKey && !this.#triggered) {
      this.#triggered = true;
      await super.put(this.#targetKey, this.#advancedBytes);
    }
    return value;
  }
}

/**
 * Adds a checkpoint history entry after pruning has taken its key snapshot,
 * proving that `retained` describes the snapshot rather than a live count.
 */
class ConcurrentHistoryWriteMemoryStorage extends MemoryStorage {
  #historyPrefix: string;
  #historyKey: string;
  #historyBytes: Uint8Array;
  #liveKey: string;
  #liveBytes: Uint8Array;
  #triggered = false;

  constructor(
    historyPrefix: string,
    historyKey: string,
    historyBytes: Uint8Array,
    liveKey: string,
    liveBytes: Uint8Array,
  ) {
    super();
    this.#historyPrefix = historyPrefix;
    this.#historyKey = historyKey;
    this.#historyBytes = historyBytes;
    this.#liveKey = liveKey;
    this.#liveBytes = liveBytes;
  }

  override async *keys(prefix: string, options?: Parameters<MemoryStorage['keys']>[1]) {
    for await (const key of super.keys(prefix, options)) {
      yield key;
      if (prefix === this.#historyPrefix && !this.#triggered) {
        this.#triggered = true;
        await this.put(this.#historyKey, this.#historyBytes);
        await this.put(this.#liveKey, this.#liveBytes);
      }
    }
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
        await writeLiveCheckpoint(storage, 'wf-1', 3, 'token-a');

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

      it("rejects a concurrent run replacement instead of deleting the new run's history", async () => {
        const liveCheckpointKey = KEYS.checkpoint('wf-1');
        const replacementBytes = buildCheckpointBytes('wf-1', 1, {
          workflowExecutionToken: 'token-b',
        });
        const storage =
          name === 'MemoryStorage'
            ? new ReplacementRaceMemoryStorage(liveCheckpointKey, replacementBytes)
            : new ReplacementRaceBunSQLiteStorage(liveCheckpointKey, replacementBytes);
        for (const step of [1, 2, 3]) {
          await writeCheckpointHistory(storage, 'wf-1', step);
        }
        await writeLiveCheckpoint(storage, 'wf-1', 3, 'token-a');

        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'noop' }).execute(async function* () {
            return null;
          }),
        );

        await expect(engine.pruneCheckpoints('wf-1', { keepLast: 1 })).rejects.toThrow(
          'lost its race against a concurrent run replacement',
        );
        // The replacement's different execution token failed the guard before
        // any history entry was deleted.
        expect(await listHistorySteps(storage, 'wf-1')).toEqual([1, 2, 3]);
        expect(await storage.get(liveCheckpointKey)).toEqual(replacementBytes);
      });

      it('does not spuriously fail when the SAME run advances between the anchor read and delete', async () => {
        const liveCheckpointKey = KEYS.checkpoint('wf-1');
        const advancedBytes = buildCheckpointBytes('wf-1', 7, {
          workflowExecutionToken: 'token-a',
        });
        const storage = new OrdinaryProgressMemoryStorage(liveCheckpointKey, advancedBytes);
        for (const step of [1, 2, 3]) {
          await writeCheckpointHistory(storage, 'wf-1', step);
        }
        await writeLiveCheckpoint(storage, 'wf-1', 3, 'token-a');

        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'noop' }).execute(async function* () {
            return null;
          }),
        );

        // An ordinary commit on the SAME execution (same token) landed between
        // the anchor read and the delete phase — this is not a replacement, so
        // the prune must still succeed rather than rejecting.
        const result = await engine.pruneCheckpoints('wf-1', { keepLast: 1 });
        expect(result).toEqual({ removed: 2, retained: 1 });
        expect(await listHistorySteps(storage, 'wf-1')).toEqual([3]);
        expect(await storage.get(liveCheckpointKey)).toEqual(advancedBytes);
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

      it('is safe to call while the workflow is still running (active execution)', async () => {
        const storage = create();
        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register(
          workflow({ name: 'steps-then-wait' }).execute(async function* (ctx) {
            for (let i = 0; i < 5; i++) {
              yield* ctx.run(async () => null);
            }
            yield* ctx.waitForSignal('done');
            return 'ok';
          }),
        );

        const handle = await engine.start('steps-then-wait', null);
        await flush();

        // The workflow is still alive (parked on a signal) — its live
        // checkpoint keeps advancing on every commit, yet pruning its
        // history must not spuriously reject.
        const result = await engine.pruneCheckpoints(handle.id, { keepLast: 2 });
        expect(result.retained).toBe(2);
        expect(await listHistorySteps(storage, handle.id)).toHaveLength(2);
      });
    });
  }

  it('reports retained entries from the scan snapshot when a checkpoint is written concurrently', async () => {
    const liveCheckpointKey = KEYS.checkpoint('wf-1');
    const historyPrefix = `${liveCheckpointKey}:`;
    const storage = new ConcurrentHistoryWriteMemoryStorage(
      historyPrefix,
      KEYS.checkpointHistory('wf-1', 4),
      buildCheckpointBytes('wf-1', 4, { workflowExecutionToken: 'token-a' }),
      liveCheckpointKey,
      buildCheckpointBytes('wf-1', 4, { workflowExecutionToken: 'token-a' }),
    );
    for (const step of [1, 2, 3]) {
      await writeCheckpointHistory(storage, 'wf-1', step);
    }
    await writeLiveCheckpoint(storage, 'wf-1', 3, 'token-a');

    engine = new Engine({ storage, checkpointHistory: 10 });
    engine.register(
      workflow({ name: 'noop' }).execute(async function* () {
        return null;
      }),
    );

    const result = await engine.pruneCheckpoints('wf-1', { keepLast: 1 });

    // The scan saw three entries and planned to retain one. The concurrent
    // checkpoint write landed after that snapshot and remains in storage.
    expect(result).toEqual({ removed: 2, retained: 1 });
    expect(await listHistorySteps(storage, 'wf-1')).toEqual([3, 4]);
  });

  it('fences against a replacement landing during the history scan itself', async () => {
    const liveCheckpointKey = KEYS.checkpoint('wf-1');
    const replacementBytes = buildCheckpointBytes('wf-1', 1, { workflowExecutionToken: 'token-b' });
    const storage = new ReplacementDuringScanMemoryStorage(liveCheckpointKey, replacementBytes);
    for (const step of [1, 2, 3]) {
      await writeCheckpointHistory(storage, 'wf-1', step);
    }
    await writeLiveCheckpoint(storage, 'wf-1', 3, 'token-a');

    engine = new Engine({ storage, checkpointHistory: 10 });
    engine.register(
      workflow({ name: 'noop' }).execute(async function* () {
        return null;
      }),
    );

    // The fence anchor is captured before the scan starts, so even though the
    // replacement's rewrite happens mid-scan (not merely after it), the
    // destructive batch still fails closed against the pre-scan token.
    await expect(engine.pruneCheckpoints('wf-1', { keepLast: 1 })).rejects.toThrow(
      'lost its race against a concurrent run replacement',
    );
    expect(await listHistorySteps(storage, 'wf-1')).toEqual([1, 2, 3]);
    expect(await storage.get(liveCheckpointKey)).toEqual(replacementBytes);
  });

  for (const replacementBatch of [1, 2]) {
    for (const initialGeneration of [null, new Uint8Array([1])]) {
      it(`fences generation changes at delete batch ${replacementBatch} with ${initialGeneration === null ? 'absent' : 'present'} anchor`, async () => {
        const generationKey = KEYS.workflowGeneration('wf-1');
        let deleteBatches = 0;
        class ReplacementAtCommitStorage extends MemoryStorage {
          override async conditionalBatch(
            conditions: ConditionalBatchCondition[],
            operations: BatchOperation[],
          ): Promise<boolean> {
            if (
              operations.some(
                (operation) =>
                  operation.type === 'delete' &&
                  operation.key.startsWith(`${KEYS.checkpoint('wf-1')}:`),
              )
            ) {
              deleteBatches++;
              if (deleteBatches === replacementBatch) {
                await this.put(generationKey, new Uint8Array([2]));
                for (let step = 1; step <= MAX_BATCH_OPERATIONS + 1; step++) {
                  await writeCheckpointHistory(this, 'wf-1', step);
                }
              }
            }
            return super.conditionalBatch(conditions, operations);
          }
        }
        const storage = new ReplacementAtCommitStorage();
        if (initialGeneration !== null) await storage.put(generationKey, initialGeneration);
        for (let step = 1; step <= MAX_BATCH_OPERATIONS + 1; step++) {
          await writeCheckpointHistory(storage, 'wf-1', step);
        }
        engine = new Engine({ storage });
        await expect(engine.pruneCheckpoints('wf-1', { keepLast: 0 })).rejects.toThrow(
          'lost its CAS race',
        );
        expect(deleteBatches).toBe(replacementBatch);
        expect(await listHistorySteps(storage, 'wf-1')).toHaveLength(MAX_BATCH_OPERATIONS + 1);
      });
    }
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
