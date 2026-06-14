import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serializeCheckpoint } from './checkpoint.ts';
import { Engine } from './engine.ts';
import {
  CURRENT_CHECKPOINT_SCHEMA_VERSION,
  type Checkpoint,
  type CheckpointState,
  type CheckpointSummary,
  type WorkflowContext,
  workflow,
} from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

const noop = async () => null;

/**
 * Build a fake checkpoint and write it to storage at the history key.
 * Returns the serialized bytes so callers can assert on size.
 */
function writeCheckpointHistory(
  storage: MemoryStorage,
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
  };
  const serialized = serializeCheckpoint(checkpoint);
  // synchronously seed storage — MemoryStorage.put returns a resolved promise
  storage.put(KEYS.checkpointHistory(workflowId, step), serialized);
  return serialized;
}

/** Create a multi-step workflow engine that yields N activity steps. */
function createMultiStepEngine(
  storage: MemoryStorage,
  steps: number,
  options?: { checkpointHistory?: number },
): Engine {
  const engine = new Engine({ storage, ...options });

  const multiStepWorkflow = workflow({ name: 'multi-step' }).execute(async function* (
    ctx: WorkflowContext,
  ) {
    for (let i = 0; i < steps; i++) {
      yield* ctx.run(noop);
    }
    return 'done';
  });
  engine.register(multiStepWorkflow);

  return engine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkpoint history', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // listCheckpoints
  // -------------------------------------------------------------------------

  describe('listCheckpoints', () => {
    it('returns empty array when checkpointHistory is 0', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage, checkpointHistory: 0 });
      const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return input;
      });
      engine.register(echoWorkflow);

      const handle = await engine.start('echo', 'hello');
      await handle.result();
      await flush();

      const summaries = await engine.listCheckpoints(handle.id);
      expect(summaries).toEqual([]);
    });

    it('returns checkpoint summaries in reverse step order', async () => {
      const storage = new MemoryStorage();
      writeCheckpointHistory(storage, 'wf-1', 1);
      writeCheckpointHistory(storage, 'wf-1', 2);
      writeCheckpointHistory(storage, 'wf-1', 3);

      engine = new Engine({ storage, checkpointHistory: 10 });
      const noopWorkflow = workflow({ name: 'noop' }).execute(async function* () {
        return null;
      });
      engine.register(noopWorkflow);

      const summaries = await engine.listCheckpoints('wf-1');
      expect(summaries.map((s: CheckpointSummary) => s.step)).toEqual([3, 2, 1]);
    });

    it('returns step, timestamp, and sizeBytes for each entry', async () => {
      const storage = new MemoryStorage();
      const bytes = writeCheckpointHistory(storage, 'wf-1', 5, { createdAt: 9999 });

      engine = new Engine({ storage, checkpointHistory: 10 });
      const noopWorkflow2 = workflow({ name: 'noop' }).execute(async function* () {
        return null;
      });
      engine.register(noopWorkflow2);

      const summaries = await engine.listCheckpoints('wf-1');
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toEqual({
        step: 5,
        timestamp: 9999,
        sizeBytes: bytes.byteLength,
      });
    });

    it('returns empty array for unknown workflow', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage, checkpointHistory: 10 });
      const noopWorkflow3 = workflow({ name: 'noop' }).execute(async function* () {
        return null;
      });
      engine.register(noopWorkflow3);

      const summaries = await engine.listCheckpoints('nonexistent');
      expect(summaries).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getCheckpointAt
  // -------------------------------------------------------------------------

  describe('getCheckpointAt', () => {
    it('returns deserialized state for valid step', async () => {
      const storage = new MemoryStorage();
      writeCheckpointHistory(storage, 'wf-1', 3, {
        locals: { greeting: 'hello' },
        searchAttributes: { tag: 'important' },
        version: '2.0.0',
        createdAt: 5555,
      });

      engine = new Engine({ storage, checkpointHistory: 10 });
      const noopWorkflow4 = workflow({ name: 'noop' }).execute(async function* () {
        return null;
      });
      engine.register(noopWorkflow4);

      const state = await engine.getCheckpointAt('wf-1', 3);
      expect(state).not.toBeNull();
      expect(state).toEqual({
        step: 3,
        locals: { greeting: 'hello' },
        searchAttributes: { tag: 'important' },
        version: '2.0.0',
        createdAt: 5555,
      });
    });

    it('returns null for non-existent step', async () => {
      const storage = new MemoryStorage();
      writeCheckpointHistory(storage, 'wf-1', 1);

      engine = new Engine({ storage, checkpointHistory: 10 });
      const noopWorkflow5 = workflow({ name: 'noop' }).execute(async function* () {
        return null;
      });
      engine.register(noopWorkflow5);

      const state = await engine.getCheckpointAt('wf-1', 99);
      expect(state).toBeNull();
    });

    it('returns null for unknown workflow', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage, checkpointHistory: 10 });
      const noopWorkflow6 = workflow({ name: 'noop' }).execute(async function* () {
        return null;
      });
      engine.register(noopWorkflow6);

      const state = await engine.getCheckpointAt('nonexistent', 1);
      expect(state).toBeNull();
    });

    it('returns locals, searchAttributes, version, createdAt', async () => {
      const storage = new MemoryStorage();
      writeCheckpointHistory(storage, 'wf-1', 7, {
        locals: { a: 1, b: 'two' },
        searchAttributes: { priority: 'high', count: 42 },
        version: '3.1.0',
        createdAt: 12345,
      });

      engine = new Engine({ storage, checkpointHistory: 10 });
      const noopWorkflow7 = workflow({ name: 'noop' }).execute(async function* () {
        return null;
      });
      engine.register(noopWorkflow7);

      const state = (await engine.getCheckpointAt('wf-1', 7)) as CheckpointState;
      expect(state.locals).toEqual({ a: 1, b: 'two' });
      expect(state.searchAttributes).toEqual({ priority: 'high', count: 42 });
      expect(state.version).toBe('3.1.0');
      expect(state.createdAt).toBe(12345);
    });
  });

  // -------------------------------------------------------------------------
  // Pruning
  // -------------------------------------------------------------------------

  describe('pruning', () => {
    it('old checkpoint history entries are pruned beyond the configured limit', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage, checkpointHistory: 3 });

      // Register a workflow that does several steps then blocks on a signal
      const stepsThenWaitWorkflow = workflow({ name: 'steps-then-wait' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        for (let i = 0; i < 6; i++) {
          yield* ctx.run(noop);
        }
        yield* ctx.waitForSignal('done');
        return 'ok';
      });
      engine.register(stepsThenWaitWorkflow);

      const handle = await engine.start('steps-then-wait', null);
      await flush();

      // Workflow is still alive (blocked on signal), so cleanup hasn't run.
      // Scan raw storage to confirm only 3 history entries remain.
      const entries: string[] = [];
      const prefix = `wf:${handle.id}:ckpt:`;
      for await (const [key] of storage.scan(prefix)) {
        entries.push(key);
      }
      expect(entries).toHaveLength(3);

      // The summaries should be the 3 highest steps
      const summaries = await engine.listCheckpoints(handle.id);
      expect(summaries).toHaveLength(3);
      const steps = summaries.map((s: CheckpointSummary) => s.step);
      expect(steps[0]!).toBeGreaterThan(steps[1]!);
      expect(steps[1]!).toBeGreaterThan(steps[2]!);
    });

    it('pruning does not delete the current checkpoint key', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage, checkpointHistory: 2 });

      const stepsThenWaitWorkflow2 = workflow({ name: 'steps-then-wait' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        for (let i = 0; i < 5; i++) {
          yield* ctx.run(noop);
        }
        yield* ctx.waitForSignal('done');
        return 'ok';
      });
      engine.register(stepsThenWaitWorkflow2);

      const handle = await engine.start('steps-then-wait', null);
      await flush();

      // Confirm pruning actually ran — only 2 history entries should remain
      const entries: string[] = [];
      const prefix = `wf:${handle.id}:ckpt:`;
      for await (const [key] of storage.scan(prefix)) {
        entries.push(key);
      }
      expect(entries).toHaveLength(2);

      // The bare checkpoint key (wf:{id}:ckpt) should still exist
      const currentCheckpoint = await storage.get(KEYS.checkpoint(handle.id));
      expect(currentCheckpoint).not.toBeNull();
    });

    it('pruning with checkpointHistory=0 does not write or prune history', async () => {
      const storage = new MemoryStorage();
      engine = createMultiStepEngine(storage, 3, { checkpointHistory: 0 });

      const handle = await engine.start('multi-step', null);
      await handle.result();
      await flush();

      // No history entries should exist
      const entries: string[] = [];
      const prefix = `wf:${handle.id}:ckpt:`;
      for await (const [key] of storage.scan(prefix)) {
        entries.push(key);
      }
      expect(entries).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup on termination
  // -------------------------------------------------------------------------

  describe('retention after workflow termination', () => {
    it('retains checkpoint history entries when workflow completes', async () => {
      const storage = new MemoryStorage();
      engine = createMultiStepEngine(storage, 4, { checkpointHistory: 10 });

      const handle = await engine.start('multi-step', null);
      await handle.result();
      await flush();

      // Completed workflows keep their checkpoint history so replay and
      // time-travel inspection remain available after terminal cleanup.
      const entries: string[] = [];
      const prefix = `wf:${handle.id}:ckpt:`;
      for await (const [key] of storage.scan(prefix)) {
        entries.push(key);
      }
      expect(entries).toHaveLength(4);

      const summaries = await engine.listCheckpoints(handle.id);
      expect(summaries.map((summary: CheckpointSummary) => summary.step)).toEqual([4, 3, 2, 1]);
    });

    it('retains checkpoint history entries when workflow is cancelled', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage, checkpointHistory: 10 });

      const waitForeverWorkflow = workflow({ name: 'wait-forever' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('never-arrives');
        return 'never';
      });
      engine.register(waitForeverWorkflow);

      const handle = await engine.start('wait-forever', null);
      await flush();

      // Cancel and swallow the expected rejection
      const resultPromise = handle.result().catch(() => {});
      await engine.cancel(handle.id);
      await resultPromise;
      await flush();

      // Cancelled workflows keep the last durable checkpoint for inspection.
      const entries: string[] = [];
      const prefix = `wf:${handle.id}:ckpt:`;
      for await (const [key] of storage.scan(prefix)) {
        entries.push(key);
      }
      expect(entries).toHaveLength(1);

      const checkpoint = await engine.getCheckpointAt(handle.id, 1);
      expect(checkpoint).not.toBeNull();
    });
  });
});
