import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { serializeCheckpoint } from '../checkpoint/serialization.ts';
import { decode, encode } from '../codec.ts';
import type { Checkpoint, SearchAttributeValue, WorkflowState } from '../types.ts';
import { retryFailedAll } from './bulk-operations.ts';

function createFailedState(
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: 1_000,
    error: 'failed',
    id: workflowId,
    input: { workflowId },
    startedAt: 1_000,
    status: 'failed',
    type: 'retryable',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

function createCheckpoint(
  workflowId: string,
  searchAttributes: Record<string, SearchAttributeValue> = {},
): Checkpoint {
  return {
    accumulatedResults: [],
    createdAt: 1_000,
    locals: {},
    schemaVersion: 2,
    searchAttributes,
    step: 0,
    version: '1',
    workflowId,
  };
}

function createInternals(storage: MemoryStorage) {
  return {
    deposed: false,
    engine: {
      resume: mock(async () => {}),
      start: mock(async () => ({ id: 'started' })),
    },
    leaseManager: null,
    options: { getNow: () => 2_000, ownershipMode: 'none' },
    registrations: new Map([
      [
        'retryable',
        {
          handler: async function* () {},
          version: '1',
        },
      ],
    ]),
    scheduler: {
      cancel: mock(async () => {}),
    },
    storage,
    workflowStateWriteChains: new Map(),
    scheduleStateOperationChains: new Map(),
  } as never;
}

describe('bulk retry direct coverage', () => {
  it('reactivates failed checkpointed workflows, restoring attributes and cancelling terminal cleanup timers', async () => {
    const workflowId = 'retry-direct-success';
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    const observedInternals = internals as {
      engine: { resume: ReturnType<typeof mock> };
      scheduler: { cancel: ReturnType<typeof mock> };
    };

    await storage.put(
      KEYS.workflow(workflowId),
      encode(
        createFailedState(workflowId, {
          executionDeadline: 9_999,
          terminalCleanupToken: 'cleanup-token',
        }),
      ),
    );
    await storage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId, { retried: true })),
    );
    await storage.put(KEYS.attribute(workflowId), encode({ stale: 'value' }));

    const result = await retryFailedAll(internals, { status: 'failed' });

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(observedInternals.engine.resume).toHaveBeenCalledWith(workflowId);
    expect(observedInternals.scheduler.cancel).toHaveBeenCalledWith(
      'terminal-cleanup:preserve-output:cleanup-token',
      workflowId,
    );
    expect(decode((await storage.get(KEYS.attribute(workflowId)))!)).toEqual({ retried: true });
    const deadlineKeys: string[] = [];
    for await (const [key] of storage.scan('wf-deadline:')) {
      deadlineKeys.push(key);
    }
    expect(deadlineKeys).toEqual([`wf-deadline:0000000000009999:deadline%3A${workflowId}`]);
  });

  it('reports missing and non-failed workflows that disappear or change after snapshotting', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'retry-direct-missing';
    storage.scan = async function* (prefix: string) {
      if (prefix === 'wf:') {
        yield [KEYS.workflow(workflowId), encode(createFailedState(workflowId))];
        return;
      }
      yield* MemoryStorage.prototype.scan.call(this, prefix);
    };

    const missingResult = await retryFailedAll(createInternals(storage), { status: 'failed' });
    expect(missingResult).toEqual({
      retried: 0,
      failed: 1,
      errors: [{ id: workflowId, error: 'Workflow no longer exists' }],
    });

    const storage2 = new MemoryStorage();
    storage2.scan = async function* (prefix: string) {
      if (prefix === 'wf:') {
        yield [KEYS.workflow(workflowId), encode(createFailedState(workflowId))];
        return;
      }
      yield* MemoryStorage.prototype.scan.call(this, prefix);
    };
    storage2.get = async (key) =>
      key === KEYS.workflow(workflowId)
        ? encode(createFailedState(workflowId, { status: 'running' }))
        : MemoryStorage.prototype.get.call(storage2, key);

    const changedResult = await retryFailedAll(createInternals(storage2), { status: 'failed' });
    expect(changedResult).toEqual({
      retried: 0,
      failed: 1,
      errors: [{ id: workflowId, error: 'Workflow is running, not failed' }],
    });
  });

  it('reports checkpointed workflows that disappear, lose their checkpoint, or lack a registration', async () => {
    const workflowId = 'retry-direct-checkpoint-error';

    const missingStateStorage = new MemoryStorage();
    missingStateStorage.scan = async function* (prefix: string) {
      if (prefix === 'wf:') {
        yield [KEYS.workflow(workflowId), encode(createFailedState(workflowId))];
        return;
      }
      yield* MemoryStorage.prototype.scan.call(this, prefix);
    };
    await missingStateStorage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );
    let missingStateWorkflowReadCount = 0;
    missingStateStorage.get = async (key) => {
      if (key === KEYS.workflow(workflowId)) {
        missingStateWorkflowReadCount += 1;
        return missingStateWorkflowReadCount === 1 ? encode(createFailedState(workflowId)) : null;
      }
      return MemoryStorage.prototype.get.call(missingStateStorage, key);
    };
    await expect(
      retryFailedAll(createInternals(missingStateStorage), { status: 'failed' }),
    ).resolves.toEqual({
      retried: 0,
      failed: 1,
      errors: [{ id: workflowId, error: 'Workflow no longer exists' }],
    });

    const missingCheckpointStorage = new MemoryStorage();
    missingCheckpointStorage.scan = async function* (prefix: string) {
      if (prefix === 'wf:') {
        yield [KEYS.workflow(workflowId), encode(createFailedState(workflowId))];
        return;
      }
      yield* MemoryStorage.prototype.scan.call(this, prefix);
    };
    let checkpointReadCount = 0;
    missingCheckpointStorage.get = async (key) => {
      if (key === KEYS.workflow(workflowId)) {
        return encode(createFailedState(workflowId));
      }
      if (key === KEYS.checkpoint(workflowId)) {
        checkpointReadCount += 1;
        return checkpointReadCount === 1 ? serializeCheckpoint(createCheckpoint(workflowId)) : null;
      }
      return MemoryStorage.prototype.get.call(missingCheckpointStorage, key);
    };
    await expect(
      retryFailedAll(createInternals(missingCheckpointStorage), { status: 'failed' }),
    ).resolves.toEqual({
      retried: 0,
      failed: 1,
      errors: [{ id: workflowId, error: 'Checkpoint no longer exists' }],
    });

    const changedStatusStorage = new MemoryStorage();
    changedStatusStorage.scan = async function* (prefix: string) {
      if (prefix === 'wf:') {
        yield [KEYS.workflow(workflowId), encode(createFailedState(workflowId))];
        return;
      }
      yield* MemoryStorage.prototype.scan.call(this, prefix);
    };
    await changedStatusStorage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );
    let changedStatusWorkflowReadCount = 0;
    changedStatusStorage.get = async (key) => {
      if (key === KEYS.workflow(workflowId)) {
        changedStatusWorkflowReadCount += 1;
        return changedStatusWorkflowReadCount === 1
          ? encode(createFailedState(workflowId))
          : encode(createFailedState(workflowId, { status: 'running' }));
      }
      return MemoryStorage.prototype.get.call(changedStatusStorage, key);
    };
    await expect(
      retryFailedAll(createInternals(changedStatusStorage), { status: 'failed' }),
    ).resolves.toEqual({
      retried: 0,
      failed: 1,
      errors: [{ id: workflowId, error: 'Workflow is running, not failed' }],
    });

    const missingRegistrationStorage = new MemoryStorage();
    missingRegistrationStorage.scan = async function* (prefix: string) {
      if (prefix === 'wf:') {
        yield [KEYS.workflow(workflowId), encode(createFailedState(workflowId))];
        return;
      }
      yield* MemoryStorage.prototype.scan.call(this, prefix);
    };
    await missingRegistrationStorage.put(
      KEYS.workflow(workflowId),
      encode(createFailedState(workflowId)),
    );
    await missingRegistrationStorage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );

    const missingRegistrationInternals = createInternals(missingRegistrationStorage);
    (missingRegistrationInternals as { registrations: Map<string, unknown> }).registrations =
      new Map();

    await expect(
      retryFailedAll(missingRegistrationInternals, { status: 'failed' }),
    ).resolves.toEqual({
      retried: 0,
      failed: 1,
      errors: [
        {
          id: workflowId,
          error: `No workflow registered with name "retryable" (needed to retry "${workflowId}")`,
        },
      ],
    });
  });

  it('surfaces repeated workflow-concurrency admission conflicts for checkpoint retries', async () => {
    const workflowId = 'retry-direct-concurrency-conflict';
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflow(workflowId), encode(createFailedState(workflowId)));
    await storage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );
    storage.conditionalBatch = async () => false;

    const internals = createInternals(storage);
    (internals as { registrations: Map<string, unknown> }).registrations.set('retryable', {
      concurrency: { max: 1 },
      handler: async function* () {},
      version: '1',
    });

    await expect(retryFailedAll(internals, { status: 'failed' })).resolves.toEqual({
      retried: 0,
      failed: 1,
      errors: [
        {
          id: workflowId,
          error: `Workflow concurrency admission for "wf-concurrency:retryable:retryable" changed too many times while retrying failed workflow "${workflowId}"`,
        },
      ],
    });
  });
});
