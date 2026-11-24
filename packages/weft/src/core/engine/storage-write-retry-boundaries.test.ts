/**
 * COR-1626: what the in-process retry of a refused write does not do. An error that is not a
 * storage adapter's refusal is attempted once, and disposing the engine during a wait ends the
 * wait and writes nothing more.
 */
import { describe, expect, it } from 'bun:test';

import {
  MemoryStorage,
  type BatchOperation,
  type ConditionalBatchCondition,
} from "../../embedded/storage/src/index.ts";
import { drainMicrotasks } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { rejectionOf, throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { createCheckpoint, serializeCheckpoint } from '../checkpoint.ts';
import { decode } from '../codec/api.ts';
import type { ContextOperationRequest } from '../context.ts';
import { Engine, ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING } from '../engine.ts';
import { EMPTY_EVENT_HEAD } from '../event-log.ts';
import { workflow, type Checkpoint, type WorkflowContext, type WorkflowState } from '../types.ts';
import { rememberCommittedCheckpointBytes } from './checkpoint-commit-snapshots.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import { persistCheckpoint } from './checkpoint-io.ts';
import { EngineDisposedError } from './errors.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import { EngineDeposedError } from './lease-errors.ts';
import { createRefusingStorage, putsCheckpoint } from './storage-write-refusal.test-support.ts';
import {
  adapterConditionalBatch,
  isRetryableStorageWriteError,
  retryRefusedStorageWrite,
} from './storage-write-retry.ts';

/** A memory storage that counts its `conditionalBatch` calls and lets a subclass decide each one. */
class CountingStorage extends MemoryStorage {
  conditionalBatchCalls = 0;

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.conditionalBatchCalls += 1;
    return await this.decide(conditions, operations);
  }

  protected async decide(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    return await super.conditionalBatch(conditions, operations);
  }
}

class ThrowingStorage extends CountingStorage {
  constructor(readonly error: Error) {
    super();
  }

  protected override async decide(): Promise<boolean> {
    throw this.error;
  }
}

const checkpointOperation: ContextOperationRequest = {
  type: 'sleep',
  operationId: 'boundary',
  duration: 1_000,
  scheduledFireAt: 2_000,
};

function createInternals(storage: MemoryStorage, checkpoint: Checkpoint): EngineInternals {
  return {
    abortController: new AbortController(),
    activityRegistriesByWorkflow: new Map(),
    activityRegistry: { resolve: () => undefined },
    activityWorkerDispatcher: null,
    checkpoints: new Map([[checkpoint.workflowId, checkpoint]]),
    conditionWaiters: new Map(),
    deliveredPendingUpdateIds: new Map(),
    disposed: false,
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
    storageWriteRetryDelaysForTesting: [0, 0, 0, 0],
    workflowFeedListeners: new Map(),
    workflowTypeByWorkflowId: new Map(),
    workflowVersionTuples: new Map(),
  } as unknown as EngineInternals;
}

