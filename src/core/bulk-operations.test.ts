import { describe, expect, it } from 'bun:test';
import { waitForCondition } from '../testing/fake-timers.ts';

import {
  encodeStorageKeyComponent,
  KEYS,
  type BatchOperation,
  type ScanOptions,
} from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { BULK_WORKFLOW_FILTER_ERROR_MESSAGE } from './bulk-workflow-filter.ts';
import { encode } from './codec.ts';
import { BulkDeleteRequiresTerminalWorkflowsError, Engine } from './engine.ts';
import { cancelAll } from './engine/bulk-operations.ts';
import type { WorkflowContext, WorkflowState } from './types.ts';

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

async function* waitForSignalWorkflow(ctx: WorkflowContext, input: unknown) {
  const signal = yield* ctx.waitForSignal<string>('continue');
  return `${String(input)}:${signal}`;
}

async function* failingWorkflow(_ctx: WorkflowContext, _input: unknown) {
  throw new Error('bulk failure');
}

async function waitForWorkflowStatus(
  engine: Engine,
  workflowId: string,
  status: WorkflowState['status'],
  timeoutMs = 10_000,
): Promise<void> {
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      return state?.status === status;
    },
    { label: `workflow "${workflowId}" to reach ${status}`, timeoutMs, intervalMs: 5 },
  );
}

async function waitForWorkflowStatusCount(
  engine: Engine,
  status: WorkflowState['status'],
  expectedCount: number,
  timeoutMs = 500,
): Promise<void> {
  await waitForCondition(
    async () => {
      const result = await engine.list({ status });
      return result.total === expectedCount;
    },
    {
      label: `${String(expectedCount)} workflows to reach ${status}`,
      timeoutMs,
      intervalMs: 5,
    },
  );
}

async function createCompletedWorkflow(
  engine: Engine,
  workflowId: string,
  tags?: string[],
): Promise<void> {
  const handle = await engine.start('echo', workflowId, { id: workflowId, ...(tags && { tags }) });
  await handle.result();
}

class BulkCancelFailureStorage extends MemoryStorage {
  shouldFail = false;
  workflowIdToFail: string | null = null;

  override async batch(operations: BatchOperation[]): Promise<void> {
    if (
      this.shouldFail &&
      this.workflowIdToFail !== null &&
      operations.some(
        (operation) =>
          operation.type === 'put' && operation.key === KEYS.workflow(this.workflowIdToFail!),
      )
    ) {
      throw new Error(`simulated bulk cancellation failure for ${this.workflowIdToFail}`);
    }

    await super.batch(operations);
  }
}

class BulkBatchTrackingStorage extends MemoryStorage {
  shouldTrackBulkMutations = false;
  scannedTopLevelWorkflowStateEntries = 0;
  firstMutationSeenAfterScanningCount: number | null = null;

  override async *scan(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<[string, Uint8Array]> {
    for await (const entry of super.scan(prefix, options)) {
      const [key] = entry;
      if (prefix === 'wf:' && key.startsWith('wf:') && !key.slice('wf:'.length).includes(':')) {
        this.scannedTopLevelWorkflowStateEntries += 1;
      }
      yield entry;
    }
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    const mutatesTopLevelWorkflowState =
      this.shouldTrackBulkMutations &&
      operations.some(
        (operation) =>
          operation.key.startsWith('wf:') && !operation.key.slice('wf:'.length).includes(':'),
      );

    if (mutatesTopLevelWorkflowState && this.firstMutationSeenAfterScanningCount === null) {
      this.firstMutationSeenAfterScanningCount = this.scannedTopLevelWorkflowStateEntries;
    }

    await super.batch(operations);
  }
}

class BulkSignalFailureStorage extends MemoryStorage {
  workflowIdToFail: string | null = null;

