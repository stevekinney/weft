import { describe, expect, it } from 'bun:test';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { flush } from '../testing/storage-backends.test-support.ts';

import {
  encodeStorageKeyComponent,
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
} from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { BULK_WORKFLOW_FILTER_ERROR_MESSAGE } from './bulk-workflow-filter.ts';
import { decode, encode } from './codec.ts';
import { BulkDeleteRequiresTerminalWorkflowsError, Engine } from './engine.ts';
import { normalizeBulkOperationOptions } from './engine/bulk-operations-shared.ts';
import { cancelAll } from './engine/bulk-operations.ts';
import { BULK_OPERATION_BATCH_SIZE } from './engine/listing.ts';
import type { SearchAttributeValue, WorkflowContext, WorkflowState } from './types.ts';
import { workflow } from './types.ts';
import {
  MAX_BULK_CONFIRMATION_TOKEN_LENGTH,
  MAX_BULK_OPERATION_REQUEST_ID_LENGTH,
} from './types/bulk.ts';

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

async function* waitForSignalWorkflow(ctx: WorkflowContext, input: unknown) {
  const signal = yield* ctx.waitForSignal<string>('continue');
  return `${String(input)}:${signal}`;
}

async function* waitForUnknownSignalWorkflow(ctx: WorkflowContext) {
  return yield* ctx.waitForSignal('continue');
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
  searchAttributes?: Record<string, SearchAttributeValue>,
): Promise<void> {
  const handle = await engine.start('echo', workflowId, {
    id: workflowId,
    ...(tags && { tags }),
    ...(searchAttributes && { searchAttributes }),
  });
  await handle.result();
}

async function writePendingWorkflowState(
  storage: MemoryStorage,
  workflowId: string,
  timestamp: number,
): Promise<void> {
  await storage.put(
    KEYS.workflow(workflowId),
    encode({
      createdAt: timestamp,
      id: workflowId,
      input: null,
      startedAt: timestamp,
      status: 'pending',
      type: 'echo',
      updatedAt: timestamp,
      versionTuple: { workflowVersion: '1' },
    } satisfies WorkflowState),
  );
}

async function readWorkflowState(
  storage: MemoryStorage,
  workflowId: string,
): Promise<WorkflowState | null> {
  const workflowStateBytes = await storage.get(KEYS.workflow(workflowId));
  return workflowStateBytes === null ? null : (decode(workflowStateBytes) as WorkflowState);
}

class FailOneWorkflowDeleteStorage extends MemoryStorage {
  failedWorkflowId: string | null = null;

  override async batch(operations: BatchOperation[]): Promise<void> {
    const failedWorkflowId = this.failedWorkflowId;
    if (
      failedWorkflowId !== null &&
      operations.some((operation) => operation.key === KEYS.workflow(failedWorkflowId))
    ) {
      throw new Error(`refused to delete ${failedWorkflowId}`);
    }

    await super.batch(operations);
  }
}

function createStorageBackedCancellationInternals(storage: MemoryStorage, timestamp: number) {
  return {
    engine: {
      cancel: async (workflowId: string) => {
        const workflowState = await readWorkflowState(storage, workflowId);
        if (workflowState === null) {
          throw new Error(`Workflow ${workflowId} not found`);
        }

        await storage.batch([
          {
            type: 'put',
            key: KEYS.workflow(workflowId),
            value: encode({
              ...workflowState,
              status: 'cancelled',
              updatedAt: timestamp,
            } satisfies WorkflowState),
          },
        ]);
      },
    },
    storage,
  } as never;
}

function createObservedCancellationInternals(
  storage: MemoryStorage,
  timestamp: number,
  workflowIdToFail?: string,
) {
  const observation = {
    activeCancellations: 0,
    maximumActiveCancellations: 0,
  };

  const internals = {
    engine: {
      cancel: async (workflowId: string) => {
        observation.activeCancellations += 1;
        observation.maximumActiveCancellations = Math.max(
          observation.maximumActiveCancellations,
          observation.activeCancellations,
        );

        try {
          await Promise.resolve();
          if (workflowId === workflowIdToFail) {
            throw new Error(`simulated cancellation failure for ${workflowId}`);
          }

          const workflowState = await readWorkflowState(storage, workflowId);
          if (workflowState === null) {
            throw new Error(`Workflow ${workflowId} not found`);
          }

          await storage.batch([
            {
              type: 'put',
              key: KEYS.workflow(workflowId),
              value: encode({
                ...workflowState,
                status: 'cancelled',
                updatedAt: timestamp,
              } satisfies WorkflowState),
            },
          ]);
        } finally {
          observation.activeCancellations -= 1;
        }
      },
    },
    storage,
  } as never;

  return { internals, observation };
}