const persistCallbacks = {
  appendTimelineBatchOperations: (
    workflowId: string,
    _operation: ContextOperationRequest,
    step: number,
    _stepIndex: number,
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

/** Seed the committed checkpoint, then commit the next one and return what the commit threw. */
async function commitNextCheckpoint(
  storage: MemoryStorage,
  workflowId: string,
  beforeCommit?: () => Promise<void>,
): Promise<{ readonly reason: unknown; readonly internals: EngineInternals }> {
  const checkpoint = createCheckpoint(workflowId, '1', 1_000);
  const internals = createInternals(storage, checkpoint);
  const seeded = serializeCheckpoint(checkpoint);
  await storage.put(KEYS.checkpoint(workflowId), seeded);
  rememberCommittedCheckpointBytes(internals, workflowId, seeded);
  await beforeCommit?.();
  const next = serializeCheckpoint({ ...checkpoint, step: 2, createdAt: 2_000 });
  const buffer = new ArrayBuffer(next.byteLength);
  new Uint8Array(buffer).set(next);
  const reason = await rejectionOf(
    persistCheckpoint(internals, workflowId, checkpointOperation, buffer, persistCallbacks, {
      pendingStepIndex: 0,
    }),
  );
  return { reason, internals };
}

describe('an error that is not a storage refusal is attempted once', () => {
  it('a lost compare-and-swap is a conflict and writes nothing', async () => {
    const storage = new CountingStorage();
    const { reason } = await commitNextCheckpoint(storage, 'boundary-conflict', async () => {
      // Another writer advanced the checkpoint, so this commit's compare-and-swap loses.
      await storage.put(
        KEYS.checkpoint('boundary-conflict'),
        serializeCheckpoint(createCheckpoint('boundary-conflict', '1', 5_000)),
      );
    });

    expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect(storage.conditionalBatchCalls).toBe(1);
    const stored = decode((await storage.get(KEYS.checkpoint('boundary-conflict')))!) as {
      createdAt: number;
    };
    expect(stored.createdAt).toBe(5_000);
  });

  it('a deposed engine throws EngineDeposedError from the storage and is not retried', async () => {
    const storage = new ThrowingStorage(new EngineDeposedError());

    const { reason } = await commitNextCheckpoint(storage, 'boundary-deposed');

    expect(reason).toBeInstanceOf(EngineDeposedError);
    expect(storage.conditionalBatchCalls).toBe(1);
  });

  it('a disposed engine throws EngineDisposedError from the storage and is not retried', async () => {
    const storage = new ThrowingStorage(new EngineDisposedError());

    const { reason } = await commitNextCheckpoint(storage, 'boundary-disposed');

    expect(reason).toBeInstanceOf(EngineDisposedError);
    expect(storage.conditionalBatchCalls).toBe(1);
  });

  it('an error nothing marked as the adapter threw it is rethrown before any retry', async () => {
    const internals = {
      storageWriteRetryDelaysForTesting: [0, 0, 0, 0],
    } as unknown as EngineInternals;
    const cause = new Error('not from the storage adapter');
    let attempts = 0;

    const reason = await rejectionOf(
      retryRefusedStorageWrite(
        internals,
        { workflowId: 'unmarked', write: 'checkpoint', workflowExecutionToken: undefined },
        cause,
        async () => {
          attempts += 1;
          return true;
        },
      ),
    );

    expect(reason).toBe(cause);
    expect(attempts).toBe(0);
  });

  it('a conditional write the storage cannot make is a deterministic error, not a refusal', async () => {
    const withoutConditionalBatch = Object.assign(new MemoryStorage(), {
      conditionalBatch: undefined,
      capabilities: () => ({ ...new MemoryStorage().capabilities(), conditionalBatch: false }),
    });

    const reason = await rejectionOf(adapterConditionalBatch(withoutConditionalBatch, [], []));

    expect(reason).toBeInstanceOf(Error);
    expect(isRetryableStorageWriteError(reason)).toBe(false);
  });

  it('a checkpoint that cannot be encoded fails the run and is never sent twice', async () => {
    type Nested = { child?: Nested };
    const deep = workflow({ name: 'deep-boundary' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const nested = yield* ctx.memo('nested', async () => {
        let value: Nested = {};
        for (let depth = 0; depth < 150; depth += 1) value = { child: value };
        return value;
      });
      yield* ctx.memo('after', async () => 'unreachable');
      return nested;
    });
    const refusing = createRefusingStorage(new MemoryStorage());
    refusing.arm();
    await using engine = new Engine({ storage: refusing.storage });
    engine.register(deep);
    getInternals(engine).storageWriteRetryDelaysForTesting = [0, 0, 0, 0];

    const handle = await engine.start('deep-boundary', null, { id: 'deep-boundary' });

    expect(await throwingRejectionOf(handle.result())).toThrow(
      'checkpoint cannot be encoded: Too deep objects',
    );
    const batches = refusing.attemptsMatching(putsCheckpoint('deep-boundary'));
    const sent = batches.map((attempt) => {
      const put = attempt.operations.find(
        (operation) =>
          operation.type === 'put' && operation.key === KEYS.checkpoint('deep-boundary'),
      );
      return put?.type === 'put' ? [...put.value].join(',') : '';
    });
    expect(new Set(sent).size).toBe(sent.length);
    expect(batches.every((attempt) => attempt.outcome === 'passed')).toBe(true);
    const state = decode(
      (await refusing.base.get(KEYS.workflow('deep-boundary')))!,
    ) as WorkflowState;
    expect(state.status).toBe('failed');
  });
});

describe('disposal during a wait', () => {
  const parks = workflow({ name: 'dispose-during-wait' }).execute(async function* (
    ctx: WorkflowContext,
  ) {
    yield* ctx.waitForSignal<string>('go');
    return yield* ctx.run(() => 'done');
  });

  it('ends the wait at once, writes nothing more, and leaves the run running', async () => {
    const refusing = createRefusingStorage(new MemoryStorage());
    const engine = new Engine({ storage: refusing.storage });
    engine.register(parks);
    // One immediate retry, then a wait an hour long: the engine is inside it when it is disposed.
    getInternals(engine).storageWriteRetryDelaysForTesting = [0, 3_600_000, 0, 0];
    const handle = await engine.start('dispose-during-wait', null, { id: 'dispose-wait' });
    const result = handle.result();
    await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING]('dispose-wait');
    refusing.arm();
    refusing.refuse({ matches: putsCheckpoint('dispose-wait') });

    await engine.signal('dispose-wait', 'go', 'x');
    await refusing.whenAttempts(2, putsCheckpoint('dispose-wait'));
    // Let the engine reach its second wait before disposing it.
    await drainMicrotasks();
    engine[Symbol.dispose]();

    expect(await rejectionOf(result)).toBeInstanceOf(EngineDisposedError);
    await drainMicrotasks();
    const checkpointBatches = refusing.attemptsMatching(putsCheckpoint('dispose-wait'));
    expect(checkpointBatches.map((attempt) => attempt.outcome)).toEqual(['refused', 'refused']);
    const state = decode(
      (await refusing.base.get(KEYS.workflow('dispose-wait')))!,
    ) as WorkflowState;
    expect(state.status).toBe('running');
  });
});
