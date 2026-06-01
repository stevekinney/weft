import { describe, expect, it } from 'bun:test';
import {
  sleepForTesting,
  waitForCondition,
  waitForRealTimersForTesting,
} from '../../testing/fake-timers.test-support.ts';

import type { BatchOperation, ScanOptions } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { workflow, type AttributeFilter, type WorkflowContext } from '../types.ts';

async function waitForWorkflowPresence(
  engine: Engine,
  workflowId: string,
  shouldExist: boolean,
): Promise<void> {
  await waitForCondition(
    async () => {
      const exists = (await engine.get(workflowId)) !== null;
      return exists === shouldExist;
    },
    {
      label: `workflow "${workflowId}" existence to become ${String(shouldExist)}`,
      timeoutMs: 400,
      intervalMs: 5,
    },
  );
}

class RecordingMemoryStorage extends MemoryStorage {
  readonly batchCalls: BatchOperation[][] = [];

  override async batch(operations: BatchOperation[]): Promise<void> {
    this.batchCalls.push([...operations]);
    await super.batch(operations);
  }
}

class OverlapTrackingMemoryStorage extends MemoryStorage {
  readonly delayMs: number;

  shouldTrackPurgeBatches = false;
  activePurgeBatches = 0;
  maxConcurrentPurgeBatches = 0;

  constructor(delayMs: number) {
    super();
    this.delayMs = delayMs;
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    const isTrackedPurgeBatch =
      this.shouldTrackPurgeBatches &&
      operations.some(
        (operation) =>
          operation.type === 'delete' &&
          operation.key.startsWith('wf:') &&
          !operation.key.slice('wf:'.length).includes(':'),
      );

    if (!isTrackedPurgeBatch) {
      await super.batch(operations);
      return;
    }

    this.activePurgeBatches++;
    this.maxConcurrentPurgeBatches = Math.max(
      this.maxConcurrentPurgeBatches,
      this.activePurgeBatches,
    );

    try {
      await waitForRealTimersForTesting(this.delayMs);
      await super.batch(operations);
    } finally {
      this.activePurgeBatches--;
    }
  }
}

class CountingWorkflowStateScanStorage extends MemoryStorage {
  topLevelWorkflowStateEntriesSeen = 0;
  terminalWorkflowIndexEntriesSeen = 0;

  override async *scan(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<[string, Uint8Array]> {
    for await (const entry of super.scan(prefix, options)) {
      const [key] = entry;
      if (prefix === 'wf:' && !key.slice(3).includes(':')) {
        this.topLevelWorkflowStateEntriesSeen += 1;
      }
      if (prefix === KEYS.terminalWorkflowPrefix()) {
        this.terminalWorkflowIndexEntriesSeen += 1;
      }
      yield entry;
    }
  }

  resetTopLevelWorkflowStateEntriesSeen(): void {
    this.topLevelWorkflowStateEntriesSeen = 0;
    this.terminalWorkflowIndexEntriesSeen = 0;
  }
}

async function collectKeys(storage: MemoryStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storage.keys ? storage.keys(prefix) : collectScanKeys(storage, prefix)) {
    keys.push(key);
  }
  return keys;
}

async function* collectScanKeys(storage: MemoryStorage, prefix: string): AsyncGenerator<string> {
  for await (const [key] of storage.scan(prefix)) {
    yield key;
  }
}

async function createCompletedWorkflow(
  engine: Engine,
  workflowType: string,
  workflowId: string,
): Promise<void> {
  const handle = await engine.start(workflowType, null, { id: workflowId });
  await handle.result();
}

async function waitForRunningWorkflow(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      return state?.status === 'running';
    },
    { label: `workflow "${workflowId}" to reach running state`, timeoutMs: 400, intervalMs: 5 },
  );
}