function isTopLevelWorkflowStateKey(key: string): boolean {
  return key.startsWith('wf:') && !key.slice('wf:'.length).includes(':');
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
      if (prefix === 'wf:' && isTopLevelWorkflowStateKey(key)) {
        this.scannedTopLevelWorkflowStateEntries += 1;
      }
      yield entry;
    }
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    const mutatesTopLevelWorkflowState =
      this.shouldTrackBulkMutations &&
      operations.some((operation) => isTopLevelWorkflowStateKey(operation.key));

    if (mutatesTopLevelWorkflowState && this.firstMutationSeenAfterScanningCount === null) {
      this.firstMutationSeenAfterScanningCount = this.scannedTopLevelWorkflowStateEntries;
    }

    await super.batch(operations);
  }
}

class WorkflowStateGetFailureStorage extends MemoryStorage {
  shouldFailWorkflowStateGet = false;
  workflowStateGetCount = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    if (isTopLevelWorkflowStateKey(key)) {
      this.workflowStateGetCount += 1;
      if (this.shouldFailWorkflowStateGet) {
        throw new Error(`unexpected workflow state get for ${key}`);
      }
    }

    return super.get(key);
  }
}

class TerminalWorkflowReloadRaceStorage extends MemoryStorage {
  workflowIdToFlip: string | null = null;
  workflowReadCount = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    const value = await super.get(key);
    if (
      value === null ||
      this.workflowIdToFlip === null ||
      key !== KEYS.workflow(this.workflowIdToFlip)
    ) {
      return value;
    }

    this.workflowReadCount += 1;
    if (this.workflowReadCount !== 2) {
      return value;
    }

    const workflowState = decode(value) as WorkflowState;
    return encode({
      ...workflowState,
      status: 'running',
      updatedAt: workflowState.updatedAt + 1,
    } satisfies WorkflowState);
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

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
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

    return super.conditionalBatch(conditions, operations);
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
  it('rejects malformed programmatic bulk operation controls', () => {
    expect(() => normalizeBulkOperationOptions({ dryRun: true, bulkConcurrency: 0 })).toThrow(
      'Field "bulkConcurrency" must be a positive integer',
    );
    expect(() =>
      normalizeBulkOperationOptions({
        confirmationToken: 'x'.repeat(MAX_BULK_CONFIRMATION_TOKEN_LENGTH + 1),
      }),
    ).toThrow(
      `Field "confirmationToken" must be at most ${String(MAX_BULK_CONFIRMATION_TOKEN_LENGTH)} characters`,
    );
    expect(() =>
      normalizeBulkOperationOptions({
        dryRun: true,
        requestId: 'x'.repeat(MAX_BULK_OPERATION_REQUEST_ID_LENGTH + 1),
      }),
    ).toThrow(
      `Field "requestId" must be at most ${String(MAX_BULK_OPERATION_REQUEST_ID_LENGTH)} characters`,
    );
  });

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
        versionTuple: { workflowVersion: '1' },
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
      versionTuple: { workflowVersion: '1' },
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