  override async put(key: string, value: Uint8Array): Promise<void> {
    if (
      this.workflowIdToFail !== null &&
      key.startsWith(`sig:${encodeStorageKeyComponent(this.workflowIdToFail)}:`)
    ) {
      throw new Error(`simulated bulk signal failure for ${this.workflowIdToFail}`);
    }

    await super.put(key, value);
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    if (
      this.workflowIdToFail !== null &&
      operations.some(
        (operation) =>
          operation.type === 'put' &&
          operation.key.startsWith(`sig:${encodeStorageKeyComponent(this.workflowIdToFail!)}:`),
      )
    ) {
      throw new Error(`simulated bulk signal failure for ${this.workflowIdToFail}`);
    }

    await super.batch(operations);
  }
}

class BulkWorkflowReorderingScanStorage extends MemoryStorage {
  readonly #topLevelWorkflowKeys = new Set<string>();
  readonly #workflowScanOrder: string[] = [];

  override async put(key: string, value: Uint8Array): Promise<void> {
    await super.put(key, value);
    this.#recordTopLevelWorkflowWrite(key);
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    await super.batch(operations);

    for (const operation of operations) {
      if (!this.#isTopLevelWorkflowStateKey(operation.key)) {
        continue;
      }

      if (operation.type === 'put') {
        this.#recordTopLevelWorkflowWrite(operation.key);
      } else {
        this.#topLevelWorkflowKeys.delete(operation.key);
        const index = this.#workflowScanOrder.indexOf(operation.key);
        if (index !== -1) {
          this.#workflowScanOrder.splice(index, 1);
        }
      }
    }
  }

  override async *scan(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<[string, Uint8Array]> {
    const usesCustomWorkflowScan =
      prefix === 'wf:' &&
      options.limit === undefined &&
      options.reverse !== true &&
      options.gt === undefined &&
      options.gte === undefined &&
      options.lt === undefined &&
      options.lte === undefined;

    if (!usesCustomWorkflowScan) {
      yield* super.scan(prefix, options);
      return;
    }

    let index = 0;
    while (index < this.#workflowScanOrder.length) {
      const key = this.#workflowScanOrder[index];
      index += 1;

      if (!key || !this.#topLevelWorkflowKeys.has(key)) {
        continue;
      }

      const value = await this.get(key);
      if (value !== null) {
        yield [key, value];
      }
    }
  }

  #recordTopLevelWorkflowWrite(key: string): void {
    if (!this.#isTopLevelWorkflowStateKey(key)) {
      return;
    }

    this.#topLevelWorkflowKeys.add(key);
    const existingIndex = this.#workflowScanOrder.indexOf(key);
    if (existingIndex !== -1) {
      this.#workflowScanOrder.splice(existingIndex, 1);
    }
    this.#workflowScanOrder.push(key);
  }

  #isTopLevelWorkflowStateKey(key: string): boolean {
    return key.startsWith('wf:') && !key.slice('wf:'.length).includes(':');
  }
}

class BulkTagDeletionDuringMutationStorage extends MemoryStorage {
  workflowIdToDeleteOnNextMutation: string | null = null;
  #shouldDeleteTargetWorkflow = false;

