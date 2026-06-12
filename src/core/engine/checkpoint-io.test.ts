import { describe, expect, it } from 'bun:test';

import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
  type StorageCapabilities,
} from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createCheckpoint, serializeCheckpoint } from '../checkpoint.ts';
import type { ContextOperationRequest } from '../context.ts';
import { EMPTY_EVENT_HEAD } from '../event-log.ts';
import type { Checkpoint } from '../types.ts';
import { rememberCommittedCheckpointBytes } from './checkpoint-commit-snapshots.ts';
import { persistCheckpoint } from './checkpoint-io.ts';
import type { EngineInternals } from './internals.ts';
import { cleanupTerminalWorkflowMemory } from './termination/cleanup.ts';

class NoConditionalBatchStorage extends MemoryStorage {
  batchCallCount = 0;
  conditionalBatchCallCount = 0;

  override capabilities(): StorageCapabilities {
    return { ...super.capabilities(), conditionalBatch: false };
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    this.batchCallCount++;
    await super.batch(operations);
  }

  override async conditionalBatch(
    _conditions: ConditionalBatchCondition[],
    _operations: BatchOperation[],
  ): Promise<boolean> {
    this.conditionalBatchCallCount++;
    throw new Error('conditionalBatch should not be called when capability is false');
  }
}

class CountingConditionalBatchStorage extends MemoryStorage {
  conditionalBatchCallCount = 0;
  mismatchedConditionCount = 0;

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.conditionalBatchCallCount++;
    const applied = await super.conditionalBatch(conditions, operations);
    if (!applied) {
      this.mismatchedConditionCount++;
    }
    return applied;
  }
}

const checkpointOperation: ContextOperationRequest = {
  type: 'sleep',
  operationId: 'sleep-operation',
  duration: 1_000,
  scheduledFireAt: 2_000,
};