describe('workflow retention', () => {
  it('Acceptance criteria: EngineOptions.retention cleans up completed, failed, cancelled, and timed-out workflows after updatedAt + TTL', async () => {
    let now = 1_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: {
        completed: '5s',
        failed: '5s',
        cancelled: '5s',
        timedOut: '5s',
      },
      retentionSweepInterval: '10ms',
    });

    engine.register(
      workflow({ name: 'retention-completed' }).execute(async function* () {
        return 'done';
      }),
    );
    engine.register(
      workflow({ name: 'retention-failed' }).execute(async function* () {
        throw new Error('boom');
      }),
    );
    engine.register(
      workflow({ name: 'retention-blocked' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('continue');
        return 'done';
      }),
    );

    const completedHandle = await engine.start('retention-completed', null, {
      id: 'retention-completed',
    });
    await completedHandle.result();

    const failedHandle = await engine.start('retention-failed', null, {
      id: 'retention-failed',
    });
    await failedHandle.result().catch(() => {});

    const cancelledHandle = await engine.start('retention-blocked', null, {
      id: 'retention-cancelled',
    });
    await waitForRunningWorkflow(engine, cancelledHandle.id);
    await engine.cancel(cancelledHandle.id);
    await cancelledHandle.result().catch(() => {});

    const timedOutHandle = await engine.start('retention-blocked', null, {
      id: 'retention-timed-out',
    });
    await waitForRunningWorkflow(engine, timedOutHandle.id);
    await engine.timeout(timedOutHandle.id);
    await timedOutHandle.result().catch(() => {});

    expect(await engine.get(completedHandle.id)).not.toBeNull();
    expect(await engine.get(failedHandle.id)).not.toBeNull();
    expect(await engine.get(cancelledHandle.id)).not.toBeNull();
    expect(await engine.get(timedOutHandle.id)).not.toBeNull();

    now += 5_001;

    await Promise.all([
      waitForWorkflowPresence(engine, completedHandle.id, false),
      waitForWorkflowPresence(engine, failedHandle.id, false),
      waitForWorkflowPresence(engine, cancelledHandle.id, false),
      waitForWorkflowPresence(engine, timedOutHandle.id, false),
    ]);

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: the default retention policy keeps terminal workflows until cleanup is explicitly configured', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
    });

    engine.register(
      workflow({ name: 'retention-default' }).execute(async function* () {
        return 'done';
      }),
    );

    const handle = await engine.start('retention-default', null, {
      id: 'retention-default',
    });
    await handle.result();

    const overview = engine.getRetentionOverview();
    expect(overview.defaultRetention).toBeNull();
    expect(overview.nextSweepAt).toBeNull();

    await sleepForTesting(50);
    expect(await engine.get(handle.id)).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: retention sweep uses a configurable interval and processes a configurable batch size', async () => {
    let now = 10_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: {
        completed: 0,
      },
      retentionSweepInterval: '50ms',
      retentionSweepBatchSize: 1,
    });

    engine.register(
      workflow({ name: 'retention-batched' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return input;
      }),
    );

    const first = await engine.start('retention-batched', 'a', { id: 'batched-a' });
    const second = await engine.start('retention-batched', 'b', { id: 'batched-b' });
    await Promise.all([first.result(), second.result()]);

    await waitForCondition(
      async () => {
        const states = await Promise.all([engine.get(first.id), engine.get(second.id)]);
        return states.filter((state) => state !== null).length === 1;
      },
      {
        label: 'first retention sweep to delete exactly one workflow',
        timeoutMs: 400,
        intervalMs: 5,
      },
    );

    await waitForCondition(
      async () => {
        const states = await Promise.all([engine.get(first.id), engine.get(second.id)]);
        return states.every((state) => state === null);
      },
      {
        label: 'second retention sweep to delete the remaining workflow',
        timeoutMs: 400,
        intervalMs: 5,
      },
    );

    engine[Symbol.dispose]();
  });

  it('retention sweep skips overlapping ticks while a previous purge batch is still running', async () => {
    const storage = new OverlapTrackingMemoryStorage(30);
    const engine = new Engine({
      storage,
      retention: {
        completed: 0,
      },
      retentionSweepInterval: '20ms',
      retentionSweepBatchSize: 1,
    });

    engine.register(
      workflow({ name: 'retention-overlap' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return input;
      }),
    );

    const first = await engine.start('retention-overlap', 'a', { id: 'retention-overlap-a' });
    const second = await engine.start('retention-overlap', 'b', { id: 'retention-overlap-b' });
    await Promise.all([first.result(), second.result()]);

    storage.shouldTrackPurgeBatches = true;

    await waitForCondition(
      async () => {
        const remainingStates = await Promise.all([engine.get(first.id), engine.get(second.id)]);
        return remainingStates.filter((state) => state !== null).length === 1;
      },
      {
        label: 'exactly one workflow to be purged while the first retention sweep is in flight',
        timeoutMs: 400,
        intervalMs: 5,
      },
    );

    expect(storage.maxConcurrentPurgeBatches).toBe(1);

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: retention sweep defaults to every 5 minutes when not configured', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
      retention: {
        completed: '1s',
      },
    });

    engine.register(
      workflow({ name: 'echo' }).execute(async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      }),
    );

    const overview = engine.getRetentionOverview();
    expect(overview.sweepIntervalMs).toBe(300_000);
    expect(overview.nextSweepAt).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: per-workflow-type retention overrides the engine default', async () => {
    let now = 5_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: {
        completed: '1s',
      },
      retentionSweepInterval: '10ms',
    });

    engine.register(
      workflow({ name: 'short-lived' }).execute(async function* () {
        return 'short';
      }),
    );
    engine.register(
      workflow({
        name: 'long-lived',
        retention: { completed: '10s' },
      }).execute(async function* () {
        return 'long';
      }),
    );

    const shortHandle = await engine.start('short-lived', null, { id: 'short-lived' });
    const longHandle = await engine.start('long-lived', null, { id: 'long-lived' });
    await Promise.all([shortHandle.result(), longHandle.result()]);

    now += 1_500;
    await waitForWorkflowPresence(engine, shortHandle.id, false);
    expect(await engine.get(longHandle.id)).not.toBeNull();

    now += 9_000;
    await waitForWorkflowPresence(engine, longHandle.id, false);

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: retention deletes workflow state, checkpoints, checkpoint history, events, search attribute indexes, offloaded data, archived data, and stream chunks in one batch() call per workflow', async () => {
    const storage = new RecordingMemoryStorage();
    const engine = new Engine({
      storage,
    });

    engine.register(
      workflow({ name: 'artifact-workflow' }).execute(async function* (ctx: WorkflowContext) {
        const concreteContext = ctx;
        yield* concreteContext.stream('chunks', async function* () {
          yield { index: 0 };
          yield { index: 1 };
        });
        yield* concreteContext.offload('export', async () => ({ rows: [1, 2, 3] }));
        yield* concreteContext.archive('snapshot', { ok: true });
        return 'done';
      }),
    );

    const handle = await engine.start('artifact-workflow', null, {
      id: 'purge-me',
    });
    await handle.result();
    await engine.setAttributes(handle.id, { priority: 'high' });
    await storage.put(KEYS.stateExecution(handle.id, 'counter'), new TextEncoder().encode('1'));
    await storage.put(KEYS.update(handle.id, 'update-1'), encode({ updateId: 'update-1' }));
    await storage.put(KEYS.updateResponse('update-1'), encode({ result: 'done' }));

    const batchCallsBeforePurge = storage.batchCalls.length;

    const result = await engine.purge({ status: 'completed', type: 'artifact-workflow' });

    expect(result.deleted).toBe(1);
    expect(storage.batchCalls.length - batchCallsBeforePurge).toBe(1);
    expect(await engine.get(handle.id)).toBeNull();
    expect(await storage.get(KEYS.checkpoint(handle.id))).toBeNull();
    expect(await storage.get(KEYS.attribute(handle.id))).toBeNull();
    expect(await collectKeys(storage, `wf:${handle.id}:ckpt:`)).toEqual([]);
    expect(await collectKeys(storage, `ev:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `offload:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `archive:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `blob:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `state:execution:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `idx:priority:`)).toEqual([]);
    expect(await collectKeys(storage, KEYS.terminalWorkflowPrefix())).toEqual([]);
    expect(await storage.get(KEYS.update(handle.id, 'update-1'))).toBeNull();
    expect(await storage.get(KEYS.updateResponse('update-1'))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: engine.purge(filter) manually triggers cleanup only for the matching status, attribute, offset, and limit window', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
    });
    const targetFilter: AttributeFilter[] = [{ key: 'bucket', value: 'target' }];

    engine.register(
      workflow({ name: 'completed' }).execute(async function* () {
        return 'done';
      }),
    );
    engine.register(
      workflow({ name: 'waiting' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('continue');
        return 'done';
      }),
    );

    await createCompletedWorkflow(engine, 'completed', 'purge-match-1');
    await createCompletedWorkflow(engine, 'completed', 'purge-match-2');
    await createCompletedWorkflow(engine, 'completed', 'purge-other');
    await engine.setAttributes('purge-match-1', { bucket: 'target' });
    await engine.setAttributes('purge-match-2', { bucket: 'target' });
    await engine.setAttributes('purge-other', { bucket: 'other' });

    const runningHandle = await engine.start('waiting', null, { id: 'purge-running' });
    await waitForRunningWorkflow(engine, runningHandle.id);

    const purgeResult = await engine.purge({
      status: 'completed',
      attributes: targetFilter,
      offset: 1,
      limit: 1,
    });

    expect(purgeResult.deleted).toBe(1);
    expect(await engine.get('purge-match-1')).not.toBeNull();
    expect(await engine.get('purge-match-2')).toBeNull();
    expect(await engine.get('purge-other')).not.toBeNull();
    expect(await engine.get(runningHandle.id)).not.toBeNull();

    await engine.cancel(runningHandle.id);
    await runningHandle.result().catch(() => {});
    engine[Symbol.dispose]();
  });

  it('engine.purge(filter) treats limit 0 as a no-op', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
    });

    engine.register(
      workflow({ name: 'limit-zero' }).execute(async function* () {
        return 'done';
      }),
    );

    await createCompletedWorkflow(engine, 'limit-zero', 'purge-limit-zero');

    const result = await engine.purge({ status: 'completed', limit: 0 });

    expect(result).toEqual({ deleted: 0 });
    expect(await engine.get('purge-limit-zero')).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('engine.purge(filter) stops scanning workflow state entries once the limit is reached', async () => {
    const storage = new CountingWorkflowStateScanStorage();
    const engine = new Engine({ storage });

    engine.register(
      workflow({ name: 'limited-purge' }).execute(async function* () {
        return 'done';
      }),
    );

    await createCompletedWorkflow(engine, 'limited-purge', 'purge-limit-a');
    await createCompletedWorkflow(engine, 'limited-purge', 'purge-limit-b');
    await createCompletedWorkflow(engine, 'limited-purge', 'purge-limit-c');

    storage.resetTopLevelWorkflowStateEntriesSeen();

    const result = await engine.purge({ status: 'completed', limit: 1 });

    expect(result).toEqual({ deleted: 1 });
    expect(storage.topLevelWorkflowStateEntriesSeen).toBe(1);
    expect(await engine.get('purge-limit-a')).toBeNull();
    expect(await engine.get('purge-limit-b')).not.toBeNull();
    expect(await engine.get('purge-limit-c')).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('engine.purge(filter) deletes workflow tag index entries for purged workflows', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register(
      workflow({ name: 'tagged-purge' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return input;
      }),
    );

    const purgedHandle = await engine.start('tagged-purge', 'purge me', {
      id: 'purge-tagged-workflow',
      tags: ['nightly', 'v2'],
    });
    const retainedHandle = await engine.start('tagged-purge', 'keep me', {
      id: 'retain-tagged-workflow',
      tags: ['nightly'],
    });
    await Promise.all([purgedHandle.result(), retainedHandle.result()]);

    expect(await collectKeys(storage, 'tag:')).toEqual([
      KEYS.tagIndex('nightly', 'purge-tagged-workflow'),
      KEYS.tagIndex('nightly', 'retain-tagged-workflow'),
      KEYS.tagIndex('v2', 'purge-tagged-workflow'),
    ]);

    const result = await engine.purge({
      status: 'completed',
      tags: ['nightly', 'v2'],
    });

    expect(result.deleted).toBe(1);
    expect(await collectKeys(storage, 'tag:')).toEqual([
      KEYS.tagIndex('nightly', 'retain-tagged-workflow'),
    ]);

    engine[Symbol.dispose]();
  });

  it('retention sweep deletes orphaned terminal workflow index entries', async () => {
    const storage = new MemoryStorage();
    let now = 10_000;
    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: {
        completed: 0,
      },
      retentionSweepInterval: '10ms',
    });

    await storage.put(
      KEYS.terminalWorkflow(now - 1, 'orphaned-terminal-workflow'),
      new Uint8Array(),
    );

    await waitForCondition(
      async () => {
        const keys = await collectKeys(storage, KEYS.terminalWorkflowPrefix());
        return keys.length === 0;
      },
      {
        label: 'retention sweep to delete orphaned terminal workflow index entries',
        timeoutMs: 400,
        intervalMs: 5,
      },
    );

    now += 1;
    engine[Symbol.dispose]();
  });

  it('retention sweep scans the terminal-workflow index instead of top-level workflow state rows', async () => {
    let now = 10_000;
    const storage = new CountingWorkflowStateScanStorage();
    const engine = new Engine({
      storage,
      getNow: () => now,
      retention: {
        completed: '5s',
      },
      retentionSweepInterval: '10ms',
      retentionSweepBatchSize: 1,
    });

    engine.register(
      workflow({ name: 'retention-expired' }).execute(async function* () {
        return 'done';
      }),
    );
    engine.register(
      workflow({ name: 'retention-running' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('continue');
        return 'done';
      }),
    );

    await createCompletedWorkflow(engine, 'retention-expired', 'retention-expired-target');
    const runningHandle = await engine.start('retention-running', null, {
      id: 'retention-running-target',
    });
    await waitForRunningWorkflow(engine, runningHandle.id);

    storage.resetTopLevelWorkflowStateEntriesSeen();
    now += 6_000;

    await waitForWorkflowPresence(engine, 'retention-expired-target', false);

    expect(storage.topLevelWorkflowStateEntriesSeen).toBe(0);
    expect(storage.terminalWorkflowIndexEntriesSeen).toBeGreaterThan(0);

    await engine.cancel(runningHandle.id);
    await runningHandle.result().catch(() => {});
    engine[Symbol.dispose]();
  });
});