  override async *scan(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<[string, Uint8Array]> {
    yield* super.scan(prefix, options);

    const usesBulkWorkflowSnapshotScan =
      prefix === 'wf:' &&
      options.limit === undefined &&
      options.reverse !== true &&
      options.gt === undefined &&
      options.gte === undefined &&
      options.lt === undefined &&
      options.lte === undefined;

    if (usesBulkWorkflowSnapshotScan && this.workflowIdToDeleteOnNextMutation !== null) {
      this.#shouldDeleteTargetWorkflow = true;
    }
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (
      this.#shouldDeleteTargetWorkflow &&
      this.workflowIdToDeleteOnNextMutation !== null &&
      key === KEYS.workflow(this.workflowIdToDeleteOnNextMutation)
    ) {
      this.#shouldDeleteTargetWorkflow = false;
      await super.delete(key);
      return null;
    }

    return super.get(key);
  }
}

describe('bulk workflow operations', () => {
  it('reports workflows that remain active after bulk cancellation attempts', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'bulk-cancel-remains-running';
    await storage.put(
      KEYS.workflow(workflowId),
      encode({
        createdAt: 1,
        id: workflowId,
        input: null,
        startedAt: 1,
        status: 'running',
        tags: ['bulk-cancel-remaining'],
        type: 'workflow',
        updatedAt: 1,
        version: '1',
      } satisfies WorkflowState),
    );

    const result = await cancelAll(
      {
        engine: { cancel: async () => {} },
        storage,
      } as never,
      { status: 'running' },
    );

    expect(result).toEqual({
      cancelled: 0,
      failed: 1,
      errors: [{ id: workflowId, error: 'Workflow no longer cancellable' }],
    });

    const ignored = await cancelAll(
      {
        engine: { cancel: async () => {} },
        storage,
      } as never,
      { status: 'completed' },
    );

    expect(ignored).toEqual({ cancelled: 0, failed: 0, errors: [] });
  });

  it('deletes deadline timer keys when bulk deleting terminal workflows', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const workflowId = 'bulk-delete-deadline';
    const state = {
      createdAt: 1,
      executionDeadline: 10_000,
      id: workflowId,
      input: null,
      result: 'done',
      startedAt: 1,
      status: 'completed',
      tags: ['bulk-delete-deadline'],
      type: 'workflow',
      updatedAt: 5_000,
      version: '1',
    } satisfies WorkflowState;

    await storage.put(KEYS.workflow(workflowId), encode(state));
    await storage.put(KEYS.terminalWorkflow(state.updatedAt, workflowId), new Uint8Array());
    await storage.put(KEYS.deadline(state.executionDeadline, workflowId), new Uint8Array([1]));
    await storage.put(`timer-idx:deadline:${workflowId}`, new Uint8Array([1]));

    await expect(engine.deleteAll({ status: 'completed' })).resolves.toEqual({
      deleted: 1,
    });

    expect(await storage.get(KEYS.deadline(state.executionDeadline, workflowId))).toBeNull();
    expect(await storage.get(`timer-idx:deadline:${workflowId}`)).toBeNull();

    engine[Symbol.dispose]();
  });