function createPersistCallbacks() {
  return {
    appendTimelineBatchOperations: (
      _workflowId: string,
      _operation: ContextOperationRequest,
      step: number,
      timestamp: number,
      operations: BatchOperation[],
    ) => {
      operations.push({
        type: 'put',
        key: KEYS.timeline('checkpoint-workflow', step),
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

function createCheckpointInternals(
  storage: MemoryStorage,
  checkpoint: Checkpoint,
): EngineInternals {
  return {
    checkpoints: new Map([[checkpoint.workflowId, checkpoint]]),
    eventLogHeads: new Map([[checkpoint.workflowId, EMPTY_EVENT_HEAD]]),
    inlineStrategy: null,
    options: {
      checkpointHistory: 10,
      checkpointSizeWarningThreshold: Number.POSITIVE_INFINITY,
      getNow: () => 1_000,
      historyPolicy: { maxEvents: null, retentionWindow: null },
    },
    pendingTimelineEntries: new Map(),
    storage,
    workflowFeedListeners: new Map(),
    workflowVersionTuples: new Map(),
  } as never;
}

async function seedCheckpoint(storage: MemoryStorage, checkpoint: Checkpoint): Promise<void> {
  await storage.put(KEYS.checkpoint(checkpoint.workflowId), serializeCheckpoint(checkpoint));
}

function rememberRecoveredCheckpoint(internals: EngineInternals, checkpoint: Checkpoint): void {
  rememberCommittedCheckpointBytes(
    internals,
    checkpoint.workflowId,
    serializeCheckpoint(checkpoint),
  );
}

function createCleanupInternals(storage: MemoryStorage, checkpoint: Checkpoint): EngineInternals {
  return {
    ...createCheckpointInternals(storage, checkpoint),
    cancelHandlersByWorkflow: new Map(),
    heartbeatDetails: new Map(),
    lastHeartbeatDetailsByStep: new Map(),
    pendingAsyncActivities: new Map(),
    parkedInlineWorkflows: new Set(),
    reviewEscalationHandlers: new Map(),
    reviewTimerIds: new Map(),
    reviewWaiters: new Map(),
    reviewWaitersByWorkflow: new Map(),
    scheduler: { cancel: async () => {} },
    signalWaiters: new Map(),
    signalWaitersByWorkflow: new Map(),
    sleepResolvers: new Map(),
    sleepResolversByWorkflow: new Map(),
    updateWaiters: new Map(),
    updateWaitersByWorkflow: new Map(),
    workflowHeaders: new Map(),
    workflowServices: new Map(),
    workflowNestingDepths: new Map(),
    workflowReviewIds: new Map(),
    workflowsNeedingTerminalCleanup: new Set(),
    workflowTypeByWorkflowId: new Map(),
  } as never;
}

function serializeCheckpointBuffer(checkpoint: Checkpoint): ArrayBuffer {
  const bytes = serializeCheckpoint(checkpoint);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

describe('checkpoint commit compare-and-swap guard', () => {
  it('rejects a stale second checkpoint commit on conditional-batch storage', async () => {
    const storage = new CountingConditionalBatchStorage();
    const initialCheckpoint = createCheckpoint('checkpoint-workflow', '1', 1_000);
    const firstOwner = createCheckpointInternals(storage, initialCheckpoint);
    const staleSecondOwner = createCheckpointInternals(storage, initialCheckpoint);
    await seedCheckpoint(storage, initialCheckpoint);
    rememberRecoveredCheckpoint(firstOwner, initialCheckpoint);
    rememberRecoveredCheckpoint(staleSecondOwner, initialCheckpoint);

    const firstNext = { ...initialCheckpoint, step: 1, createdAt: 2_000 };
    const secondNext = { ...initialCheckpoint, step: 1, createdAt: 3_000 };

    await persistCheckpoint(
      firstOwner,
      initialCheckpoint.workflowId,
      checkpointOperation,
      serializeCheckpointBuffer(firstNext),
      createPersistCallbacks(),
    );

    await expect(
      persistCheckpoint(
        staleSecondOwner,
        initialCheckpoint.workflowId,
        checkpointOperation,
        serializeCheckpointBuffer(secondNext),
        createPersistCallbacks(),
      ),
    ).rejects.toThrow('Checkpoint commit for workflow "checkpoint-workflow" lost its CAS race');

    const committed = await storage.get(KEYS.checkpoint(initialCheckpoint.workflowId));
    expect(committed).toEqual(serializeCheckpoint(firstNext));
    expect(storage.conditionalBatchCallCount).toBe(2);
    expect(storage.mismatchedConditionCount).toBe(1);
  });

  it('leaves in-memory checkpoint state unchanged when the CAS commit loses', async () => {
    const storage = new CountingConditionalBatchStorage();
    const initialCheckpoint = createCheckpoint('checkpoint-workflow', '1', 1_000);
    const firstOwner = createCheckpointInternals(storage, initialCheckpoint);
    const staleSecondOwner = createCheckpointInternals(storage, initialCheckpoint);
    await seedCheckpoint(storage, initialCheckpoint);
    rememberRecoveredCheckpoint(firstOwner, initialCheckpoint);
    rememberRecoveredCheckpoint(staleSecondOwner, initialCheckpoint);

    await persistCheckpoint(
      firstOwner,
      initialCheckpoint.workflowId,
      checkpointOperation,
      serializeCheckpointBuffer({ ...initialCheckpoint, step: 1, createdAt: 2_000 }),
      createPersistCallbacks(),
    );

    await expect(
      persistCheckpoint(
        staleSecondOwner,
        initialCheckpoint.workflowId,
        checkpointOperation,
        serializeCheckpointBuffer({ ...initialCheckpoint, step: 1, createdAt: 3_000 }),
        createPersistCallbacks(),
      ),
    ).rejects.toThrow('lost its CAS race');

    expect(staleSecondOwner.checkpoints.get(initialCheckpoint.workflowId)).toEqual(
      initialCheckpoint,
    );
    expect(staleSecondOwner.eventLogHeads.get(initialCheckpoint.workflowId)).toEqual(
      EMPTY_EVENT_HEAD,
    );
  });

  it('documents single-owner-only storage by allowing normal commits without conditionalBatch', async () => {
    const storage = new NoConditionalBatchStorage();
    const initialCheckpoint = createCheckpoint('checkpoint-workflow', '1', 1_000);
    const internals = createCheckpointInternals(storage, initialCheckpoint);
    await seedCheckpoint(storage, initialCheckpoint);
    rememberRecoveredCheckpoint(internals, initialCheckpoint);

    const nextCheckpoint = { ...initialCheckpoint, step: 1, createdAt: 2_000 };
    await persistCheckpoint(
      internals,
      initialCheckpoint.workflowId,
      checkpointOperation,
      serializeCheckpointBuffer(nextCheckpoint),
      createPersistCallbacks(),
    );

    expect(await storage.get(KEYS.checkpoint(initialCheckpoint.workflowId))).toEqual(
      serializeCheckpoint(nextCheckpoint),
    );
    expect(internals.checkpoints.get(initialCheckpoint.workflowId)).toEqual(nextCheckpoint);
    expect(storage.batchCallCount).toBe(1);
    expect(storage.conditionalBatchCallCount).toBe(0);
  });

  it('forgets recovered checkpoint bytes when terminal cleanup releases a workflow id', async () => {
    const storage = new CountingConditionalBatchStorage();
    const oldCheckpoint = createCheckpoint('checkpoint-workflow', '1', 1_000);
    const internals = createCleanupInternals(storage, oldCheckpoint);
    rememberRecoveredCheckpoint(internals, oldCheckpoint);

    cleanupTerminalWorkflowMemory(internals, oldCheckpoint.workflowId, {
      swallowPromiseRejection: async (promise) => {
        await promise;
      },
    });

    const newCheckpoint = createCheckpoint('checkpoint-workflow', '1', 4_000);
    internals.checkpoints.set(newCheckpoint.workflowId, newCheckpoint);
    internals.eventLogHeads.set(newCheckpoint.workflowId, EMPTY_EVENT_HEAD);
    await seedCheckpoint(storage, newCheckpoint);

    const nextCheckpoint = { ...newCheckpoint, step: 1, createdAt: 5_000 };
    await persistCheckpoint(
      internals,
      newCheckpoint.workflowId,
      checkpointOperation,
      serializeCheckpointBuffer(nextCheckpoint),
      createPersistCallbacks(),
    );

    expect(await storage.get(KEYS.checkpoint(newCheckpoint.workflowId))).toEqual(
      serializeCheckpoint(nextCheckpoint),
    );
    expect(storage.conditionalBatchCallCount).toBe(0);
  });
});
