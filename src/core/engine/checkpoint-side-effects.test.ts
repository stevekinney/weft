import { describe, expect, it } from 'bun:test';

import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createCheckpoint, serializeCheckpoint } from '../checkpoint.ts';
import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { EMPTY_EVENT_HEAD } from '../event-log.ts';
import type { Checkpoint } from '../types.ts';
import {
  buildActivityReconciliationReference,
  type ActivityReconciliationRecord,
} from './activity-reconciliation.ts';
import { rememberCommittedCheckpointBytes } from './checkpoint-commit-snapshots.ts';
import { persistCheckpoint } from './checkpoint-io.ts';
import type { EngineInternals } from './internals.ts';
import { executeActivityOperationResult } from './operations-activity.ts';
import {
  processParallelOperation,
  processRaceOperation,
  processWaitSignalOperation,
} from './operations-coordination.ts';
import { executeSubOperation } from './sub-operation.ts';

class FailingConditionalBatchStorage extends MemoryStorage {
  conditionalBatchCallCount = 0;

  constructor(readonly failOnCall: number) {
    super();
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.conditionalBatchCallCount++;
    if (this.conditionalBatchCallCount === this.failOnCall) {
      return false;
    }
    return await super.conditionalBatch(conditions, operations);
  }
}

const checkpointOperation: ContextOperationRequest = {
  type: 'sleep',
  operationId: 'checkpoint-side-effect',
  duration: 1_000,
  scheduledFireAt: 2_000,
};

function createEngineInternals(storage: MemoryStorage, checkpoint: Checkpoint): EngineInternals {
  return {
    abortController: new AbortController(),
    activityRegistriesByWorkflow: new Map(),
    activityRegistry: { resolve: () => undefined },
    activityWorkerDispatcher: null,
    checkpoints: new Map([[checkpoint.workflowId, checkpoint]]),
    conditionWaiters: new Map(),
    deliveredPendingUpdateIds: new Map(),
    eventLogHeads: new Map([[checkpoint.workflowId, EMPTY_EVENT_HEAD]]),
    heartbeatDetails: new Map(),
    inlineStrategy: null,
    lastHeartbeatDetailsByStep: new Map(),
    options: {
      checkpointHistory: 0,
      checkpointSizeWarningThreshold: Number.POSITIVE_INFINITY,
      getNow: () => 2_000,
      historyPolicy: { maxEvents: null, retentionWindow: null },
      payloadSizePolicy: { maxBytes: null },
    },
    pendingAtomicWorkflowCommitSideEffects: new Map(),
    pendingTimelineEntries: new Map(),
    signalWaiters: new Map<string, () => void>(),
    signalWaitersByWorkflow: new Map(),
    storage,
    workflowFeedListeners: new Map(),
    workflowTypeByWorkflowId: new Map(),
    workflowVersionTuples: new Map(),
  } as unknown as EngineInternals;
}

function createPersistCallbacks() {
  return {
    appendTimelineBatchOperations: (
      workflowId: string,
      _operation: ContextOperationRequest,
      step: number,
      timestamp: number,
      operations: BatchOperation[],
    ) => {
      operations.push({
        type: 'put',
        key: KEYS.timeline(workflowId, step),
        value: new Uint8Array([step]),
      });
      return { startedAt: timestamp, entry: { step } as never };
    },
    dispatchEvent: () => {},
    enforceHistoryCircuitBreaker: async () => {},
    pruneCheckpointHistory: async () => {},
    swallowPromiseRejection: async (promise: Promise<void>) => {
      await promise;
    },
    validateAttributeValueSizes: () => {},
  };
}

async function seedRecoveredCheckpoint(
  storage: MemoryStorage,
  internals: EngineInternals,
  checkpoint: Checkpoint,
): Promise<void> {
  const serialized = serializeCheckpoint(checkpoint);
  await storage.put(KEYS.checkpoint(checkpoint.workflowId), serialized);
  rememberCommittedCheckpointBytes(internals, checkpoint.workflowId, serialized);
}

async function expectCheckpointCommitFailure(
  internals: EngineInternals,
  checkpoint: Checkpoint,
): Promise<void> {
  const nextCheckpoint = {
    ...checkpoint,
    step: checkpoint.step + 1,
    createdAt: checkpoint.createdAt + 1_000,
  };
  const bytes = serializeCheckpoint(nextCheckpoint);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  await expect(
    persistCheckpoint(
      internals,
      checkpoint.workflowId,
      checkpointOperation,
      buffer,
      createPersistCallbacks(),
    ),
  ).rejects.toThrow('lost its CAS race');
}

function createSubOperationCallbacks() {
  return {
    createActivityOperationCallbacks: () => ({
      getComposedActivityInterceptor: () => null,
      getComposedWorkflowInterceptor: () => null,
      finalizePendingTimelineEntry: () => {},
      feedOperationResult: () => {},
      runOperationWithResult: async () => {},
    }),
    createChildWorkflowOperationCallbacks: () => ({}),
    createCoordinationOperationCallbacks: () => ({}),
    createStateOperationCallbacks: () => ({}),
  } as unknown as Parameters<typeof executeSubOperation>[3];
}