  it('acceptance criterion: engine.cancelAll(filter) cancels matching workflows and reports per-workflow failures', async () => {
    const storage = new BulkCancelFailureStorage();
    const engine = new Engine({ storage });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      await engine.start('wait-for-signal', 'one', {
        id: 'bulk-cancel-success-a',
        tags: ['bulk-cancel'],
      });
      await engine.start('wait-for-signal', 'two', {
        id: 'bulk-cancel-failure',
        tags: ['bulk-cancel'],
      });
      await engine.start('wait-for-signal', 'three', {
        id: 'bulk-cancel-success-b',
        tags: ['bulk-cancel'],
      });

      await Promise.all([
        waitForWorkflowStatus(engine, 'bulk-cancel-success-a', 'running'),
        waitForWorkflowStatus(engine, 'bulk-cancel-failure', 'running'),
        waitForWorkflowStatus(engine, 'bulk-cancel-success-b', 'running'),
      ]);

      storage.workflowIdToFail = 'bulk-cancel-failure';
      storage.shouldFail = true;

      const result = await engine.cancelAll({ tags: ['bulk-cancel'] });

      expect(result.cancelled).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors).toEqual([
        {
          id: 'bulk-cancel-failure',
          error: 'simulated bulk cancellation failure for bulk-cancel-failure',
        },
      ]);
      const firstCancelledState = await engine.get('bulk-cancel-success-a');
      const secondCancelledState = await engine.get('bulk-cancel-success-b');
      const failedState = await engine.get('bulk-cancel-failure');
      expect(firstCancelledState?.status).toBe('cancelled');
      expect(secondCancelledState?.status).toBe('cancelled');
      expect(failedState?.status).toBe('running');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('acceptance criterion: engine.signalAll(filter, name, payload) signals all matching workflows', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      const firstHandle = await engine.start('wait-for-signal', 'first', {
        id: 'bulk-signal-first',
        tags: ['bulk-signal'],
      });
      const secondHandle = await engine.start('wait-for-signal', 'second', {
        id: 'bulk-signal-second',
        tags: ['bulk-signal'],
      });
      const untouchedHandle = await engine.start('wait-for-signal', 'other', {
        id: 'bulk-signal-other',
        tags: ['not-targeted'],
      });

      await Promise.all([
        waitForWorkflowStatus(engine, firstHandle.id, 'running'),
        waitForWorkflowStatus(engine, secondHandle.id, 'running'),
        waitForWorkflowStatus(engine, untouchedHandle.id, 'running'),
      ]);

      const result = await engine.signalAll({ tags: ['bulk-signal'] }, 'continue', 'released');

      expect(result).toEqual({ signalled: 2, failed: 0 });
      await expect(firstHandle.result()).resolves.toBe('first:released');
      await expect(secondHandle.result()).resolves.toBe('second:released');
      const untouchedState = await engine.get(untouchedHandle.id);
      expect(untouchedState?.status).toBe('running');

      await engine.signal(untouchedHandle.id, 'continue', 'cleanup');
      await expect(untouchedHandle.result()).resolves.toBe('other:cleanup');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('tracks failed signals when one matching workflow cannot be signalled', async () => {
    const storage = new BulkSignalFailureStorage();
    const engine = new Engine({ storage });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      const firstHandle = await engine.start('wait-for-signal', 'first', {
        id: 'bulk-signal-success-a',
        tags: ['bulk-signal-failure'],
      });
      const failedHandle = await engine.start('wait-for-signal', 'second', {
        id: 'bulk-signal-failure',
        tags: ['bulk-signal-failure'],
      });
      const thirdHandle = await engine.start('wait-for-signal', 'third', {
        id: 'bulk-signal-success-b',
        tags: ['bulk-signal-failure'],
      });

      await Promise.all([
        waitForWorkflowStatus(engine, firstHandle.id, 'running'),
        waitForWorkflowStatus(engine, failedHandle.id, 'running'),
        waitForWorkflowStatus(engine, thirdHandle.id, 'running'),
      ]);

      storage.workflowIdToFail = failedHandle.id;

      const result = await engine.signalAll(
        { tags: ['bulk-signal-failure'] },
        'continue',
        'released',
      );

      expect(result).toEqual({ signalled: 2, failed: 1 });
      await expect(firstHandle.result()).resolves.toBe('first:released');
      await expect(thirdHandle.result()).resolves.toBe('third:released');
      const failedState = await engine.get(failedHandle.id);
      expect(failedState?.status).toBe('running');

      storage.workflowIdToFail = null;
      await engine.signal(failedHandle.id, 'continue', 'cleanup');
      await expect(failedHandle.result()).resolves.toBe('second:cleanup');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('bulk operations honor the limit and offset fields from the list filter shape', async () => {
    const now = 2_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
    });
    engine.register('echo', echoWorkflow);

    try {
      for (const workflowId of ['bulk-window-01', 'bulk-window-02', 'bulk-window-03']) {
        await engine.start('echo', workflowId, {
          id: workflowId,
          startAt: now + 60_000,
        });
      }

      const result = await engine.cancelAll({
        status: 'pending',
        offset: 1,
        limit: 1,
      });

      expect(result.cancelled).toBe(1);
      const firstWindowState = await engine.get('bulk-window-01');
      const secondWindowState = await engine.get('bulk-window-02');
      const thirdWindowState = await engine.get('bulk-window-03');
      expect(firstWindowState?.status).toBe('pending');
      expect(secondWindowState?.status).toBe('cancelled');
      expect(thirdWindowState?.status).toBe('pending');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('applies limit and offset after narrowing to actionable statuses for cancellation', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('echo', echoWorkflow);
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      await createCompletedWorkflow(engine, 'bulk-pagination-01-completed', ['bulk-pagination']);
      await engine.start('wait-for-signal', 'running', {
        id: 'bulk-pagination-02-running',
        tags: ['bulk-pagination'],
      });

      await waitForWorkflowStatus(engine, 'bulk-pagination-02-running', 'running');

      const result = await engine.cancelAll({
        tags: ['bulk-pagination'],
        limit: 1,
      });

      expect(result.cancelled).toBe(1);
      const completedState = await engine.get('bulk-pagination-01-completed');
      const runningState = await engine.get('bulk-pagination-02-running');
      expect(completedState?.status).toBe('completed');
      expect(runningState?.status).toBe('cancelled');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('acceptance criterion: engine.deleteAll(filter) deletes matching terminal workflows and rejects when running workflows would match', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('echo', echoWorkflow);
    engine.register('wait-for-signal', waitForSignalWorkflow);
    engine.register('failing', failingWorkflow);

    try {
      await createCompletedWorkflow(engine, 'bulk-delete-completed', ['bulk-delete']);

      const failedHandle = await engine.start('failing', null, {
        id: 'bulk-delete-failed',
        tags: ['bulk-delete'],
      });
      await failedHandle.result().catch(() => {});

      const runningHandle = await engine.start('wait-for-signal', 'payload', {
        id: 'bulk-delete-running',
        tags: ['bulk-delete'],
      });
      await waitForWorkflowStatus(engine, runningHandle.id, 'running');

      const deletePromise = engine.deleteAll({ tags: ['bulk-delete'] });
      await expect(deletePromise).rejects.toBeInstanceOf(BulkDeleteRequiresTerminalWorkflowsError);
      await expect(deletePromise).rejects.toThrow('Bulk delete matches non-terminal workflows');

      expect(await engine.get('bulk-delete-completed')).not.toBeNull();
      expect(await engine.get('bulk-delete-failed')).not.toBeNull();
      expect(await engine.get('bulk-delete-running')).not.toBeNull();

      await engine.cancel(runningHandle.id);
      await runningHandle.result().catch(() => {});

      const result = await engine.deleteAll({
        tags: ['bulk-delete'],
        status: ['completed', 'failed', 'cancelled'],
      });

      expect(result).toEqual({ deleted: 3 });
      expect(await engine.get('bulk-delete-completed')).toBeNull();
      expect(await engine.get('bulk-delete-failed')).toBeNull();
      expect(await engine.get('bulk-delete-running')).toBeNull();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects invalid limit and offset values for destructive bulk operations instead of widening the filter', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('echo', echoWorkflow);

    try {
      await createCompletedWorkflow(engine, 'bulk-invalid-pagination', ['bulk-invalid-pagination']);

      await expect(
        engine.cancelAll({ tags: ['bulk-invalid-pagination'], limit: -1 }),
      ).rejects.toThrow('filter.limit must be a non-negative number when provided');
      await expect(
        engine.signalAll({ tags: ['bulk-invalid-pagination'], offset: Number.NaN }, 'continue'),
      ).rejects.toThrow('filter.offset must be a non-negative number when provided');
      await expect(
        engine.deleteAll({ tags: ['bulk-invalid-pagination'], limit: Number.POSITIVE_INFINITY }),
      ).rejects.toThrow('filter.limit must be a non-negative number when provided');
      await expect(
        engine.tagAll({ tags: ['bulk-invalid-pagination'], offset: -1 }, ['bulk']),
      ).rejects.toThrow('filter.offset must be a non-negative number when provided');

      expect(await engine.get('bulk-invalid-pagination')).not.toBeNull();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects unscoped bulk filters, including empty or whitespace-only tags and attributes', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    try {
      await expect(engine.cancelAll({})).rejects.toThrow(BULK_WORKFLOW_FILTER_ERROR_MESSAGE);
      await expect(engine.cancelAll({ tags: [] })).rejects.toThrow(
        BULK_WORKFLOW_FILTER_ERROR_MESSAGE,
      );
      await expect(engine.cancelAll({ tags: ['   '] })).rejects.toThrow(
        BULK_WORKFLOW_FILTER_ERROR_MESSAGE,
      );
      await expect(engine.cancelAll({ attributes: [] })).rejects.toThrow(
        BULK_WORKFLOW_FILTER_ERROR_MESSAGE,
      );
      await expect(engine.cancelAll({ attributes: [{ key: '   ' }] })).rejects.toThrow(
        BULK_WORKFLOW_FILTER_ERROR_MESSAGE,
      );
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('acceptance criterion: engine.tagAll(filter, tags) and engine.untagAll(filter, tags) bulk-modify workflow tags durably', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register('echo', echoWorkflow);

    try {
      await createCompletedWorkflow(engine, 'bulk-tags-first', ['selected']);
      await createCompletedWorkflow(engine, 'bulk-tags-second', ['selected']);
      await createCompletedWorkflow(engine, 'bulk-tags-other', ['other']);

      const tagResult = await engine.tagAll({ tags: ['selected'] }, ['bulk', 'selected']);
      expect(tagResult).toEqual({ modified: 2 });
      const firstTaggedState = await engine.get('bulk-tags-first');
      const secondTaggedState = await engine.get('bulk-tags-second');
      const otherTaggedState = await engine.get('bulk-tags-other');
      expect(firstTaggedState?.tags).toEqual(['bulk', 'selected']);
      expect(secondTaggedState?.tags).toEqual(['bulk', 'selected']);
      expect(otherTaggedState?.tags).toEqual(['other']);

      const untagResult = await engine.untagAll({ tags: ['bulk'] }, ['selected']);
      expect(untagResult).toEqual({ modified: 2 });
    } finally {
      await engine[Symbol.asyncDispose]();
    }

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register('echo', echoWorkflow);

    try {
      const recoveredFirstState = await recoveredEngine.get('bulk-tags-first');
      const recoveredSecondState = await recoveredEngine.get('bulk-tags-second');
      const recoveredOtherState = await recoveredEngine.get('bulk-tags-other');
      expect(recoveredFirstState?.tags).toEqual(['bulk']);
      expect(recoveredSecondState?.tags).toEqual(['bulk']);
      expect(recoveredOtherState?.tags).toEqual(['other']);
    } finally {
      await recoveredEngine[Symbol.asyncDispose]();
    }
  });

  it('applies limit and offset to tag-indexed bulk tag mutations after filtering', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('echo', echoWorkflow);

    try {
      await createCompletedWorkflow(engine, 'bulk-tags-window-01', ['bulk-window']);
      await createCompletedWorkflow(engine, 'bulk-tags-window-02', ['bulk-window']);
      await createCompletedWorkflow(engine, 'bulk-tags-window-03', ['bulk-window']);
      await createCompletedWorkflow(engine, 'bulk-tags-window-other', ['other']);

      const result = await engine.tagAll(
        {
          tags: ['bulk-window'],
          offset: 1,
          limit: 1,
        },
        ['selected-window'],
      );

      expect(result).toEqual({ modified: 1 });
      const firstWindowState = await engine.get('bulk-tags-window-01');
      const secondWindowState = await engine.get('bulk-tags-window-02');
      const thirdWindowState = await engine.get('bulk-tags-window-03');
      const otherState = await engine.get('bulk-tags-window-other');
      expect(firstWindowState?.tags).toEqual(['bulk-window']);
      expect(secondWindowState?.tags).toEqual(['bulk-window', 'selected-window']);
      expect(thirdWindowState?.tags).toEqual(['bulk-window']);
      expect(otherState?.tags).toEqual(['other']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('snapshots workflow ids before bulk tag mutation rewrites workflow state entries mid-scan', async () => {
    const storage = new BulkWorkflowReorderingScanStorage();
    const engine = new Engine({ storage });
    engine.register('echo', echoWorkflow);

    try {
      await createCompletedWorkflow(engine, 'bulk-tags-scan-first');
      await createCompletedWorkflow(engine, 'bulk-tags-scan-second');
      await createCompletedWorkflow(engine, 'bulk-tags-scan-third');

      const result = await engine.tagAll({ status: 'completed' }, ['bulk']);
      const firstWorkflow = await engine.get('bulk-tags-scan-first');
      const secondWorkflow = await engine.get('bulk-tags-scan-second');
      const thirdWorkflow = await engine.get('bulk-tags-scan-third');

      expect(result).toEqual({ modified: 3 });
      expect(firstWorkflow?.tags).toEqual(['bulk']);
      expect(secondWorkflow?.tags).toEqual(['bulk']);
      expect(thirdWorkflow?.tags).toEqual(['bulk']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('snapshots workflow ids before bulk cancel rewrites workflow state entries between batches', async () => {
    const now = 1_000;
    const storage = new BulkWorkflowReorderingScanStorage();
    const engine = new Engine({
      storage,
      getNow: () => now,
    });
    engine.register('echo', echoWorkflow);

    try {
      for (let index = 0; index < 1_001; index++) {
        await engine.start('echo', index, {
          id: `bulk-cancel-scan-${String(index)}`,
          startAt: now + 60_000,
        });
      }

      const result = await engine.cancelAll({ status: 'pending' });
      const lastWorkflow = await engine.get('bulk-cancel-scan-1000');

      expect(result.cancelled).toBe(1_001);
      expect(result.failed).toBe(0);
      expect(result.errors).toEqual([]);
      expect(lastWorkflow?.status).toBe('cancelled');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('snapshots workflow ids before bulk signal rewrites workflow state entries between batches', async () => {
    const storage = new BulkWorkflowReorderingScanStorage();
    const engine = new Engine({ storage });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      const handles = [];
      for (let index = 0; index < 1_001; index++) {
        handles.push(
          await engine.start('wait-for-signal', `bulk-signal-input-${String(index)}`, {
            id: `bulk-signal-scan-${String(index)}`,
          }),
        );
      }

      await waitForWorkflowStatusCount(engine, 'running', handles.length, 10_000);

      const result = await engine.signalAll({ status: 'running' }, 'continue', 'released');

      expect(result).toEqual({ signalled: 1_001, failed: 0 });
      await expect(handles[0]?.result()).resolves.toBe('bulk-signal-input-0:released');
      await expect(handles[1_000]?.result()).resolves.toBe('bulk-signal-input-1000:released');
      const lastWorkflow = await engine.get('bulk-signal-scan-1000');
      expect(lastWorkflow?.status).toBe('completed');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('skips workflows deleted after the bulk tag snapshot instead of aborting the whole operation', async () => {
    const storage = new BulkTagDeletionDuringMutationStorage();
    const engine = new Engine({ storage });
    engine.register('echo', echoWorkflow);

    try {
      await createCompletedWorkflow(engine, 'bulk-tags-delete-first');
      await createCompletedWorkflow(engine, 'bulk-tags-delete-second');
      await createCompletedWorkflow(engine, 'bulk-tags-delete-third');
      storage.workflowIdToDeleteOnNextMutation = 'bulk-tags-delete-second';

      const result = await engine.tagAll({ status: 'completed' }, ['bulk']);
      const firstWorkflow = await engine.get('bulk-tags-delete-first');
      const secondWorkflow = await engine.get('bulk-tags-delete-second');
      const thirdWorkflow = await engine.get('bulk-tags-delete-third');

      expect(result).toEqual({ modified: 2 });
      expect(firstWorkflow?.tags).toEqual(['bulk']);
      expect(secondWorkflow).toBeNull();
      expect(thirdWorkflow?.tags).toEqual(['bulk']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('snapshots all matching workflow ids before the first bulk cancellation mutation', async () => {
    const now = 1_000;
    const storage = new BulkBatchTrackingStorage();
    const engine = new Engine({
      storage,
      getNow: () => now,
    });
    engine.register('echo', echoWorkflow);

    try {
      for (let index = 0; index < 1_005; index++) {
        await engine.start('echo', index, {
          id: `bulk-batch-${String(index)}`,
          startAt: now + 60_000,
        });
      }

      storage.shouldTrackBulkMutations = true;

      const result = await engine.cancelAll({ status: 'pending' });

      expect(result.cancelled).toBe(1_005);
      expect(storage.firstMutationSeenAfterScanningCount).toBe(1_005);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
