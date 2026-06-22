import { describe, expect, it, mock } from 'bun:test';

import {
  KEYS,
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
  type StorageCapabilities,
} from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import type { ActivityInterception } from '../interceptor.ts';
import { getActivityFunctionWithMetadata, resolveActivityFunction } from './activity-resolution.ts';
import {
  executeActivity,
  executeActivityOperationResult,
  invokeWorkerActivity,
  type ActivityFunctionWithMetadata,
  type ActivityOperationCallbacks,
} from './operations-activity.ts';

type ActivityOperation = Extract<ContextOperationRequest, { type: 'activity' }>;

function createActivityOperation(overrides: Partial<ActivityOperation> = {}): ActivityOperation {
  return {
    type: 'activity',
    operationId: 'activity-operation',
    activityName: 'test-activity',
    input: 'payload',
    ...overrides,
  };
}

function createCallbacks(
  overrides: Partial<ActivityOperationCallbacks> = {},
): ActivityOperationCallbacks {
  return {
    getComposedActivityInterceptor: () => null,
    getComposedWorkflowInterceptor: () => null,
    finalizePendingTimelineEntry: () => {},
    feedOperationResult: () => {},
    runOperationWithResult: async (_workflowId, _operation, execute) => {
      await execute();
    },
    ...overrides,
  };
}

function createInternals(overrides: Record<string, unknown> = {}) {
  return {
    activityRegistriesByWorkflow: new Map(),
    activityRegistry: { resolve: () => undefined },
    heartbeatDetails: new Map(),
    lastHeartbeatDetailsByStep: new Map(),
    options: { getNow: () => 1_700_000_000_000, payloadSizePolicy: { maxBytes: null } },
    pendingAtomicWorkflowCommitSideEffects: new Map<
      string,
      { conditions: ConditionalBatchCondition[]; operations: BatchOperation[] }
    >(),
    storage: new MemoryStorage(),
    workflowTypeByWorkflowId: new Map(),
    ...overrides,
  };
}

class NoConditionalBatchStorage extends MemoryStorage {
  override capabilities(): StorageCapabilities {
    return { ...super.capabilities(), conditionalBatch: false };
  }
}

class TransitionFailingStorage extends MemoryStorage {
  #remainingTransitionFailures: number;

  constructor(remainingTransitionFailures: number) {
    super();
    this.#remainingTransitionFailures = remainingTransitionFailures;
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const isTransition =
      conditions.length === 1 &&
      conditions[0]?.expectedValue !== null &&
      operations.some((operation) => operation.type === 'put');
    if (isTransition && this.#remainingTransitionFailures > 0) {
      this.#remainingTransitionFailures--;
      return false;
    }
    return super.conditionalBatch(conditions, operations);
  }
}

class InitialClaimLosingStorage extends MemoryStorage {
  #competingRecord: Uint8Array;

  constructor(competingRecord: Uint8Array) {
    super();
    this.#competingRecord = competingRecord;
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const condition = conditions[0];
    const operation = operations[0];
    const isInitialClaim =
      conditions.length === 1 && condition?.expectedValue === null && operation?.type === 'put';
    if (isInitialClaim) {
      await this.put(condition.key, this.#competingRecord);
      return false;
    }
    return super.conditionalBatch(conditions, operations);
  }
}

class RecordingConditionalBatchStorage extends MemoryStorage {
  readonly conditionBatches: ConditionalBatchCondition[][] = [];

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.conditionBatches.push(conditions);
    return super.conditionalBatch(conditions, operations);
  }
}

async function digestIdempotencyKey(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(idempotencyKey));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedStartedRecord(
  storage: MemoryStorage,
  workflowId: string,
  operation: ActivityOperation,
  idempotencyKey: string,
  recordOverrides: Record<string, unknown> = {},
): Promise<string> {
  const idempotencyKeyDigest = await digestIdempotencyKey(idempotencyKey);
  const key = KEYS.activityReconciliation(workflowId, operation.activityName, idempotencyKeyDigest);
  await storage.put(
    key,
    encode({
      version: 1,
      status: 'started',
      workflowId,
      operationId: operation.operationId,
      activityName: operation.activityName,
      idempotencyKeyDigest,
      attempt: 1,
      ownerId: 'owner',
      createdAt: 1,
      updatedAt: 1,
      ...recordOverrides,
    }),
  );
  return key;
}