  it('counts same-batch bulk delete successes before surfacing a delete failure', async () => {
    const storage = new FailOneWorkflowDeleteStorage();
    const engine = new Engine({ storage });
    const echoWorkflow1 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow1);

    try {
      await createCompletedWorkflow(engine, 'bulk-delete-success', ['bulk-delete-partial']);
      await createCompletedWorkflow(engine, 'bulk-delete-failure', ['bulk-delete-partial']);
      storage.failedWorkflowId = 'bulk-delete-failure';

      await expect(
        engine.deleteAll({ tags: ['bulk-delete-partial'] }, { bulkConcurrency: 2 }),
      ).rejects.toThrow('Bulk delete failed for 1 workflow(s) after deleting 1 workflow(s)');

      expect(await engine.get('bulk-delete-success')).toBeNull();
      expect(await engine.get('bulk-delete-failure')).not.toBeNull();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('acceptance criterion: engine.cancelAll(filter) cancels matching workflows and reports per-workflow failures', async () => {
    const storage = new BulkCancelFailureStorage();
    const engine = new Engine({ storage });
    const waitForSignalWorkflow2 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow2);

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

  it('defaults bulk cancellation to serial workflow processing', async () => {
    const now = 1_000;
    const storage = new MemoryStorage();
    for (const workflowId of ['bulk-serial-a', 'bulk-serial-b', 'bulk-serial-c']) {
      await writePendingWorkflowState(storage, workflowId, now);
    }
    const { internals, observation } = createObservedCancellationInternals(storage, now);

    const result = await cancelAll(internals, { status: 'pending' });

    expect(result.cancelled).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(observation.maximumActiveCancellations).toBe(1);
  });

  it('honors bulkConcurrency for cancellation while preserving per-workflow failures', async () => {
    const now = 1_000;
    const storage = new MemoryStorage();
    const workflowIds = [
      'bulk-concurrent-a',
      'bulk-concurrent-b',
      'bulk-concurrent-failure',
      'bulk-concurrent-c',
    ];
    for (const workflowId of workflowIds) {
      await writePendingWorkflowState(storage, workflowId, now);
    }
    const { internals, observation } = createObservedCancellationInternals(
      storage,
      now,
      'bulk-concurrent-failure',
    );

    const result = await cancelAll(internals, { status: 'pending' }, { bulkConcurrency: 2 });

    expect(result).toEqual({
      cancelled: 3,
      failed: 1,
      errors: [
        {
          id: 'bulk-concurrent-failure',
          error: 'simulated cancellation failure for bulk-concurrent-failure',
        },
      ],
    });
    expect(observation.maximumActiveCancellations).toBe(2);
    expect(await readWorkflowState(storage, 'bulk-concurrent-a')).toEqual(
      expect.objectContaining({ status: 'cancelled' }),
    );
    expect(await readWorkflowState(storage, 'bulk-concurrent-b')).toEqual(
      expect.objectContaining({ status: 'cancelled' }),
    );
    expect(await readWorkflowState(storage, 'bulk-concurrent-c')).toEqual(
      expect.objectContaining({ status: 'cancelled' }),
    );
    expect(await readWorkflowState(storage, 'bulk-concurrent-failure')).toEqual(
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('default cancelAll (no status filter) reaches a suspended workflow', async () => {
    // ACTIVE_WORKFLOW_STATUSES includes 'suspended' so a default bulk cancel is
    // consistent with single-workflow cancel, which is total over a suspended run.
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register(workflow({ name: 'wait-for-signal' }).execute(waitForSignalWorkflow));

    try {
      await engine.start('wait-for-signal', 'a', { id: 'bulk-suspend-a', tags: ['bulk-suspend'] });
      await engine.start('wait-for-signal', 'b', { id: 'bulk-suspend-b', tags: ['bulk-suspend'] });
      await Promise.all([
        waitForWorkflowStatus(engine, 'bulk-suspend-a', 'running'),
        waitForWorkflowStatus(engine, 'bulk-suspend-b', 'running'),
      ]);

      // Suspend one of them; the other stays running.
      await engine.suspend('bulk-suspend-a');
      await waitForWorkflowStatus(engine, 'bulk-suspend-a', 'suspended');

      const result = await engine.cancelAll({ tags: ['bulk-suspend'] });
      expect(result.cancelled).toBe(2);
      const stateA = await engine.get('bulk-suspend-a');
      const stateB = await engine.get('bulk-suspend-b');
      expect(stateA?.status).toBe('cancelled');
      expect(stateB?.status).toBe('cancelled');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('acceptance criterion: engine.signalAll(filter, name, payload) signals all matching workflows', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const waitForSignalWorkflow3 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow3);

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

  it('keeps three-argument signalAll object payloads as payloads even when they contain control-shaped keys', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const waitForUnknownSignalWorkflow2 = workflow({ name: 'wait-for-unknown-signal' }).execute(
      waitForUnknownSignalWorkflow,
    );
    engine.register(waitForUnknownSignalWorkflow2);

    try {
      const payload = {
        dryRun: true,
        requestId: 'payload-request-id',
        confirmationToken: 'payload-confirmation-token',
      };
      const handle = await engine.start('wait-for-unknown-signal', undefined, {
        id: 'bulk-signal-control-shaped-payload',
        tags: ['bulk-signal-control-shaped-payload'],
      });
      await waitForWorkflowStatus(engine, handle.id, 'running');

      const result = await engine.signalAll(
        { tags: ['bulk-signal-control-shaped-payload'] },
        'continue',
        payload,
      );

      expect(result).toEqual({ signalled: 1, failed: 0 });
      await expect(handle.result()).resolves.toEqual(payload);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('tracks failed signals when one matching workflow cannot be signalled', async () => {
    const storage = new BulkSignalFailureStorage();
    const engine = new Engine({ storage });
    const waitForSignalWorkflow4 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow4);

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
    const echoWorkflow2 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow2);

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
    const echoWorkflow3 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow3);
    const waitForSignalWorkflow5 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow5);

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
    const echoWorkflow4 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow4);
    const waitForSignalWorkflow6 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow6);
    const failingWorkflow2 = workflow({ name: 'failing' }).execute(failingWorkflow);
    engine.register(failingWorkflow2);

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

  it('prepares bulk delete dry runs from the terminal scan without reloading workflow states', async () => {
    const storage = new WorkflowStateGetFailureStorage();
    const engine = new Engine({ storage });
    const echoWorkflow5 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow5);

    try {
      await createCompletedWorkflow(engine, 'bulk-delete-single-scan');

      storage.workflowStateGetCount = 0;
      storage.shouldFailWorkflowStateGet = true;

      await expect(engine.deleteAll({ status: 'completed' }, { dryRun: true })).resolves.toEqual(
        expect.objectContaining({
          action: 'delete',
          dryRun: true,
          matched: 1,
        }),
      );
      expect(storage.workflowStateGetCount).toBe(0);
    } finally {
      storage.shouldFailWorkflowStateGet = false;
      await engine[Symbol.asyncDispose]();
    }
  });

  it('revalidates terminal workflows before deleting them and rejects a late non-terminal reload', async () => {
    const storage = new TerminalWorkflowReloadRaceStorage();
    const engine = new Engine({ storage });
    const echoWorkflow6 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow6);

    try {
      await createCompletedWorkflow(engine, 'bulk-delete-reload-race', ['bulk-delete-reload-race']);
      storage.workflowIdToFlip = 'bulk-delete-reload-race';

      await expect(engine.deleteAll({ tags: ['bulk-delete-reload-race'] })).rejects.toBeInstanceOf(
        BulkDeleteRequiresTerminalWorkflowsError,
      );
      expect(await engine.get('bulk-delete-reload-race')).not.toBeNull();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects invalid limit and offset values for destructive bulk operations instead of widening the filter', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const echoWorkflow6 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow6);

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
    const echoWorkflow7 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow7);

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
    const echoWorkflow8 = workflow({ name: 'echo' }).execute(echoWorkflow);
    recoveredEngine.register(echoWorkflow8);

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
    const echoWorkflow9 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow9);

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

  it('applies limit and offset to attribute-indexed bulk tag mutations after filtering', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const attributeWindowWorkflow = workflow({ name: 'attribute-window' })
      .searchAttributes({ customerId: { type: 'string' } })
      .execute(waitForSignalWorkflow);
    engine.register(attributeWindowWorkflow);

    try {
      await engine.start('attribute-window', 'first', {
        id: 'bulk-attributes-window-01',
        searchAttributes: { customerId: 'alpha' },
      });
      await engine.start('attribute-window', 'second', {
        id: 'bulk-attributes-window-02',
        searchAttributes: { customerId: 'alpha' },
      });
      await engine.start('attribute-window', 'third', {
        id: 'bulk-attributes-window-03',
        searchAttributes: { customerId: 'alpha' },
      });
      await engine.start('attribute-window', 'other', {
        id: 'bulk-attributes-window-other',
        searchAttributes: { customerId: 'beta' },
      });
      await flush();

      const result = await engine.tagAll(
        {
          attributes: [{ key: 'customerId', value: 'alpha' }],
          offset: 1,
          limit: 1,
        },
        ['selected-window'],
      );

      expect(result).toEqual({ modified: 1 });
      const firstWindowState = await engine.get('bulk-attributes-window-01');
      const secondWindowState = await engine.get('bulk-attributes-window-02');
      const thirdWindowState = await engine.get('bulk-attributes-window-03');
      const otherState = await engine.get('bulk-attributes-window-other');
      expect(firstWindowState?.tags).toBeUndefined();
      expect(secondWindowState?.tags).toEqual(['selected-window']);
      expect(thirdWindowState?.tags).toBeUndefined();
      expect(otherState?.tags).toBeUndefined();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('snapshots workflow ids before bulk tag mutation rewrites workflow state entries mid-scan', async () => {
    const storage = new BulkWorkflowReorderingScanStorage();
    const engine = new Engine({ storage });
    const echoWorkflow10 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow10);

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

  it(
    'snapshots workflow ids before bulk cancel rewrites workflow state entries between batches',
    async () => {
      const now = 1_000;
      const storage = new BulkWorkflowReorderingScanStorage();
      const workflowCount = BULK_OPERATION_BATCH_SIZE + 1;

      for (let index = 0; index < workflowCount; index++) {
        await writePendingWorkflowState(storage, `bulk-cancel-scan-${String(index)}`, now);
      }

      const result = await cancelAll(createStorageBackedCancellationInternals(storage, now), {
        status: 'pending',
      });
      const lastWorkflow = await readWorkflowState(
        storage,
        `bulk-cancel-scan-${String(workflowCount - 1)}`,
      );

      expect(result.cancelled).toBe(workflowCount);
      expect(result.failed).toBe(0);
      expect(result.errors).toEqual([]);
      expect(lastWorkflow?.status).toBe('cancelled');
    },
    { timeout: 15_000 },
  );

  it(
    'snapshots workflow ids before bulk signal rewrites workflow state entries between batches',
    async () => {
      const storage = new BulkWorkflowReorderingScanStorage();
      const engine = new Engine({ storage });
      const waitForSignalWorkflow7 = workflow({ name: 'wait-for-signal' }).execute(
        waitForSignalWorkflow,
      );
      engine.register(waitForSignalWorkflow7);

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
    },
    { timeout: 15_000 },
  );

  it('skips workflows deleted after the bulk tag snapshot instead of aborting the whole operation', async () => {
    const storage = new BulkTagDeletionDuringMutationStorage();
    const engine = new Engine({ storage });

    try {
      for (const workflowId of [
        'bulk-tags-delete-first',
        'bulk-tags-delete-second',
        'bulk-tags-delete-third',
      ]) {
        await storage.put(
          KEYS.workflow(workflowId),
          encode({
            createdAt: 1,
            id: workflowId,
            input: null,
            result: workflowId,
            startedAt: 1,
            status: 'completed',
            type: 'echo',
            updatedAt: 1,
            versionTuple: { workflowVersion: '1' },
          } satisfies WorkflowState),
        );
      }
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

  it(
    'snapshots all matching workflow ids before the first bulk cancellation mutation',
    async () => {
      const now = 1_000;
      const storage = new BulkBatchTrackingStorage();
      const workflowCount = BULK_OPERATION_BATCH_SIZE + 5;

      for (let index = 0; index < workflowCount; index++) {
        await writePendingWorkflowState(storage, `bulk-batch-${String(index)}`, now);
      }

      storage.shouldTrackBulkMutations = true;

      const result = await cancelAll(createStorageBackedCancellationInternals(storage, now), {
        status: 'pending',
      });

      expect(result.cancelled).toBe(workflowCount);
      expect(storage.firstMutationSeenAfterScanningCount).toBe(workflowCount);
    },
    { timeout: 15_000 },
  );

  it('previews bulk cancellation without mutating matching workflows', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const waitForSignalWorkflow8 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow8);

    try {
      await engine.start('wait-for-signal', 'first', {
        id: 'bulk-preview-selected-a',
        tags: ['preview'],
      });
      await engine.start('wait-for-signal', 'second', {
        id: 'bulk-preview-selected-b',
        tags: ['preview'],
      });
      await waitForWorkflowStatusCount(engine, 'running', 2, 10_000);

      const preview = await engine.cancelAll(
        { tags: ['preview'] },
        { dryRun: true, requestId: 'bulk-preview-request' },
      );

      expect(preview).toEqual(
        expect.objectContaining({
          dryRun: true,
          action: 'cancel',
          matched: 2,
          requestId: 'bulk-preview-request',
          sampleWorkflowIds: ['bulk-preview-selected-a', 'bulk-preview-selected-b'],
          confirmationToken: expect.stringMatching(/^bulk:/),
        }),
      );
      expect(preview.scope).toEqual(
        expect.objectContaining({
          matched: 2,
          statuses: ['running'],
          workflowTypes: ['wait-for-signal'],
        }),
      );
      const firstPreviewedWorkflow = await engine.get('bulk-preview-selected-a');
      const secondPreviewedWorkflow = await engine.get('bulk-preview-selected-b');
      const firstPreviewedWorkflowStatus = firstPreviewedWorkflow?.status;
      const secondPreviewedWorkflowStatus = secondPreviewedWorkflow?.status;
      if (firstPreviewedWorkflowStatus === undefined) {
        throw new Error('Expected first previewed workflow to remain in storage');
      }
      if (secondPreviewedWorkflowStatus === undefined) {
        throw new Error('Expected second previewed workflow to remain in storage');
      }
      expect(['pending', 'running']).toContain(firstPreviewedWorkflowStatus);
      expect(['pending', 'running']).toContain(secondPreviewedWorkflowStatus);

      await engine.cancel('bulk-preview-selected-a');
      await engine.cancel('bulk-preview-selected-b');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('previews bulk cancellation with attribute any-of filters', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const regionWorkflow = workflow({ name: 'bulk-attribute-preview' })
      .searchAttributes({ region: { type: 'string' }, tier: { type: 'string' } })
      .execute(waitForSignalWorkflow);
    engine.register(regionWorkflow);

    try {
      await engine.start('bulk-attribute-preview', 'east', {
        id: 'bulk-attribute-preview-east',
        searchAttributes: { region: 'us-east', tier: 'active' },
      });
      await engine.start('bulk-attribute-preview', 'west', {
        id: 'bulk-attribute-preview-west',
        searchAttributes: { region: 'eu-west', tier: 'active' },
      });
      await engine.start('bulk-attribute-preview', 'south', {
        id: 'bulk-attribute-preview-south',
        searchAttributes: { region: 'ap-south', tier: 'active' },
      });
      await waitForWorkflowStatusCount(engine, 'running', 3, 10_000);

      const preview = await engine.cancelAll(
        {
          type: 'bulk-attribute-preview',
          attributes: [
            { key: 'region', value: ['us-east', 'eu-west'] },
            { key: 'tier', value: 'active' },
          ],
        },
        { dryRun: true, requestId: 'bulk-attribute-preview-request' },
      );

      expect(preview).toEqual(
        expect.objectContaining({
          dryRun: true,
          action: 'cancel',
          matched: 2,
          requestId: 'bulk-attribute-preview-request',
          sampleWorkflowIds: ['bulk-attribute-preview-east', 'bulk-attribute-preview-west'],
          confirmationToken: expect.stringMatching(/^bulk:/),
        }),
      );
      expect(preview.scope.filter).toEqual(
        expect.objectContaining({
          type: 'bulk-attribute-preview',
          attributes: expect.arrayContaining([
            { key: 'region', value: ['us-east', 'eu-west'] },
            { key: 'tier', value: 'active' },
          ]),
        }),
      );
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects stale bulk confirmation tokens when the matched workflow set changes', async () => {
    const now = 1_000;
    const engine = new Engine({ getNow: () => now });
    const echoWorkflow14 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow14);

    try {
      await engine.start('echo', 'first', {
        id: 'bulk-stale-selected-a',
        tags: ['stale-token'],
        startAt: now + 60_000,
      });

      const preview = await engine.cancelAll({ tags: ['stale-token'] }, { dryRun: true });

      await engine.start('echo', 'second', {
        id: 'bulk-stale-selected-b',
        tags: ['stale-token'],
        startAt: now + 60_000,
      });

      await expect(
        engine.cancelAll(
          { tags: ['stale-token'] },
          { confirmationToken: preview.confirmationToken },
        ),
      ).rejects.toThrow('Bulk confirmation token does not match the current dry-run scope');
      const firstStaleWorkflow = await engine.get('bulk-stale-selected-a');
      const secondStaleWorkflow = await engine.get('bulk-stale-selected-b');
      expect(firstStaleWorkflow?.status).toBe('pending');
      expect(secondStaleWorkflow?.status).toBe('pending');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('accepts confirmation tokens after workflow progress keeps the same bulk scope', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const waitForSignalWorkflow9 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow9);

    try {
      const handle = await engine.start('wait-for-signal', 'first', {
        id: 'bulk-stable-token-progress',
        tags: ['stable-token'],
      });
      await waitForWorkflowStatus(engine, handle.id, 'running');

      const preview = await engine.cancelAll({ tags: ['stable-token'] }, { dryRun: true });
      const storedWorkflowBytes = await storage.get(KEYS.workflow(handle.id));
      if (storedWorkflowBytes === null) {
        throw new Error('Expected stored workflow state for stable bulk confirmation token test');
      }
      const storedWorkflowState = decode(storedWorkflowBytes) as WorkflowState;
      await storage.put(
        KEYS.workflow(handle.id),
        encode({
          ...storedWorkflowState,
          updatedAt: storedWorkflowState.updatedAt + 1_000,
        } satisfies WorkflowState),
      );

      await expect(
        engine.cancelAll(
          { tags: ['stable-token'] },
          { confirmationToken: preview.confirmationToken },
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          cancelled: 1,
          failed: 0,
          errors: [],
        }),
      );

      const cancelledWorkflow = await engine.get(handle.id);
      expect(cancelledWorkflow?.status).toBe('cancelled');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects signal confirmation tokens when the action payload changes', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const waitForSignalWorkflow10 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow10);

    try {
      const handle = await engine.start('wait-for-signal', 'first', {
        id: 'bulk-stale-signal-payload',
        tags: ['stale-signal-token'],
      });
      await waitForWorkflowStatus(engine, handle.id, 'running');

      const preview = await engine.signalAll(
        { tags: ['stale-signal-token'] },
        'continue',
        'approved',
        { dryRun: true },
      );

      await expect(
        engine.signalAll({ tags: ['stale-signal-token'] }, 'continue', 'changed', {
          confirmationToken: preview.confirmationToken,
        }),
      ).rejects.toThrow('Bulk confirmation token does not match the current dry-run scope');
      const workflowState = await engine.get(handle.id);
      expect(workflowState?.status).toBe('running');

      await engine.signal(handle.id, 'continue', 'cleanup');
      await expect(handle.result()).resolves.toBe('first:cleanup');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects tag confirmation tokens when the action tags or operation change', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const echoWorkflow15 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow15);

    try {
      await createCompletedWorkflow(engine, 'bulk-stale-tag-action', ['selected']);

      const preview = await engine.tagAll({ tags: ['selected'] }, ['archived'], { dryRun: true });

      await expect(
        engine.tagAll({ tags: ['selected'] }, ['different'], {
          confirmationToken: preview.confirmationToken,
        }),
      ).rejects.toThrow('Bulk confirmation token does not match the current dry-run scope');
      await expect(
        engine.untagAll({ tags: ['selected'] }, ['archived'], {
          confirmationToken: preview.confirmationToken,
        }),
      ).rejects.toThrow('Bulk confirmation token does not match the current dry-run scope');

      const workflowState = await engine.get('bulk-stale-tag-action');
      expect(workflowState?.tags).toEqual(['selected']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('persists durable audit records for committed bulk actions', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, getNow: () => 42_000 });
    const waitForSignalWorkflow11 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow11);

    try {
      await engine.start('wait-for-signal', 'first', {
        id: 'bulk-audit-selected-a',
        tags: ['audit'],
      });
      await engine.start('wait-for-signal', 'second', {
        id: 'bulk-audit-selected-b',
        tags: ['audit'],
      });
      await waitForWorkflowStatusCount(engine, 'running', 2, 10_000);

      const preview = await engine.cancelAll(
        { tags: ['audit'] },
        { dryRun: true, requestId: 'bulk-audit-request' },
      );
      const result = await engine.cancelAll(
        { tags: ['audit'] },
        {
          confirmationToken: preview.confirmationToken,
          principal: {
            method: 'api-key',
            subject: 'operator-1',
          },
          requestId: 'bulk-audit-request',
        },
      );

      expect(result.cancelled).toBe(2);
      expect(result.auditEvent).toEqual(
        expect.objectContaining({
          type: 'bulk-operation:audit',
          action: 'cancel',
          affectedCount: 2,
          requestId: 'bulk-audit-request',
          principal: {
            method: 'api-key',
            subject: 'operator-1',
          },
          sampleWorkflowIds: ['bulk-audit-selected-a', 'bulk-audit-selected-b'],
        }),
      );

      const storedAuditRecords = [];
      for await (const [, value] of storage.scan(KEYS.bulkOperationAuditPrefix())) {
        storedAuditRecords.push(decode(value));
      }

      expect(storedAuditRecords).toEqual([
        expect.objectContaining({
          type: 'bulk-operation:audit',
          action: 'cancel',
          affectedCount: 2,
          requestId: 'bulk-audit-request',
        }),
      ]);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