describe('atomic workflow commit side effects', () => {
  it('keeps a top-level buffered signal when the checkpoint batch fails', async () => {
    const storage = new FailingConditionalBatchStorage(1);
    const checkpoint = createCheckpoint('atomic-top-level-signal', '1', 1_000);
    const internals = createEngineInternals(storage, checkpoint);
    await seedRecoveredCheckpoint(storage, internals, checkpoint);
    const signalKey = KEYS.signal(checkpoint.workflowId, 'release', 'signal-1');
    await storage.put(signalKey, encode('payload'));

    let completedPayload: unknown;
    await processWaitSignalOperation(
      internals,
      checkpoint.workflowId,
      { type: 'wait-signal', operationId: 'wait-release', signalName: 'release' },
      {
        completeOperation: (_workflowId, value) => {
          completedPayload = value;
        },
      },
    );

    expect(completedPayload).toBe('payload');
    await expectCheckpointCommitFailure(internals, checkpoint);
    expect(await storage.get(signalKey)).toEqual(encode('payload'));
  });

  it('keeps a race winning signal when the checkpoint batch fails', async () => {
    const storage = new FailingConditionalBatchStorage(1);
    const checkpoint = createCheckpoint('atomic-race-signal', '1', 1_000);
    const internals = createEngineInternals(storage, checkpoint);
    await seedRecoveredCheckpoint(storage, internals, checkpoint);
    const signalKey = KEYS.signal(checkpoint.workflowId, 'release', 'signal-1');
    await storage.put(signalKey, encode('race-payload'));

    let result: unknown;
    await processRaceOperation(
      internals,
      checkpoint.workflowId,
      {
        type: 'race',
        operationId: 'race-release',
        operations: [{ type: 'wait-signal', operationId: 'race-release:0', signalName: 'release' }],
      },
      {
        executeSubOperation: (workflowId, operation, signal) =>
          executeSubOperation(
            internals,
            workflowId,
            operation,
            createSubOperationCallbacks(),
            signal,
          ),
        runOperationWithResult: async (_workflowId, _operation, execute) => {
          result = await execute();
        },
      },
    );

    expect(result).toBe('race-payload');
    await expectCheckpointCommitFailure(internals, checkpoint);
    expect(await storage.get(signalKey)).toEqual(encode('race-payload'));
  });

  it('keeps an all branch signal when the checkpoint batch fails', async () => {
    const storage = new FailingConditionalBatchStorage(1);
    const checkpoint = createCheckpoint('atomic-all-signal', '1', 1_000);
    const internals = createEngineInternals(storage, checkpoint);
    await seedRecoveredCheckpoint(storage, internals, checkpoint);
    const signalKey = KEYS.signal(checkpoint.workflowId, 'release', 'signal-1');
    await storage.put(signalKey, encode('all-payload'));

    let result: unknown;
    await processParallelOperation(
      internals,
      checkpoint.workflowId,
      {
        type: 'parallel',
        operationId: 'all-release',
        step: 0,
        operations: [{ type: 'wait-signal', operationId: 'all-release:0', signalName: 'release' }],
      },
      {
        executeSubOperation: (workflowId, operation, signal) =>
          executeSubOperation(
            internals,
            workflowId,
            operation,
            createSubOperationCallbacks(),
            signal,
          ),
        runOperationWithResult: async (_workflowId, _operation, execute) => {
          result = await execute();
        },
      },
    );

    expect(result).toEqual(['all-payload']);
    await expectCheckpointCommitFailure(internals, checkpoint);
    expect(await storage.get(signalKey)).toEqual(encode('all-payload'));
  });

  it('keeps an idempotent activity reconciliation record started when the checkpoint batch fails', async () => {
    const storage = new FailingConditionalBatchStorage(2);
    const checkpoint = createCheckpoint('atomic-activity-reconciliation', '1', 1_000);
    const internals = createEngineInternals(storage, checkpoint);
    await seedRecoveredCheckpoint(storage, internals, checkpoint);
    const operation = {
      type: 'activity',
      operationId: 'activity-step',
      activityName: 'charge-card',
      fn: async () => 'charged',
      input: { amount: 100 },
      options: { idempotencyKey: 'charge-123' },
    } satisfies Extract<ContextOperationRequest, { type: 'activity' }>;

    const result = await executeActivityOperationResult(
      internals,
      checkpoint.workflowId,
      operation,
      {
        getComposedActivityInterceptor: () => null,
        getComposedWorkflowInterceptor: () => null,
        finalizePendingTimelineEntry: () => {},
        feedOperationResult: () => {},
        runOperationWithResult: async () => {},
      },
    );

    expect(result).toBe('charged');
    await expectCheckpointCommitFailure(internals, checkpoint);
    const reference = await buildActivityReconciliationReference(
      checkpoint.workflowId,
      operation.activityName,
      operation.options.idempotencyKey,
    );
    const recordBytes = await storage.get(reference.key);
    expect(recordBytes).not.toBeNull();
    const record = decode(recordBytes!) as ActivityReconciliationRecord;
    expect(record.status).toBe('started');
  });
});
