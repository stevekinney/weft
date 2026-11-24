import { describe, expect, it } from 'bun:test';

import {
  type BatchOperation,
  type ConditionalBatchCondition,
  type StorageCapabilities,
  MemoryStorage,
} from "../../embedded/storage/src/index.ts";
import { rejectionOf, throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { createCheckpoint, serializeCheckpoint } from '../checkpoint.ts';
import type { ContextOperationRequest } from '../context.ts';
import { EMPTY_EVENT_HEAD } from '../event-log.ts';
import { ActivityCompletedEvent } from '../events.ts';
import type { Checkpoint } from '../types.ts';
import { rememberCommittedCheckpointBytes } from './checkpoint-commit-snapshots.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import { persistCheckpoint } from './checkpoint-io.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import type { EngineInternals } from './internals.ts';
import { StreamChunkAnnouncer } from './stream-chunk-announcer.ts';
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

class CommitGateStorage extends MemoryStorage {
  readonly entered = Promise.withResolvers<void>();
  readonly released = Promise.withResolvers<void>();
  committed = false;
  conditionalCalls = 0;

  override async batch(operations: BatchOperation[]): Promise<void> {
    this.entered.resolve();
    await this.released.promise;
    await super.batch(operations);
    this.committed = true;
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.conditionalCalls++;
    this.entered.resolve();
    await this.released.promise;
    const committed = await super.conditionalBatch(conditions, operations);
    this.committed = committed;
    return committed;
  }
}

class RefusingConditionalBatchStorage extends MemoryStorage {
  override async conditionalBatch(
    _conditions: ConditionalBatchCondition[],
    _operations: BatchOperation[],
  ): Promise<boolean> {
    return false;
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
      _stepIndex: number,
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
    pendingAtomicWorkflowCommitSideEffects: new Map(),
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
    streamChunkAnnouncer: new StreamChunkAnnouncer(
      () => {},
      () => false,
    ),
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
    conditionWaiters: new Map(),
    deliveredPendingUpdateIds: new Map(),
    durableInlineOperations: new Map(),
    sleepResolvers: new Map(),
    sleepResolversByWorkflow: new Map(),
    sleepTimerAcknowledgementWaiters: new Map(),
    sleepTimersFiredWithoutResolver: new Map(),
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
      { pendingStepIndex: 0 },
    );

    expect(
      await throwingRejectionOf(
        persistCheckpoint(
          staleSecondOwner,
          initialCheckpoint.workflowId,
          checkpointOperation,
          serializeCheckpointBuffer(secondNext),
          createPersistCallbacks(),
          { pendingStepIndex: 0 },
        ),
      ),
    ).toThrow('Checkpoint commit for workflow "checkpoint-workflow" lost its CAS race');

    const committed = await storage.get(KEYS.checkpoint(initialCheckpoint.workflowId));
    expect(committed).toEqual(serializeCheckpoint(firstNext));
    expect(storage.conditionalBatchCallCount).toBe(2);
    expect(storage.mismatchedConditionCount).toBe(1);
  });

  it('classifies a lost commit as a checkpoint conflict only when the stored checkpoint changed', async () => {
    const storage = new CountingConditionalBatchStorage();
    const initialCheckpoint = createCheckpoint('checkpoint-workflow', '1', 1_000);
    const { workflowId } = initialCheckpoint;
    const advancedElsewhere = serializeCheckpoint({
      ...initialCheckpoint,
      step: 1,
      createdAt: 2_000,
    });
    const nextBuffer = serializeCheckpointBuffer({
      ...initialCheckpoint,
      step: 1,
      createdAt: 3_000,
    });

    // Another writer replaced the checkpoint: a conflict naming the workflow.
    const advanced = createCheckpointInternals(storage, initialCheckpoint);
    rememberRecoveredCheckpoint(advanced, initialCheckpoint);
    await storage.put(KEYS.checkpoint(workflowId), advancedElsewhere);
    const advancedReason = await rejectionOf(
      persistCheckpoint(
        advanced,
        workflowId,
        checkpointOperation,
        nextBuffer,
        createPersistCallbacks(),
        { pendingStepIndex: 0 },
      ),
    );
    expect(advancedReason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((advancedReason as WorkflowCheckpointConflictError).workflowId).toBe(workflowId);

    // The checkpoint was removed (purged or replaced): also a conflict.
    const removed = createCheckpointInternals(storage, initialCheckpoint);
    rememberRecoveredCheckpoint(removed, initialCheckpoint);
    await storage.delete(KEYS.checkpoint(workflowId));
    expect(
      await rejectionOf(
        persistCheckpoint(
          removed,
          workflowId,
          checkpointOperation,
          nextBuffer,
          createPersistCallbacks(),
          { pendingStepIndex: 0 },
        ),
      ),
    ).toBeInstanceOf(WorkflowCheckpointConflictError);
  });

  it('classifies a lost commit as a conflict when the follow-up checkpoint read fails', async () => {
    const initialCheckpoint = createCheckpoint('checkpoint-workflow', '1', 1_000);
    const { workflowId } = initialCheckpoint;
    const readFailure = new Error('storage read unavailable');
    let commitLost = false;
    class ReadFailsAfterLossStorage extends MemoryStorage {
      override async conditionalBatch(
        conditions: ConditionalBatchCondition[],
        operations: BatchOperation[],
      ): Promise<boolean> {
        const applied = await super.conditionalBatch(conditions, operations);
        if (!applied) commitLost = true;
        return applied;
      }
      override async get(key: string): Promise<Uint8Array | null> {
        if (commitLost && key === KEYS.checkpoint(workflowId)) throw readFailure;
        return super.get(key);
      }
    }
    const storage = new ReadFailsAfterLossStorage();
    const internals = createCheckpointInternals(storage, initialCheckpoint);
    rememberRecoveredCheckpoint(internals, initialCheckpoint);
    await storage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint({ ...initialCheckpoint, step: 1, createdAt: 2_000 }),
    );

    const reason = await rejectionOf(
      persistCheckpoint(
        internals,
        workflowId,
        checkpointOperation,
        serializeCheckpointBuffer({ ...initialCheckpoint, step: 1, createdAt: 3_000 }),
        createPersistCallbacks(),
        { pendingStepIndex: 0 },
      ),
    );

    // The compare-and-swap already lost, so an unclassifiable loss must stay on
    // the write-free conflict path rather than surface as an ordinary failure.
    expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((reason as Error).cause).toBe(readFailure);
  });

  it('keeps the generic lost-race error when the batch had no checkpoint condition to lose', async () => {
    const storage = new CountingConditionalBatchStorage();
    const initialCheckpoint = createCheckpoint('checkpoint-workflow', '1', 1_000);
    const { workflowId } = initialCheckpoint;
    // No remembered committed bytes: the commit carries no checkpoint condition,
    // so only the staged side-effect condition below can lose it.
    const internals = createCheckpointInternals(storage, initialCheckpoint);
    await seedCheckpoint(storage, initialCheckpoint);
    stageAtomicWorkflowCommitSideEffects(internals, workflowId, {
      conditions: [{ key: 'side-effect-guard', expectedValue: new Uint8Array([1]) }],
      operations: [],
    });

    const reason = await rejectionOf(
      persistCheckpoint(
        internals,
        workflowId,
        checkpointOperation,
        serializeCheckpointBuffer({ ...initialCheckpoint, step: 1, createdAt: 2_000 }),
        createPersistCallbacks(),
        { pendingStepIndex: 0 },
      ),
    );

    expect((reason as Error).message).toContain('lost its CAS race');
    expect(reason).not.toBeInstanceOf(WorkflowCheckpointConflictError);
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
      { pendingStepIndex: 0 },
    );

    expect(
      await throwingRejectionOf(
        persistCheckpoint(
          staleSecondOwner,
          initialCheckpoint.workflowId,
          checkpointOperation,
          serializeCheckpointBuffer({ ...initialCheckpoint, step: 1, createdAt: 3_000 }),
          createPersistCallbacks(),
          { pendingStepIndex: 0 },
        ),
      ),
    ).toThrow('lost its CAS race');

    expect(staleSecondOwner.checkpoints.get(initialCheckpoint.workflowId)).toEqual(
      initialCheckpoint,
    );
    expect(staleSecondOwner.eventLogHeads.get(initialCheckpoint.workflowId)).toEqual(
      EMPTY_EVENT_HEAD,
    );
  });

  it('refuses a worker commit that does not report the step index its operation occupies', async () => {
    const storage = new CountingConditionalBatchStorage();
    const initialCheckpoint = createCheckpoint('checkpoint-workflow', '1', 1_000);
    const internals = createCheckpointInternals(storage, initialCheckpoint);
    await seedCheckpoint(storage, initialCheckpoint);
    rememberRecoveredCheckpoint(internals, initialCheckpoint);

    const reason = await rejectionOf(
      persistCheckpoint(
        internals,
        initialCheckpoint.workflowId,
        checkpointOperation,
        serializeCheckpointBuffer({ ...initialCheckpoint, step: 1, createdAt: 2_000 }),
        createPersistCallbacks(),
      ),
    );

    expect((reason as Error).message).toContain('carries no pending step index');
    expect(storage.conditionalBatchCallCount).toBe(0);
  });

  it('records the step index a worker reports on the timeline entry, not the checkpoint count', async () => {
    const storage = new CountingConditionalBatchStorage();
    const initialCheckpoint = createCheckpoint('checkpoint-workflow', '1', 1_000);
    const internals = createCheckpointInternals(storage, initialCheckpoint);
    await seedCheckpoint(storage, initialCheckpoint);
    rememberRecoveredCheckpoint(internals, initialCheckpoint);
    const recorded: Array<{ step: number; stepIndex: number }> = [];
    const callbacks = {
      ...createPersistCallbacks(),
      appendTimelineBatchOperations: (
        _workflowId: string,
        _operation: ContextOperationRequest,
        step: number,
        stepIndex: number,
        timestamp: number,
      ) => {
        recorded.push({ step, stepIndex });
        return { startedAt: timestamp, entry: { step } as never };
      },
    };

    await persistCheckpoint(
      internals,
      initialCheckpoint.workflowId,
      checkpointOperation,
      serializeCheckpointBuffer({ ...initialCheckpoint, step: 4, createdAt: 2_000 }),
      callbacks,
      { pendingStepIndex: 9 },
    );

    expect(recorded).toEqual([{ step: 4, stepIndex: 9 }]);
  });

  it('leaves pending timeline entries empty when preserve-pending finds no existing entry', async () => {
    const storage = new CountingConditionalBatchStorage();
    const initialCheckpoint = createCheckpoint('checkpoint-workflow', '1', 1_000);
    const internals = createCheckpointInternals(storage, initialCheckpoint);
    await seedCheckpoint(storage, initialCheckpoint);
    rememberRecoveredCheckpoint(internals, initialCheckpoint);

    await persistCheckpoint(
      internals,
      initialCheckpoint.workflowId,
      checkpointOperation,
      serializeCheckpointBuffer({ ...initialCheckpoint, step: 1, createdAt: 2_000 }),
      createPersistCallbacks(),
      { timeline: 'preserve-pending', pendingStepIndex: 0 },
    );

    expect(internals.pendingTimelineEntries.has(initialCheckpoint.workflowId)).toBe(false);
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
      { pendingStepIndex: 0 },
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
      dispatchEvent: () => {},
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
      { pendingStepIndex: 0 },
    );

    expect(await storage.get(KEYS.checkpoint(newCheckpoint.workflowId))).toEqual(
      serializeCheckpoint(nextCheckpoint),
    );
    expect(storage.conditionalBatchCallCount).toBe(0);
  });

  it("rejects a worker-returned checkpoint whose claimed workflowExecutionToken disagrees with the host's own current generation, rather than silently reattaching the host's token onto the worker's stale content (WFT-21, Codex review round 5, P1, superseding round 4's silent-correction behavior)", async () => {
    const storage = new MemoryStorage();
    // The host's own in-memory `internals.checkpoints` entry is the
    // authoritative source of truth for the CURRENT generation's token.
    const checkpoint = createCheckpoint('checkpoint-workflow', '1', 1_000, 'host-owned-token');
    const internals = createCheckpointInternals(storage, checkpoint);
    await seedCheckpoint(storage, checkpoint);

    // A worker claiming a DIFFERENT token than the host's own current
    // generation — round 4 silently reattached the host's token here and
    // persisted anyway; round 5 instead treats the disagreement itself as
    // proof this worker's checkpoint was produced for a generation that no
    // longer exists (the exact `start-new`-replacement race) and rejects
    // outright, before any write.
    const workerClaimedCheckpoint: Checkpoint = {
      ...checkpoint,
      step: 1,
      workflowExecutionToken: 'worker-forged-token',
    };
    expect(
      await throwingRejectionOf(
        persistCheckpoint(
          internals,
          checkpoint.workflowId,
          checkpointOperation,
          serializeCheckpointBuffer(workerClaimedCheckpoint),
          createPersistCallbacks(),
          { pendingStepIndex: 0 },
        ),
      ),
    ).toThrow('targets a different execution generation');

    // Nothing was written.
    expect(await storage.get(KEYS.checkpoint('checkpoint-workflow'))).toEqual(
      serializeCheckpoint(checkpoint),
    );
  });

  it("rejects a worker-returned checkpoint that OMITS workflowExecutionToken entirely while the host has one, rather than silently treating the omission as legacy tolerance and stamping the host's token onto it (WFT-21, Codex review round 7, P1, tightening round 5's own fix)", async () => {
    const storage = new MemoryStorage();
    const checkpoint = createCheckpoint(
      'checkpoint-workflow-omitted-token',
      '1',
      1_000,
      'host-owned-token',
    );
    const internals = createCheckpointInternals(storage, checkpoint);
    await seedCheckpoint(storage, checkpoint);

    // A stale or hostile worker that simply OMITS the field entirely —
    // indistinguishable on the wire from a genuinely pre-upgrade worker,
    // but the host itself already has a token, which is strong enough
    // evidence this is NOT a legacy generation to extend that tolerance to.
    const workerCheckpointNoToken = { ...checkpoint, step: 1 };
    delete (workerCheckpointNoToken as { workflowExecutionToken?: string }).workflowExecutionToken;
    expect(workerCheckpointNoToken.workflowExecutionToken).toBeUndefined();

    expect(
      await throwingRejectionOf(
        persistCheckpoint(
          internals,
          checkpoint.workflowId,
          checkpointOperation,
          serializeCheckpointBuffer(workerCheckpointNoToken),
          createPersistCallbacks(),
          { pendingStepIndex: 0 },
        ),
      ),
    ).toThrow('targets a different execution generation');

    expect(await storage.get(KEYS.checkpoint('checkpoint-workflow-omitted-token'))).toEqual(
      serializeCheckpoint(checkpoint),
    );
  });

  it('proceeds and persists the host copy when the worker-claimed workflowExecutionToken agrees with the host, never trusting the worker bytes as the value to persist even on agreement', async () => {
    const storage = new MemoryStorage();
    const checkpoint = createCheckpoint('checkpoint-workflow-agree', '1', 1_000, 'shared-token');
    const internals = createCheckpointInternals(storage, checkpoint);
    await seedCheckpoint(storage, checkpoint);

    const workerCheckpoint: Checkpoint = {
      ...checkpoint,
      step: 1,
      workflowExecutionToken: 'shared-token',
    };
    await persistCheckpoint(
      internals,
      checkpoint.workflowId,
      checkpointOperation,
      serializeCheckpointBuffer(workerCheckpoint),
      createPersistCallbacks(),
      { pendingStepIndex: 0 },
    );

    const persistedBytes = await storage.get(KEYS.checkpoint('checkpoint-workflow-agree'));
    const decodedRoundTrip = internals.checkpoints.get('checkpoint-workflow-agree');
    expect(decodedRoundTrip?.workflowExecutionToken).toBe('shared-token');
    expect(persistedBytes).not.toBeNull();
    expect(serializeCheckpoint(workerCheckpoint)).toEqual(persistedBytes!);
  });

  it('drops workflowExecutionToken entirely when the host in-memory checkpoint has none (legacy) — never falls back to the worker-claimed token', async () => {
    const storage = new MemoryStorage();
    // No token on the host's own in-memory entry — the pre-existing legacy
    // case (a generation whose checkpoint predates this field).
    const checkpoint = createCheckpoint('checkpoint-workflow-no-host-token', '1', 1_000);
    const internals = createCheckpointInternals(storage, checkpoint);
    await seedCheckpoint(storage, checkpoint);

    const workerClaimedCheckpoint: Checkpoint = {
      ...checkpoint,
      step: 1,
      workflowExecutionToken: 'worker-forged-token',
    };
    await persistCheckpoint(
      internals,
      checkpoint.workflowId,
      checkpointOperation,
      serializeCheckpointBuffer(workerClaimedCheckpoint),
      createPersistCallbacks(),
      { pendingStepIndex: 0 },
    );

    const decodedRoundTrip = internals.checkpoints.get('checkpoint-workflow-no-host-token');
    expect(decodedRoundTrip?.workflowExecutionToken).toBeUndefined();
  });

  it('rejects a worker checkpoint outright when its generation no longer exists in memory — a concurrent terminal cleanup, suspend, or purge already tore it down (WFT-21, Codex review round 5, P1)', async () => {
    const storage = new MemoryStorage();
    const checkpoint = createCheckpoint('checkpoint-workflow-torn-down', '1', 1_000, 'stale-token');
    const internals = createCheckpointInternals(storage, checkpoint);
    await seedCheckpoint(storage, checkpoint);
    // Simulate the generation having already torn down — exactly what
    // `suspend.ts`/`cleanup.ts`/`transition.ts`'s own rollback/`bulk-operations-purge.ts`
    // do, all of which delete this entry.
    internals.checkpoints.delete('checkpoint-workflow-torn-down');

    const workerClaimedCheckpoint: Checkpoint = {
      ...checkpoint,
      step: 1,
      workflowExecutionToken: 'worker-forged-token',
    };
    expect(
      await throwingRejectionOf(
        persistCheckpoint(
          internals,
          checkpoint.workflowId,
          checkpointOperation,
          serializeCheckpointBuffer(workerClaimedCheckpoint),
          createPersistCallbacks(),
          { pendingStepIndex: 0 },
        ),
      ),
    ).toThrow('targets a generation that no longer exists');

    // Nothing was written — the stale worker checkpoint never landed.
    expect(await storage.get(KEYS.checkpoint('checkpoint-workflow-torn-down'))).toEqual(
      serializeCheckpoint(checkpoint),
    );
  });

  it.each([false, true])(
    'dispatches activity completion only after a %s checkpoint batch commits',
    async (conditional) => {
      const storage = new CommitGateStorage();
      const checkpoint = createCheckpoint('checkpoint-activity-commit', '1', 1_000, 'run-a');
      const internals = createCheckpointInternals(storage, checkpoint);
      internals.durableInlineOperations = new Map([
        [
          'checkpoint-activity-commit',
          { operationId: 'activity-1', type: 'activity', workflowExecutionToken: 'run-a' },
        ],
      ]) as never;
      internals.pendingTimelineEntries.set('checkpoint-activity-commit', {
        startedAt: 900,
        entry: {
          step: 1,
          operationType: 'activity',
          operationLabel: 'send-email',
          inputSummary: 'input',
          timestamp: 900,
          status: 'completed',
          duration: 42,
        },
      });
      const observed: Array<{ event: Event; committed: boolean }> = [];
      if (conditional) rememberRecoveredCheckpoint(internals, checkpoint);
      const callbacks = {
        ...createPersistCallbacks(),
        dispatchEvent: (event: Event) => {
          observed.push({
            event,
            committed: storage.committed,
          });
        },
      };
      await seedCheckpoint(storage, checkpoint);

      const persist = persistCheckpoint(
        internals,
        checkpoint.workflowId,
        checkpointOperation,
        serializeCheckpointBuffer({ ...checkpoint, step: 1, workflowExecutionToken: 'run-a' }),
        callbacks,
        { pendingStepIndex: 0 },
      );
      await storage.entered.promise;
      expect(observed).toHaveLength(0);
      storage.released.resolve();
      await persist;

      expect(observed).toHaveLength(1);
      expect(observed[0]?.event).toBeInstanceOf(ActivityCompletedEvent);
      expect(observed[0]?.committed).toBe(true);
      if (conditional) expect(storage.conditionalCalls).toBeGreaterThan(0);
    },
  );

  it('does not dispatch an activity completion receipt when a stale checkpoint CAS refuses', async () => {
    const storage = new RefusingConditionalBatchStorage();
    const checkpoint = createCheckpoint('checkpoint-stale-activity', '1', 1_000, 'run-a');
    const internals = createCheckpointInternals(storage, checkpoint);
    rememberRecoveredCheckpoint(internals, checkpoint);
    internals.durableInlineOperations = new Map([
      [
        'checkpoint-stale-activity',
        { operationId: 'activity-stale', type: 'activity', workflowExecutionToken: 'run-a' },
      ],
    ]) as never;
    internals.pendingTimelineEntries.set('checkpoint-stale-activity', {
      startedAt: 900,
      entry: {
        step: 1,
        operationType: 'activity',
        operationLabel: 'send-email',
        inputSummary: 'input',
        timestamp: 900,
        status: 'completed',
        duration: 42,
      },
    });
    await seedCheckpoint(storage, checkpoint);
    const dispatched: Event[] = [];
    const callbacks = {
      ...createPersistCallbacks(),
      dispatchEvent: (event: Event) => dispatched.push(event),
    };

    expect(
      await throwingRejectionOf(
        persistCheckpoint(
          internals,
          checkpoint.workflowId,
          checkpointOperation,
          serializeCheckpointBuffer({ ...checkpoint, step: 1, workflowExecutionToken: 'run-a' }),
          callbacks,
          { pendingStepIndex: 0 },
        ),
      ),
    ).toThrow();
    expect(dispatched.filter((event) => event instanceof ActivityCompletedEvent)).toHaveLength(0);
  });
});