async function commitPendingAtomicSideEffects(
  storage: MemoryStorage,
  internals: ReturnType<typeof createInternals>,
  workflowId: string,
): Promise<void> {
  const pending = internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId);
  expect(pending).toBeDefined();
  expect(await storage.conditionalBatch(pending!.conditions, pending!.operations)).toBe(true);
  internals.pendingAtomicWorkflowCommitSideEffects.delete(workflowId);
}

async function readSingleActivityReconciliationRecord(
  storage: MemoryStorage,
  workflowId: string,
): Promise<unknown> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(KEYS.activityReconciliationPrefix(workflowId))) {
    keys.push(key);
  }
  expect(keys).toHaveLength(1);
  return decode((await storage.get(keys[0]!))!);
}

async function createReconciliationRecordValue(
  workflowId: string,
  operation: ActivityOperation,
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
): Promise<Uint8Array> {
  return encode({
    version: 1,
    status: 'started',
    workflowId,
    operationId: operation.operationId,
    activityName: operation.activityName,
    idempotencyKeyDigest: await digestIdempotencyKey(idempotencyKey),
    attempt: 1,
    ownerId: 'competing-owner',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

describe('activity operation helpers', () => {
  it('resolves global activities for unknown workflow ids', () => {
    const activityFunction = () => 'global-result';
    const operation = createActivityOperation();

    const resolved = resolveActivityFunction(
      createInternals({
        activityRegistry: {
          resolve: (name: string) =>
            name === operation.activityName ? activityFunction : undefined,
        },
      }) as never,
      'missing-workflow',
      operation,
    );

    expect(resolved).toBe(activityFunction);
  });

  it('falls back to the operation function for metadata lookup', () => {
    const fallback = (() => 'fallback') as ActivityFunctionWithMetadata;
    const operation = createActivityOperation({ fn: fallback });

    expect(
      getActivityFunctionWithMetadata(createInternals() as never, 'workflow-id', operation),
    ).toBe(fallback);
  });

  it('returns undefined metadata when no registry or inline function matches', () => {
    expect(
      getActivityFunctionWithMetadata(
        createInternals() as never,
        'workflow-id',
        createActivityOperation(),
      ),
    ).toBeUndefined();
  });

  it('throws when worker activity execution is requested without a dispatcher', async () => {
    await expect(
      invokeWorkerActivity(createInternals() as never, 'op-1', 'missing-dispatcher', 'payload', 1),
    ).rejects.toThrow('No activity worker dispatcher available for "missing-dispatcher"');
  });

  it('rehydrates worker activity failure names', async () => {
    const internals = createInternals({
      activityWorkerDispatcher: {
        execute: async () => ({
          operationId: 'op-validation',
          status: 'failed',
          error: 'validation failed',
          errorName: 'ValidationError',
        }),
      },
    });

    await expect(
      invokeWorkerActivity(internals as never, 'op-validation', 'validate', 'payload', 1),
    ).rejects.toMatchObject({ name: 'ValidationError', message: 'validation failed' });
  });

  it('copies activity-interceptor headers onto the operation before returning', async () => {
    const operation = createActivityOperation({
      fn: () => 'activity-result',
    });

    const result = await executeActivity(
      createInternals() as never,
      'workflow-id',
      operation,
      createCallbacks({
        getComposedActivityInterceptor: () => ({
          execute: async (interception, next) => {
            interception.headers.set('x-trace-id', 'activity');
            return next(interception);
          },
        }),
      }),
    );

    expect(result).toBe('activity-result');
    expect(operation.headers).toEqual([['x-trace-id', 'activity']]);
  });

  it('copies workflow-interceptor headers onto the operation before returning', async () => {
    const operation = createActivityOperation({
      fn: () => 'workflow-result',
    });

    const result = await executeActivity(
      createInternals() as never,
      'workflow-id',
      operation,
      createCallbacks({
        getComposedWorkflowInterceptor: () =>
          ({
            *activity(
              interception: ActivityInterception,
              next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
            ) {
              interception.headers.set('x-trace-id', 'workflow');
              return yield* next(interception);
            },
          }) as never,
      }),
    );

    expect(result).toBe('workflow-result');
    expect(operation.headers).toEqual([['x-trace-id', 'workflow']]);
  });

  it('forwards activity rejections into the workflow interceptor so finally blocks run', async () => {
    const operation = createActivityOperation({
      fn: () => {
        throw new Error('activity boom');
      },
    });

    let finallyRan = false;
    let caughtInGenerator: unknown;

    await expect(
      executeActivity(
        createInternals() as never,
        'workflow-id',
        operation,
        createCallbacks({
          getComposedWorkflowInterceptor: () =>
            ({
              *activity(
                interception: ActivityInterception,
                next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
              ) {
                try {
                  return yield* next(interception);
                } catch (error) {
                  caughtInGenerator = error;
                  throw error;
                } finally {
                  finallyRan = true;
                }
              },
            }) as never,
        }),
      ),
    ).rejects.toThrow('activity boom');

    expect(finallyRan).toBe(true);
    expect(caughtInGenerator).toBeInstanceOf(Error);
  });

  it('records verification promises on speculative execution state', async () => {
    const verificationPromises: Promise<void>[] = [];
    const verify = mock(async () => true);
    const activityFunction = Object.assign(() => 'verified-result', { verify });
    const operation = createActivityOperation({ fn: activityFunction });

    const result = await executeActivityOperationResult(
      createInternals() as never,
      'workflow-id',
      operation,
      createCallbacks(),
      undefined,
      {
        recordCompensation: () => undefined,
        recordVerification: (verification: Promise<void>) => {
          verificationPromises.push(verification);
        },
      } as never,
    );

    expect(result).toBe('verified-result');
    expect(verificationPromises).toHaveLength(1);
    await expect(verificationPromises[0]).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledWith(
      'verified-result',
      expect.objectContaining({ phase: 'post-execution-validation' }),
    );
  });

  it('awaits verification immediately when no speculative execution state is present', async () => {
    const verify = mock(async () => true);
    const activityFunction = Object.assign(() => 'verified-inline', { verify });
    const operation = createActivityOperation({ fn: activityFunction });

    await expect(
      executeActivityOperationResult(
        createInternals() as never,
        'workflow-id',
        operation,
        createCallbacks(),
      ),
    ).resolves.toBe('verified-inline');

    expect(verify).toHaveBeenCalledWith(
      'verified-inline',
      expect.objectContaining({ phase: 'post-execution-validation' }),
    );
  });

  it('passes the operation attempt into non-keyed verification context', async () => {
    const verify = mock(async () => true);
    const activityFunction = Object.assign(() => 'attempted-result', { verify });
    const operation = createActivityOperation({ attempt: 3, fn: activityFunction });

    await expect(
      executeActivityOperationResult(
        createInternals() as never,
        'workflow-id',
        operation,
        createCallbacks(),
      ),
    ).resolves.toBe('attempted-result');

    expect(verify).toHaveBeenCalledWith(
      'attempted-result',
      expect.objectContaining({ attempt: 3, phase: 'post-execution-validation' }),
    );
  });

  it('rejects reconciliation-only verifier states during post-execution validation', async () => {
    const verify = mock(async () => 'not-completed');
    const activityFunction = Object.assign(() => 'result', { verify });

    await expect(
      executeActivityOperationResult(
        createInternals() as never,
        'workflow-id',
        createActivityOperation({ fn: activityFunction }),
        createCallbacks(),
      ),
    ).rejects.toThrow('Verification failed for activity "test-activity"');
  });

  it('records and replays keyed activity results through the checkpoint commit', async () => {
    const storage = new MemoryStorage();
    const operation = createActivityOperation({
      fn: () => 'first-result',
      options: { idempotencyKey: 'order:123' },
    });
    const internals = createInternals({ storage });

    await expect(
      executeActivityOperationResult(
        internals as never,
        'workflow:id',
        operation,
        createCallbacks(),
      ),
    ).resolves.toBe('first-result');

    const keys: string[] = [];
    for await (const [key] of storage.scan(KEYS.activityReconciliationPrefix('workflow:id'))) {
      keys.push(key);
    }
    expect(keys).toHaveLength(1);
    expect(keys[0]).toStartWith('actrec:v1:workflow%3Aid:test-activity:');
    expect(keys[0]).not.toContain('order:123');
    const startedRecord = decode((await storage.get(keys[0]!))!);
    expect(startedRecord).toMatchObject({ status: 'started' });

    await commitPendingAtomicSideEffects(storage, internals, 'workflow:id');
    const completedRecord = decode((await storage.get(keys[0]!))!);
    expect(completedRecord).toMatchObject({ status: 'completed', result: 'first-result' });

    const replayOperation = createActivityOperation({
      fn: () => {
        throw new Error('should not execute');
      },
      operationId: 'replayed-operation',
      options: { idempotencyKey: 'order:123' },
    });
    await expect(
      executeActivityOperationResult(
        createInternals({ storage }) as never,
        'workflow:id',
        replayOperation,
        createCallbacks(),
      ),
    ).resolves.toBe('first-result');
  });

  it('can commit a keyed activity completion immediately without staging a checkpoint side effect', async () => {
    const storage = new MemoryStorage();
    const operation = createActivityOperation({
      fn: () => 'immediate-result',
      options: { idempotencyKey: 'immediate-key' },
    });
    const internals = createInternals({ storage });

    await expect(
      executeActivityOperationResult(
        internals as never,
        'workflow:id',
        operation,
        createCallbacks(),
        undefined,
        undefined,
        { reconciliationCompletion: 'immediate-fenced' },
      ),
    ).resolves.toBe('immediate-result');

    expect(internals.pendingAtomicWorkflowCommitSideEffects.has('workflow:id')).toBe(false);
    expect(await readSingleActivityReconciliationRecord(storage, 'workflow:id')).toMatchObject({
      status: 'completed',
      result: 'immediate-result',
    });
  });

  it('lease-fences immediate keyed activity completion writes', async () => {
    const storage = new RecordingConditionalBatchStorage();
    const epoch = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]);
    await storage.put(KEYS.leaseEpoch(), epoch);
    const operation = createActivityOperation({
      fn: () => 'fenced-result',
      options: { idempotencyKey: 'lease-fenced-key' },
    });
    const internals = createInternals({
      deposed: false,
      leaseManager: { currentEpochBytes: () => epoch },
      options: {
        getNow: () => 1_700_000_000_000,
        ownershipMode: 'lease',
        payloadSizePolicy: { maxBytes: null },
      },
      storage,
    });

    await expect(
      executeActivityOperationResult(
        internals as never,
        'workflow:id',
        operation,
        createCallbacks(),
        undefined,
        undefined,
        { reconciliationCompletion: 'immediate-fenced' },
      ),
    ).resolves.toBe('fenced-result');

    expect(
      storage.conditionBatches.some((conditions) =>
        conditions.some((condition) => condition.key === KEYS.leaseEpoch()),
      ),
    ).toBe(true);
    expect(await readSingleActivityReconciliationRecord(storage, 'workflow:id')).toMatchObject({
      status: 'completed',
      result: 'fenced-result',
    });
  });

  it('fails closed when a keyed activity has a prior started record and no verifier', async () => {
    const storage = new MemoryStorage();
    const operation = createActivityOperation({
      fn: () => {
        throw new Error('should not redispatch');
      },
      options: { idempotencyKey: 'order-456' },
    });
    await seedStartedRecord(storage, 'workflow-id', operation, 'order-456');

    await expect(
      executeActivityOperationResult(
        createInternals({ storage }) as never,
        'workflow-id',
        operation,
        createCallbacks(),
      ),
    ).rejects.toThrow('prior dispatch marker but no Tier-0 verifier');
  });

  it('uses Tier-0 verifier states after a started record proves a prior dispatch', async () => {
    const cases = [
      {
        state: 'not-completed',
        expected: 'redispatched',
        calls: 1,
      },
      {
        state: { status: 'completed-with-result' as const, result: 'verified-result' },
        expected: 'verified-result',
        calls: 0,
      },
    ];

    for (const testCase of cases) {
      const storage = new MemoryStorage();
      const operation = createActivityOperation({
        fn: mock(() => 'redispatched'),
        options: { idempotencyKey: `key-${String(testCase.expected)}` },
      });
      await seedStartedRecord(
        storage,
        'workflow-id',
        operation,
        `key-${String(testCase.expected)}`,
      );
      const verify = mock(async (_result: unknown, context?: { phase?: string }) =>
        context?.phase === 'pre-dispatch-reconciliation' ? testCase.state : true,
      );
      const activityFunction = Object.assign(operation.fn!, { verify });

      await expect(
        executeActivityOperationResult(
          createInternals({ storage }) as never,
          'workflow-id',
          { ...operation, fn: activityFunction },
          createCallbacks(),
        ),
      ).resolves.toBe(testCase.expected);

      expect(operation.fn).toHaveBeenCalledTimes(testCase.calls);
      expect(verify).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ phase: 'pre-dispatch-reconciliation' }),
      );
    }
  });

  it('does not redispatch when verifier state is unavailable or indeterminate', async () => {
    for (const state of ['completed-result-unavailable', 'indeterminate'] as const) {
      const storage = new MemoryStorage();
      const operation = createActivityOperation({
        fn: mock(() => 'must-not-run'),
        options: { idempotencyKey: state },
      });
      await seedStartedRecord(storage, 'workflow-id', operation, state);
      const activityFunction = Object.assign(operation.fn!, { verify: mock(async () => state) });

      await expect(
        executeActivityOperationResult(
          createInternals({ storage }) as never,
          'workflow-id',
          { ...operation, fn: activityFunction },
          createCallbacks(),
        ),
      ).rejects.toThrow('Activity "test-activity"');
      expect(operation.fn).not.toHaveBeenCalled();
    }
  });

  it('reconciles after activity returns but completion marker write crashes', async () => {
    const storage = new MemoryStorage();
    const firstExecute = mock(() => 'external-result');
    const operation = createActivityOperation({
      fn: firstExecute,
      options: { idempotencyKey: 'crash-window' },
    });
    const firstInternals = createInternals({ storage });

    await expect(
      executeActivityOperationResult(
        firstInternals as never,
        'workflow-id',
        operation,
        createCallbacks(),
      ),
    ).resolves.toBe('external-result');
    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(await readSingleActivityReconciliationRecord(storage, 'workflow-id')).toMatchObject({
      status: 'started',
    });

    const verify = mock(async () => ({
      status: 'completed-with-result' as const,
      result: 'external-result',
    }));
    const replayExecute = mock(() => {
      throw new Error('should not redispatch');
    });
    const replayActivity = Object.assign(replayExecute, { verify });
    const replayOperation = createActivityOperation({
      fn: replayActivity,
      operationId: 'replayed-after-crash',
      options: { idempotencyKey: 'crash-window' },
    });

    await expect(
      executeActivityOperationResult(
        createInternals({ storage }) as never,
        'workflow-id',
        replayOperation,
        createCallbacks(),
      ),
    ).resolves.toBe('external-result');

    expect(replayExecute).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ phase: 'pre-dispatch-reconciliation' }),
    );
  });

  it('redispatches exactly once after crash-window verifier reports not completed', async () => {
    const storage = new MemoryStorage();
    const firstExecute = mock(() => 'lost-result');
    const operation = createActivityOperation({
      fn: firstExecute,
      options: { idempotencyKey: 'crash-redo' },
    });
    const firstInternals = createInternals({ storage });

    await expect(
      executeActivityOperationResult(
        firstInternals as never,
        'workflow-id',
        operation,
        createCallbacks(),
      ),
    ).resolves.toBe('lost-result');
    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(await readSingleActivityReconciliationRecord(storage, 'workflow-id')).toMatchObject({
      status: 'started',
    });

    const verify = mock(async (_result: unknown, context?: { phase?: string }) =>
      context?.phase === 'pre-dispatch-reconciliation' ? 'not-completed' : true,
    );
    const secondExecute = mock(() => 'second-result');
    const replayActivity = Object.assign(secondExecute, { verify });
    const replayOperation = createActivityOperation({
      fn: replayActivity,
      operationId: 'replayed-after-not-completed',
      options: { idempotencyKey: 'crash-redo' },
    });

    await expect(
      executeActivityOperationResult(
        createInternals({ storage }) as never,
        'workflow-id',
        replayOperation,
        createCallbacks(),
      ),
    ).resolves.toBe('second-result');

    expect(secondExecute).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ attempt: 1, phase: 'pre-dispatch-reconciliation' }),
    );
  });

  it('fails closed for boolean and throwing pre-dispatch verifiers', async () => {
    // A boolean is the post-execution-validation result shape; it is NOT a
    // Tier-0 pre-dispatch reconciliation state, so a verifier that returns one
    // (or throws) during pre-dispatch reconciliation fails closed rather than
    // redispatching the keyed activity.
    const cases = [
      { idempotencyKey: 'boolean-true', verifier: mock(async () => true) },
      { idempotencyKey: 'boolean-false', verifier: mock(async () => false) },
      {
        idempotencyKey: 'throwing-verifier',
        verifier: mock(async () => {
          throw new Error('external status unavailable');
        }),
      },
    ];

    for (const testCase of cases) {
      const storage = new MemoryStorage();
      const operation = createActivityOperation({
        fn: mock(() => 'must-not-run'),
        options: { idempotencyKey: testCase.idempotencyKey },
      });
      await seedStartedRecord(storage, 'workflow-id', operation, testCase.idempotencyKey);
      const activityFunction = Object.assign(operation.fn!, { verify: testCase.verifier });

      await expect(
        executeActivityOperationResult(
          createInternals({ storage }) as never,
          'workflow-id',
          { ...operation, fn: activityFunction },
          createCallbacks(),
        ),
      ).rejects.toThrow('Activity');
      expect(operation.fn).not.toHaveBeenCalled();
    }
  });

  it('fails closed for malformed reconciliation records without redispatch', async () => {
    const malformedRecords = [
      null,
      { version: 1, status: 'mystery' },
      { version: 1, status: 'started', workflowId: 'workflow-id' },
    ];

    for (const [index, record] of malformedRecords.entries()) {
      const storage = new MemoryStorage();
      const idempotencyKey = `malformed-${index}`;
      const operation = createActivityOperation({
        fn: mock(() => 'must-not-run'),
        options: { idempotencyKey },
      });
      const key = await seedStartedRecord(storage, 'workflow-id', operation, idempotencyKey);
      await storage.put(key, encode(record));

      await expect(
        executeActivityOperationResult(
          createInternals({ storage }) as never,
          'workflow-id',
          operation,
          createCallbacks(),
        ),
      ).rejects.toThrow('Activity reconciliation record');
      expect(operation.fn).not.toHaveBeenCalled();
    }
  });

  it('surfaces compare-and-set loss when bumping a started reconciliation attempt', async () => {
    const storage = new TransitionFailingStorage(1);
    const operation = createActivityOperation({
      fn: mock(() => 'must-not-run'),
      options: { idempotencyKey: 'cas-started' },
    });
    const key = await seedStartedRecord(storage, 'workflow-id', operation, 'cas-started');
    const previous = await storage.get(key);
    const verify = mock(async () => 'not-completed');
    const activityFunction = Object.assign(operation.fn!, { verify });

    await expect(
      executeActivityOperationResult(
        createInternals({ storage }) as never,
        'workflow-id',
        { ...operation, fn: activityFunction },
        createCallbacks(),
      ),
    ).rejects.toThrow('compare-and-set');

    expect(operation.fn).not.toHaveBeenCalled();
    expect(storageValuesEqual(await storage.get(key), previous)).toBe(true);
  });

  it('surfaces compare-and-set loss when writing a completed reconciliation result', async () => {
    const storage = new TransitionFailingStorage(1);
    const operation = createActivityOperation({
      fn: mock(() => 'must-not-run'),
      options: { idempotencyKey: 'cas-completed' },
    });
    const key = await seedStartedRecord(storage, 'workflow-id', operation, 'cas-completed');
    const previous = await storage.get(key);
    const verify = mock(async () => ({
      status: 'completed-with-result' as const,
      result: 'verified',
    }));
    const activityFunction = Object.assign(operation.fn!, { verify });

    await expect(
      executeActivityOperationResult(
        createInternals({ storage }) as never,
        'workflow-id',
        { ...operation, fn: activityFunction },
        createCallbacks(),
      ),
    ).rejects.toThrow('compare-and-set');

    expect(operation.fn).not.toHaveBeenCalled();
    expect(storageValuesEqual(await storage.get(key), previous)).toBe(true);
  });

  it('fails before dispatch when keyed reconciliation lacks conditionalBatch support', async () => {
    const operation = createActivityOperation({
      fn: mock(() => 'should-not-run'),
      options: { idempotencyKey: 'requires-cas' },
    });

    await expect(
      executeActivityOperationResult(
        createInternals({ storage: new NoConditionalBatchStorage() }) as never,
        'workflow-id',
        operation,
        createCallbacks(),
      ),
    ).rejects.toThrow('requires storage capability "conditionalBatch"');

    expect(operation.fn).not.toHaveBeenCalled();
  });

  it('reprocesses a competing reconciliation record after the initial claim loses', async () => {
    const operation = createActivityOperation({
      fn: mock(() => {
        throw new Error('should not run');
      }),
      options: { idempotencyKey: 'claim-race' },
    });
    const storage = new InitialClaimLosingStorage(
      await createReconciliationRecordValue('workflow-id', operation, 'claim-race', {
        status: 'completed',
        result: 'competing-result',
      }),
    );

    await expect(
      executeActivityOperationResult(
        createInternals({ storage }) as never,
        'workflow-id',
        operation,
        createCallbacks(),
      ),
    ).resolves.toBe('competing-result');

    expect(operation.fn).not.toHaveBeenCalled();
  });

  it('does not persist a completed reconciliation marker before speculative verification passes', async () => {
    const storage = new MemoryStorage();
    const verify = mock(async () => false);
    const activityFunction = Object.assign(() => 'unverified-result', { verify });
    const operation = createActivityOperation({
      fn: activityFunction,
      options: { idempotencyKey: 'speculative-verification' },
    });
    const verificationPromises: Promise<void>[] = [];

    await expect(
      executeActivityOperationResult(
        createInternals({ storage }) as never,
        'workflow-id',
        operation,
        createCallbacks(),
        undefined,
        {
          recordCompensation: () => undefined,
          recordVerification: (verification: Promise<void>) => {
            verificationPromises.push(verification);
          },
        } as never,
      ),
    ).rejects.toThrow('Verification failed for activity "test-activity"');

    expect(verificationPromises).toHaveLength(1);
    await expect(verificationPromises[0]).rejects.toThrow(
      'Verification failed for activity "test-activity"',
    );

    const idempotencyKeyDigest = await digestIdempotencyKey('speculative-verification');
    const key = KEYS.activityReconciliation(
      'workflow-id',
      operation.activityName,
      idempotencyKeyDigest,
    );
    const record = decode((await storage.get(key))!);
    expect(record).toMatchObject({ status: 'started' });
  });
});
