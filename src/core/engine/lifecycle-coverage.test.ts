import { describe, expect, it, mock } from 'bun:test';

import { KEYS, MAX_BATCH_OPERATIONS, type BatchOperation } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { serializeCheckpoint } from '../checkpoint/serialization.ts';
import { encode } from '../codec.ts';
import type { WorkflowStartInterception } from '../interceptor/interception-contexts.ts';
import { MAX_WORKFLOW_TAGS } from '../start-workflow-validation.ts';
import type { Checkpoint, WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';
import { collectWorkflowPurgeDeleteOperations } from './bulk-operations-purge.ts';
import { createLifecycleCallbacks as createEngineLifecycleCallbacks } from './callback-creators.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import {
  beginWorkflowExecution,
  buildForkBatchOperations,
  buildForkSearchAttributes,
  buildInitialSearchAttributeOperations,
  buildStartBatchOperations,
  createForkLineage,
  createForkedWorkflowState,
  createInitialWorkflowState,
  createWorkflowVersionTuple,
  derivePreparedExecutionState,
  fork,
  launchWorkflowFromCheckpoint,
  normalizeStartWorkflowTags,
  prepareResumeState,
  processPendingUpdatesAfterReplay,
  recoverAll,
  resolveScheduledStartAt,
  resumeWorkflowFromStorage,
  runWorkflowStartInterceptor,
  setWorkflowStartHeaders,
  start,
  startWorkflow,
  startWorkflowExecution,
  throwVersionMismatch,
  validateSearchAttributes,
  workflowStateWithVersionTuple,
  workflowVersionTupleFromState,
} from './lifecycle.ts';

function createLifecycleCallbacks(overrides: Record<string, unknown> = {}) {
  return {
    createWorkflowHandleWithResultPromise: (workflowId: string) => ({ id: workflowId }),
    dispatchEvent: mock(() => {}),
    getComposedWorkflowInterceptor: () => null,
    getHandle: (workflowId: string) => ({ id: workflowId }),
    handleCleanupError: mock(() => {}),
    hasLocalCheckpointOwnership: () => false,
    isInlineWorkflowLocallyOwned: () => false,
    processPendingUpdatesAfterInlineAdvance: async () => {},
    processPendingUpdatesForHandlers: async () => {},
    processPendingUpdatesAfterReplay: () => {},
    queueInlineWorkflowExecutionStart: () => {},
    resolveWorkflowTypeTarget: (target: string | Function) =>
      typeof target === 'string' ? target : target.name,
    runSerializedWorkflowStateWrite: async <Result>(
      _workflowId: string,
      writeOperation: () => Promise<Result>,
    ) => writeOperation(),
    swallowPromiseRejection: async (promise: Promise<unknown> | undefined) => {
      await promise;
    },
    ...overrides,
  };
}

function createCheckpoint(workflowId: string, overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    workflowId,
    step: overrides.step ?? 0,
    locals: overrides.locals ?? {},
    accumulatedResults: overrides.accumulatedResults ?? [],
    searchAttributes: overrides.searchAttributes ?? {},
    version: overrides.version ?? '1',
    schemaVersion: overrides.schemaVersion ?? 2,
    createdAt: overrides.createdAt ?? 1_000,
  };
}

function createWorkflowState(
  workflowId: string,
  overrides: Partial<Omit<WorkflowState, 'versionTuple'>> & {
    versionTuple?: Partial<WorkflowVersionTuple>;
  } = {},
): WorkflowState {
  const { versionTuple: versionTupleOverride, ...rest } = overrides;
  const versionTuple: WorkflowVersionTuple = {
    workflowVersion: '1',
    ...versionTupleOverride,
  };
  return {
    id: workflowId,
    type: overrides.type ?? 'workflow',
    status: overrides.status ?? 'running',
    input: overrides.input ?? { value: 1 },
    executionStateOwnerId: overrides.executionStateOwnerId ?? workflowId,
    createdAt: overrides.createdAt ?? 1_000,
    startedAt: overrides.startedAt ?? 1_000,
    updatedAt: overrides.updatedAt ?? 1_000,
    ...rest,
    versionTuple,
  };
}

type ResumeWorkflowFromStorageInternalsOptions = {
  storage: unknown;
  terminalizingWorkflows?: Set<string>;
  strategy?: unknown;
  workflowNestingDepths?: Map<string, number>;
  workflowVersionTuples?: Map<string, { workflowVersion: string }>;
};

function createResumeWorkflowFromStorageInternals({
  storage,
  strategy = { startWorkflow: mock(() => {}) },
  terminalizingWorkflows = new Set<string>(),
  workflowNestingDepths = new Map<string, number>(),
  workflowVersionTuples = new Map<string, { workflowVersion: string }>(),
}: ResumeWorkflowFromStorageInternalsOptions): Parameters<typeof resumeWorkflowFromStorage>[0] {
  return {
    checkpoints: new Map(),
    eventLogHeads: new Map(),
    inlineStrategy: null,
    options: { development: false, getNow: () => 1_000, historyPolicy: { maxEvents: null } },
    parkedInlineWorkflows: new Set<string>(),
    registrations: new Map([
      [
        'workflow',
        {
          handler: async function* () {
            return 'done';
          },
          version: '1',
        },
      ],
    ]),
    storage,
    strategy,
    terminalizingWorkflows,
    workflowHeaders: new Map<string, Map<string, string>>(),
    workflowNestingDepths,
    workflowTypeByWorkflowId: new Map<string, string>(),
    workflowVersionTuples,
    workflowsNeedingTerminalCleanup: new Set<string>(),
  } as never;
}

describe('engine lifecycle coverage helpers', () => {
  it('start delegates to startWorkflow with the engine lifecycle callbacks', async () => {
    const engine = new Engine();
    const startWrapperWorkflowWorkflow = workflow({ name: 'start-wrapper-workflow' }).execute(
      async function* () {
        return 'started';
      },
    );
    engine.register(startWrapperWorkflowWorkflow);

    const handle = await start(
      getInternals(engine),
      'start-wrapper-workflow',
      { value: 1 },
      undefined,
      createEngineLifecycleCallbacks(engine),
    );

    await expect(handle.result()).resolves.toBe('started');

    engine[Symbol.dispose]();
  });

  it('recoverAll reports missing workflow types unless explicitly acknowledged', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.workflow('workflow-missing-type'),
      encode(createWorkflowState('workflow-missing-type', { type: 'deleted-workflow' })),
    );
    await storage.put(
      KEYS.workflow('workflow-pending-local'),
      encode(createWorkflowState('workflow-pending-local', { status: 'pending' })),
    );
    await storage.put(
      KEYS.checkpoint('workflow-side-record'),
      serializeCheckpoint(createCheckpoint('workflow-side-record')),
    );

    await expect(
      recoverAll(
        { registrations: new Map(), storage } as never,
        createLifecycleCallbacks({
          getHandle: (workflowId: string) => ({ id: workflowId }),
        }) as never,
      ),
    ).rejects.toThrow('Cannot recover 1 running workflow(s)');

    const skippedEvents: Event[] = [];
    const handles = await recoverAll(
      { registrations: new Map(), storage } as never,
      createLifecycleCallbacks({
        dispatchEvent: (event: Event) => {
          skippedEvents.push(event);
        },
        getHandle: (workflowId: string) => ({ id: workflowId }),
      }) as never,
      { acknowledgeUnknownWorkflowTypes: true },
    );

    expect(handles.map((handle) => handle.id)).toEqual(['workflow-pending-local']);
    expect(skippedEvents.map((event) => event.type)).toEqual(['workflow:recovery-skipped']);
  });

  it('resume returns existing local handles for locally owned workflows', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-local-resume';
    await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));

    const handle = { id: workflowId };
    const resumed = await import('./lifecycle.ts').then(({ resume }) =>
      resume(
        { storage, options: { historyPolicy: { maxEvents: null } } } as never,
        workflowId,
        createLifecycleCallbacks({
          getHandle: () => handle,
          isInlineWorkflowLocallyOwned: () => true,
        }) as never,
      ),
    );

    expect(resumed).toBe(handle as never);
  });

  it('resume bypasses the local fast path when reclaim forces replay from storage', async () => {
    // ADR 0002: after deposition the registry drops only the claim entry, so a
    // locally-owned handle can still be present when the same engine reclaims
    // the workflow. Returning it would renew a run that never restarted from
    // durable state, so reclaim-driven resume must reach
    // `resumeWorkflowFromStorage` even though every local-ownership predicate
    // reports `true`.
    const storage = new MemoryStorage();
    const workflowId = 'workflow-reclaim-forced-replay';
    await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));

    const staleHandle = { id: workflowId };
    let reachedFastPath = false;

    const attempt = import('./lifecycle.ts').then(({ resume }) =>
      resume(
        { storage, options: { historyPolicy: { maxEvents: null } } } as never,
        workflowId,
        createLifecycleCallbacks({
          getHandle: () => {
            reachedFastPath = true;
            return staleHandle;
          },
          isInlineWorkflowLocallyOwned: () => true,
          hasLocalCheckpointOwnership: () => true,
        }) as never,
        undefined,
        { forceReplayFromStorage: true },
      ),
    );

    // The minimal stub cannot complete a real replay; whether it resolves or
    // rejects, the load-bearing assertion is that the stale local handle was
    // never handed back.
    const outcome = await attempt.then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: undefined }),
    );

    expect(reachedFastPath).toBe(false);
    if (outcome.ok) {
      expect(outcome.value).not.toBe(staleHandle as never);
    }
  });

  it('resume returns existing local handles for checkpoint-owned workflows', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-checkpoint-owned-resume';
    await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));

    const handle = { id: workflowId };
    const resumed = await import('./lifecycle.ts').then(({ resume }) =>
      resume(
        { storage, options: { historyPolicy: { maxEvents: null } } } as never,
        workflowId,
        createLifecycleCallbacks({
          getHandle: () => handle,
          hasLocalCheckpointOwnership: () => true,
        }) as never,
      ),
    );

    expect(resumed).toBe(handle as never);
  });

  it('fork rejects missing source workflows, missing registrations, and missing checkpoints', async () => {
    const storage = new MemoryStorage();

    await expect(
      fork(
        { storage } as never,
        'workflow-missing-source',
        undefined,
        createLifecycleCallbacks() as never,
      ),
    ).rejects.toThrow('Workflow "workflow-missing-source" not found');

    await storage.put(
      KEYS.workflow('workflow-missing-registration'),
      encode(createWorkflowState('workflow-missing-registration')),
    );
    await expect(
      fork(
        { registrations: new Map(), storage } as never,
        'workflow-missing-registration',
        undefined,
        createLifecycleCallbacks() as never,
      ),
    ).rejects.toThrow(
      'No workflow registered with name "workflow" (needed to fork "workflow-missing-registration")',
    );

    const registrations = new Map([
      [
        'workflow',
        {
          handler: async function* () {
            return 'done';
          },
          version: '1',
        },
      ],
    ]);

    await expect(
      fork(
        { registrations, storage } as never,
        'workflow-missing-registration',
        { fromStep: 3 },
        createLifecycleCallbacks() as never,
      ),
    ).rejects.toThrow(
      'Checkpoint not found at step 3 for workflow "workflow-missing-registration"',
    );

    await expect(
      fork(
        { registrations, storage } as never,
        'workflow-missing-registration',
        undefined,
        createLifecycleCallbacks() as never,
      ),
    ).rejects.toThrow('Checkpoint not found for workflow "workflow-missing-registration"');
  });

  it('cleans transient fork state when fork storage writes fail', async () => {
    const sourceStorage = new MemoryStorage();
    const sourceWorkflowId = 'workflow-fork-source-failure';
    await sourceStorage.put(
      KEYS.workflow(sourceWorkflowId),
      encode(createWorkflowState(sourceWorkflowId)),
    );
    await sourceStorage.put(
      KEYS.checkpoint(sourceWorkflowId),
      serializeCheckpoint(createCheckpoint(sourceWorkflowId)),
    );
    const storage = {
      delete: sourceStorage.delete.bind(sourceStorage),
      get: sourceStorage.get.bind(sourceStorage),
      put: sourceStorage.put.bind(sourceStorage),
      scan: sourceStorage.scan.bind(sourceStorage),
      batch: async () => {
        throw new Error('fork batch failed');
      },
      [Symbol.dispose]() {
        sourceStorage[Symbol.dispose]();
      },
    };
    const internals = {
      checkpoints: new Map<string, Checkpoint>(),
      eventLogHeads: new Map(),
      options: { getNow: () => 10_000 },
      registrations: new Map([
        [
          'workflow',
          {
            handler: async function* () {
              return 'done';
            },
            version: '1',
          },
        ],
      ]),
      storage,
      workflowHeaders: new Map<string, Map<string, string>>(),
      workflowVersionTuples: new Map(),
    };

    await expect(
      fork(internals as never, sourceWorkflowId, undefined, createLifecycleCallbacks() as never),
    ).rejects.toThrow('fork batch failed');

    expect(internals.checkpoints.size).toBe(0);
    expect(internals.workflowVersionTuples.size).toBe(0);
    expect(internals.eventLogHeads.size).toBe(0);
    expect(internals.workflowHeaders.size).toBe(0);
  });

  it('resolveScheduledStartAt rejects startAfter values that overflow the storage timestamp range', () => {
    expect(() =>
      resolveScheduledStartAt(
        {} as never,
        { startAfter: Number.MAX_SAFE_INTEGER },
        Number.MAX_SAFE_INTEGER,
        createLifecycleCallbacks() as never,
      ),
    ).toThrow('options.startAfter must resolve to a finite, non-negative start time');
  });

  it('createInitialWorkflowState rejects executionTimeout values that overflow the storage timestamp range', () => {
    expect(() =>
      createInitialWorkflowState(
        {
          options: { getNow: () => Number.MAX_SAFE_INTEGER },
        } as never,
        'workflow-timeout-overflow',
        'workflow',
        null,
        { workflowVersion: '1' },
        { executionTimeout: Number.MAX_SAFE_INTEGER },
        undefined,
        'workflow-timeout-overflow',
        undefined,
        undefined,
        undefined,
        createLifecycleCallbacks() as never,
      ),
    ).toThrow('options.executionTimeout must resolve to a finite, non-negative deadline');
  });

  it('rejects duplicate pending start reservations before writing state', async () => {
    await expect(
      startWorkflow(
        {
          options: { getNow: () => 1_000, payloadSizePolicy: { maxBytes: null } },
          pendingStarts: new Set(['workflow-duplicate-start']),
          registrations: new Map([
            [
              'workflow',
              {
                handler: async function* () {
                  return 'done';
                },
                version: '1',
              },
            ],
          ]),
        } as never,
        'workflow',
        null,
        { id: 'workflow-duplicate-start' },
        undefined,
        createLifecycleCallbacks() as never,
      ),
    ).rejects.toThrow('Workflow with id "workflow-duplicate-start" already exists');
  });

  it('creates pending workflow state with tuple metadata and tags', () => {
    const state = createInitialWorkflowState(
      {
        options: { getNow: () => 10_000 },
      } as never,
      'workflow-pending-state',
      'workflow',
      { value: 1 },
      {
        agentVersion: 'agent-2',
        toolVersions: ['search@3'],
        workflowVersion: '2',
      },
      undefined,
      ['critical'],
      'owner-workflow',
      undefined,
      undefined,
      { fireAt: 20_000, id: 'delay', kind: 'delayed-start', workflowId: 'workflow-pending-state' },
      createLifecycleCallbacks() as never,
    );

    expect(state).toEqual(
      expect.objectContaining({
        executionStateOwnerId: 'owner-workflow',
        status: 'pending',
        tags: ['critical'],
        versionTuple: {
          agentVersion: 'agent-2',
          toolVersions: ['search@3'],
          workflowVersion: '2',
        },
      }),
    );
    expect(state.startedAt).toBeUndefined();
  });

  it('builds version tuples from registrations and stored state', () => {
    const registration = {
      version: 'workflow-1',
    };

    expect(
      createWorkflowVersionTuple(
        {} as never,
        registration as never,
        createLifecycleCallbacks() as never,
      ),
    ).toEqual({ workflowVersion: 'workflow-1' });

    expect(
      workflowVersionTupleFromState(
        {} as never,
        createWorkflowState('workflow-versioned', {
          versionTuple: {
            agentVersion: 'agent-1',
            toolVersions: ['database@4'],
            workflowVersion: 'workflow-1',
          },
        }),
        createLifecycleCallbacks() as never,
      ),
    ).toEqual({
      agentVersion: 'agent-1',
      toolVersions: ['database@4'],
      workflowVersion: 'workflow-1',
    });
  });

  it('keeps prepared resume state unchanged when workflow version metadata matches', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-prepared-resume';
    const state = createWorkflowState(workflowId, {
      versionTuple: {
        workflowVersion: '1',
      },
    });
    const checkpoint = createCheckpoint(workflowId, { locals: { before: true }, version: '1' });
    const registration = {
      version: '1',
    };
    const internals = {
      options: { getNow: () => 30_000 },
      storage,
    };

    const prepared = derivePreparedExecutionState(
      internals as never,
      workflowId,
      state,
      checkpoint,
      registration as never,
      createLifecycleCallbacks() as never,
    );

    expect(prepared.shouldPersistPreparedState).toBe(false);
    expect(prepared.checkpoint).toBe(checkpoint);
    expect(prepared.state).toBe(state);
    expect(prepared.versionTuple).toEqual({ workflowVersion: '1' });

    const preparedForResume = await prepareResumeState(
      internals as never,
      workflowId,
      state,
      checkpoint,
      serializeCheckpoint(checkpoint),
      registration as never,
      createLifecycleCallbacks() as never,
    );

    expect(preparedForResume.serializedCheckpoint).toEqual(serializeCheckpoint(checkpoint));
    expect(await storage.get(KEYS.workflow(workflowId))).toBeNull();
    expect(await storage.get(KEYS.checkpoint(workflowId))).toBeNull();
  });

  it('throws version mismatch errors with tuple drift details', () => {
    const state = createWorkflowState('workflow-version-mismatch', {
      versionTuple: { workflowVersion: '1' },
    });

    expect(() =>
      throwVersionMismatch(
        {} as never,
        state.id,
        state,
        { version: '2' } as never,
        { workflowVersion: ['1', '2'] } as never,
        createLifecycleCallbacks() as never,
      ),
    ).toThrow('Version mismatch for workflow "workflow" (workflow-version-mismatch)');

    expect(() =>
      derivePreparedExecutionState(
        { options: { getNow: () => 1 } } as never,
        state.id,
        state,
        createCheckpoint(state.id, { version: '1' }),
        { version: '2' } as never,
        createLifecycleCallbacks() as never,
      ),
    ).toThrow('Version mismatch for workflow "workflow" (workflow-version-mismatch)');
  });

  it('rewrites workflow state with version tuple metadata', () => {
    expect(
      workflowStateWithVersionTuple(
        { options: { getNow: () => 50_000 } } as never,
        createWorkflowState('workflow-state-version', {
          versionTuple: {
            agentVersion: 'old-agent',
            toolVersions: ['old@1'],
          },
        }),
        {
          agentVersion: 'new-agent',
          toolVersions: ['new@2'],
          workflowVersion: '3',
        },
        createLifecycleCallbacks() as never,
      ),
    ).toEqual(
      expect.objectContaining({
        updatedAt: 50_000,
        versionTuple: {
          agentVersion: 'new-agent',
          toolVersions: ['new@2'],
          workflowVersion: '3',
        },
      }),
    );
  });

  it('validates registered search attributes and builds index operations', () => {
    const registration = {
      searchAttributes: { env: { type: 'string' } },
      version: '1',
    };

    expect(() =>
      validateSearchAttributes(
        {} as never,
        registration as never,
        { missing: 'test' },
        createLifecycleCallbacks() as never,
      ),
    ).toThrow('Unknown search attribute "missing". Registered attributes: env');

    expect(
      buildInitialSearchAttributeOperations(
        {} as never,
        'workflow-search',
        registration as never,
        { env: 'test' },
        createLifecycleCallbacks() as never,
      ).map((operation) => operation.type),
    ).toEqual(['put', 'put']);
  });

  it('runs workflow start interceptors with copied parent headers', () => {
    const captured = runWorkflowStartInterceptor(
      {} as never,
      'workflow-intercepted-start',
      'workflow',
      { value: 1 },
      new Map([['traceparent', '00-parent']]),
      createLifecycleCallbacks({
        getComposedWorkflowInterceptor: () =>
          ({
            workflowStart: (
              interception: WorkflowStartInterception,
              next: (interception: WorkflowStartInterception) => void,
            ) => {
              interception.headers.set('x-added', 'yes');
              next(interception);
            },
          }) as never,
      }) as never,
    );

    expect(captured).toEqual(
      new Map([
        ['traceparent', '00-parent'],
        ['x-added', 'yes'],
      ]),
    );
  });

  it('sets, clears, and persists workflow start headers', () => {
    const internals = {
      workflowHeaders: new Map<string, Map<string, string>>(),
      workflowsNeedingTerminalCleanup: new Set<string>(),
    };

    setWorkflowStartHeaders(
      internals as never,
      'workflow-headers',
      new Map([['traceparent', '00-header']]),
      createLifecycleCallbacks() as never,
    );
    expect(internals.workflowHeaders.get('workflow-headers')).toEqual(
      new Map([['traceparent', '00-header']]),
    );
    expect(internals.workflowsNeedingTerminalCleanup.has('workflow-headers')).toBe(true);

    setWorkflowStartHeaders(
      internals as never,
      'workflow-headers',
      undefined,
      createLifecycleCallbacks() as never,
    );
    expect(internals.workflowHeaders.has('workflow-headers')).toBe(false);
  });

  it('builds start batches with headers, additional operations, and timers', () => {
    const workflowId = 'workflow-start-batch';
    const operations = buildStartBatchOperations(
      {} as never,
      workflowId,
      createWorkflowState(workflowId, { tags: ['batch'] }),
      createCheckpoint(workflowId),
      { searchAttributes: { env: { type: 'string' } }, version: '1' } as never,
      { searchAttributes: { env: 'test' } },
      20_000,
      { fireAt: 15_000, id: 'delay', kind: 'delayed-start', workflowId },
      new Map([['traceparent', '00-batch']]),
      [{ key: 'extra-key', type: 'put', value: new Uint8Array([1]) }],
      createLifecycleCallbacks() as never,
      undefined,
    );

    expect(operations.some((operation) => operation.key === KEYS.workflowHeaders(workflowId))).toBe(
      true,
    );
    expect(operations.some((operation) => operation.key === 'extra-key')).toBe(true);
    expect(operations.filter((operation) => operation.key.startsWith('timer-idx:')).length).toBe(2);
  });

  it('prepends restart purge deletes ahead of the create puts', () => {
    const workflowId = 'workflow-start-batch-purge';
    const operations = buildStartBatchOperations(
      {} as never,
      workflowId,
      createWorkflowState(workflowId),
      createCheckpoint(workflowId),
      { version: '1' } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLifecycleCallbacks() as never,
      // A delete for the SAME key the create writes a put for: the prepend means
      // the put follows the delete, so last-op-wins keeps the new run's state.
      [{ key: KEYS.workflow(workflowId), type: 'delete' }],
    );

    const stateKey = KEYS.workflow(workflowId);
    const deleteIndex = operations.findIndex(
      (operation) => operation.key === stateKey && operation.type === 'delete',
    );
    const putIndex = operations.findIndex(
      (operation) => operation.key === stateKey && operation.type === 'put',
    );
    expect(deleteIndex).toBe(0);
    expect(putIndex).toBeGreaterThan(deleteIndex);
  });

  it('keeps representative purge and restart-create batches below MAX_BATCH_OPERATIONS', async () => {
    const workflowId = 'workflow-start-batch-cap';
    const storage = new MemoryStorage();
    const attributes = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [`attribute-${index}`, `value-${index}`]),
    );
    const storageValue = new Uint8Array([1]);
    const seedOperations: BatchOperation[] = Array.from({ length: 200 }, (_, index) => [
      { type: 'put' as const, key: KEYS.checkpointHistory(workflowId, index), value: storageValue },
      { type: 'put' as const, key: KEYS.event(workflowId, index), value: storageValue },
      {
        type: 'put' as const,
        key: KEYS.signal(workflowId, 'release', `signal-${index}`),
        value: storageValue,
      },
    ]).flat();
    seedOperations.push({
      type: 'put',
      key: KEYS.attribute(workflowId),
      value: encode(attributes),
    });
    await storage.batch(seedOperations);

    const priorState = createWorkflowState(workflowId, {
      status: 'completed',
      tags: Array.from({ length: MAX_WORKFLOW_TAGS }, (_, index) => `tag-${index}`),
      updatedAt: 20_000,
    });
    const purgeDeleteOperations = await collectWorkflowPurgeDeleteOperations(
      { storage } as never,
      priorState,
    );
    const restartOperations = buildStartBatchOperations(
      {} as never,
      workflowId,
      createWorkflowState(workflowId),
      createCheckpoint(workflowId),
      { version: '1' } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createLifecycleCallbacks() as never,
      purgeDeleteOperations,
    );

    expect(purgeDeleteOperations.length).toBeGreaterThan(seedOperations.length);
    expect(purgeDeleteOperations.length).toBeLessThan(MAX_BATCH_OPERATIONS / 2);
    expect(restartOperations.length).toBeLessThan(MAX_BATCH_OPERATIONS / 2);
  });

  it('begins worker workflow execution directly when inline execution is disabled', () => {
    const startWorkflowStrategy = mock(() => {});
    const dispatchEvent = mock(() => {});
    const checkpoint = createCheckpoint('workflow-begin-worker');
    const internals = {
      inlineStrategy: null,
      pendingNestingDepth: 2,
      strategy: { startWorkflow: startWorkflowStrategy },
      workflowHeaders: new Map([
        ['workflow-begin-worker', new Map([['traceparent', '00-worker']])],
      ]),
      workflowNestingDepths: new Map<string, number>(),
      workflowTypeByWorkflowId: new Map<string, string>(),
    };

    beginWorkflowExecution(
      internals as never,
      'workflow-begin-worker',
      undefined,
      'workflow',
      { value: 1 },
      checkpoint,
      25_000,
      'owner-workflow',
      { version: '1' } as never,
      createLifecycleCallbacks({ dispatchEvent }) as never,
    );

    expect(dispatchEvent).toHaveBeenCalled();
    expect(startWorkflowStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        deadline: 25_000,
        headers: [['traceparent', '00-worker']],
        nestingDepth: 2,
      }),
    );
    expect(internals.pendingNestingDepth).toBeUndefined();
  });

  it('starts workflow execution with zero-depth and nested metadata', () => {
    const startWorkflowStrategy = mock(() => {});
    const internals = {
      strategy: { startWorkflow: startWorkflowStrategy },
      workflowHeaders: new Map<string, Map<string, string>>(),
      workflowNestingDepths: new Map<string, number>(),
      workflowTypeByWorkflowId: new Map<string, string>(),
    };
    const checkpoint = createCheckpoint('workflow-start-execution');

    startWorkflowExecution(
      internals as never,
      'workflow-start-execution',
      undefined,
      'workflow',
      null,
      checkpoint,
      0,
      undefined,
      'workflow-start-execution',
      undefined,
    );

    startWorkflowExecution(
      internals as never,
      'workflow-start-execution-nested',
      undefined,
      'workflow',
      null,
      checkpoint,
      3,
      undefined,
      'owner-workflow',
      undefined,
    );

    expect(internals.workflowNestingDepths.has('workflow-start-execution')).toBe(false);
    expect(internals.workflowNestingDepths.get('workflow-start-execution-nested')).toBe(3);
    expect(startWorkflowStrategy).toHaveBeenCalledTimes(2);
  });

  it('builds fork lineage, state, search attributes, and batch operations', () => {
    const sourceCheckpoint = createCheckpoint('workflow-source', {
      searchAttributes: { env: 'test' },
      step: 4,
    });
    const lineage = createForkLineage(
      {} as never,
      'workflow-source',
      sourceCheckpoint,
      createLifecycleCallbacks() as never,
    );
    const forkedState = createForkedWorkflowState(
      {} as never,
      'workflow-fork',
      createWorkflowState('workflow-source'),
      {
        agentVersion: 'agent-1',
        toolVersions: ['tool@1'],
        workflowVersion: '2',
      },
      lineage,
      70_000,
      createLifecycleCallbacks() as never,
    );
    const forkCheckpoint = {
      ...sourceCheckpoint,
      searchAttributes: buildForkSearchAttributes(
        {} as never,
        sourceCheckpoint,
        lineage,
        createLifecycleCallbacks() as never,
      ),
      workflowId: 'workflow-fork',
    };

    const operations = buildForkBatchOperations(
      {} as never,
      'workflow-fork',
      forkedState,
      forkCheckpoint,
      serializeCheckpoint(forkCheckpoint),
      new Map([['traceparent', '00-fork']]),
      createLifecycleCallbacks() as never,
    );

    expect(lineage).toEqual({ step: 4, workflowId: 'workflow-source' });
    expect(forkedState).toEqual(
      expect.objectContaining({
        forkedFrom: lineage,
        workflowExecutionToken: expect.any(String),
        versionTuple: {
          agentVersion: 'agent-1',
          toolVersions: ['tool@1'],
          workflowVersion: '2',
        },
      }),
    );
    expect(forkCheckpoint.searchAttributes).toEqual({
      env: 'test',
      'weft:forkedFrom': 'workflow-source',
    });
    expect(
      operations.some((operation) => operation.key === KEYS.workflowHeaders('workflow-fork')),
    ).toBe(true);
  });

  it('normalizes start workflow tags', () => {
    expect(
      normalizeStartWorkflowTags(
        {} as never,
        [' Critical ', 'critical', 'Release'],
        'options.tags',
        createLifecycleCallbacks() as never,
      ),
    ).toEqual(['critical', 'Critical', 'Release']);
  });

  it('processPendingUpdatesAfterReplay routes handler failures through cleanup handling', async () => {
    const error = new Error('pending-update cleanup failed');
    const handleCleanupError = mock(() => {});

    await processPendingUpdatesAfterReplay({} as never, 'workflow-pending-update', {
      handleCleanupError,
      processPendingUpdatesForHandlers: async () => {
        throw error;
      },
    });

    expect(handleCleanupError).toHaveBeenCalledWith(
      'processPendingUpdates',
      error,
      'workflow-pending-update',
    );
  });

  it('launchWorkflowFromCheckpoint starts worker-mode workflows with headers and deadlines', () => {
    const startWorkflowStrategy = mock(() => {});
    const dispatchEvent = mock(() => {});
    const internals = {
      checkpoints: new Map<string, Checkpoint>(),
      inlineStrategy: null,
      registrations: new Map(),
      strategy: { startWorkflow: startWorkflowStrategy },
      workflowHeaders: new Map([['workflow-worker-launch', new Map([['x-test', '1']])]]),
      workflowVersionTuples: new Map(),
    };
    const checkpoint = createCheckpoint('workflow-worker-launch', {
      searchAttributes: { env: 'test' },
      createdAt: 4_000,
    });
    const state = createWorkflowState('workflow-worker-launch', {
      executionDeadline: 9_000,
      type: 'worker-launch',
    });
    const handle = { id: 'workflow-worker-launch' };

    const returnedHandle = launchWorkflowFromCheckpoint(
      internals as never,
      state.id,
      state,
      checkpoint,
      {
        handler: async function* () {
          return 'done';
        },
        version: '1',
      },
      createLifecycleCallbacks({
        createWorkflowHandleWithResultPromise: () => handle,
        dispatchEvent,
      }) as never,
    );

    expect(returnedHandle.id).toBe(handle.id);
    expect(internals.checkpoints.get(state.id)).toEqual(checkpoint);
    expect(internals.workflowVersionTuples.get(state.id)).toEqual({ workflowVersion: '1' });
    expect(startWorkflowStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: serializeCheckpoint(checkpoint),
        deadline: 9_000,
        executionStateOwnerId: state.id,
        headers: [['x-test', '1']],
        input: state.input,
        workflowId: state.id,
        workflowType: 'worker-launch',
      }),
    );
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('launchWorkflowFromCheckpoint starts inline workflows with development explanation enabled', () => {
    const adoptWorkflow = mock(() => {});
    const continueWorkflow = mock(() => {});
    const internals = {
      checkpoints: new Map<string, Checkpoint>(),
      composedWorkflowInterceptor: undefined,
      inlineStrategy: { adoptWorkflow, continueWorkflow },
      interceptors: [],
      options: { development: true, getNow: () => 1_000 },
      strategy: { startWorkflow: mock(() => {}) },
      workflowHeaders: new Map<string, Map<string, string>>(),
      workflowVersionTuples: new Map(),
    };
    const workflowId = 'workflow-inline-launch';

    const handle = launchWorkflowFromCheckpoint(
      internals as never,
      workflowId,
      createWorkflowState(workflowId, {
        executionDeadline: 9_000,
      }),
      createCheckpoint(workflowId, { accumulatedResults: [[0, 'cached']] }),
      {
        handler: async function* () {
          return 'done';
        },
        searchAttributes: { env: 'string' },
        version: '1',
      } as never,
      createLifecycleCallbacks({
        createWorkflowHandleWithResultPromise: () => ({ id: workflowId }),
      }) as never,
    );

    expect(handle.id).toBe(workflowId);
    expect(adoptWorkflow).toHaveBeenCalledWith(
      workflowId,
      expect.any(Object),
      expect.objectContaining({
        workflowId,
      }),
      expect.any(AbortController),
    );
    expect(continueWorkflow).toHaveBeenCalledWith(workflowId, undefined);
  });

  it('launchWorkflowFromCheckpoint rejects inconsistent inline launch state', () => {
    let inlineStrategyReads = 0;
    const internals = {
      checkpoints: new Map<string, Checkpoint>(),
      get inlineStrategy() {
        inlineStrategyReads++;
        return inlineStrategyReads === 1 ? {} : null;
      },
      options: { development: false, getNow: () => 1_000 },
      strategy: { startWorkflow: mock(() => {}) },
      workflowVersionTuples: new Map(),
    };
    const workflowId = 'workflow-inline-inconsistent';

    expect(() =>
      launchWorkflowFromCheckpoint(
        internals as never,
        workflowId,
        createWorkflowState(workflowId),
        createCheckpoint(workflowId),
        {
          handler: async function* () {
            return 'done';
          },
          version: '1',
        },
        createLifecycleCallbacks() as never,
      ),
    ).toThrow('Inline workflow launch requested without an inline strategy.');
  });

  it('resumeWorkflowFromStorage rejects non-running stored states before loading a checkpoint', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-resume-completed';

    await storage.put(
      KEYS.workflow(workflowId),
      encode(createWorkflowState(workflowId, { status: 'completed' })),
    );

    await expect(
      resumeWorkflowFromStorage(
        {
          registrations: new Map(),
          storage,
        } as never,
        workflowId,
        true,
        createLifecycleCallbacks() as never,
      ),
    ).rejects.toThrow('Cannot resume workflow "workflow-resume-completed": status is "completed"');
  });

  it('resumeWorkflowFromStorage rejects running states whose workflow type is no longer registered', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-resume-missing-registration';

    await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));
    await storage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );

    await expect(
      resumeWorkflowFromStorage(
        {
          registrations: new Map(),
          storage,
          options: { ownershipMode: 'none' },
        } as never,
        workflowId,
        true,
        createLifecycleCallbacks() as never,
      ),
    ).rejects.toThrow(
      'No workflow registered with name "workflow" (needed to resume "workflow-resume-missing-registration")',
    );
  });

  it('resumeWorkflowFromStorage rejects running states without checkpoints', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-resume-missing-checkpoint';

    await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));

    await expect(
      resumeWorkflowFromStorage(
        {
          registrations: new Map(),
          storage,
          options: { ownershipMode: 'none' },
        } as never,
        workflowId,
        true,
        createLifecycleCallbacks() as never,
      ),
    ).rejects.toThrow('Checkpoint not found for workflow "workflow-resume-missing-checkpoint"');
  });

  it('resumeWorkflowFromStorage rejects when termination starts during the serialized resume write', async () => {
    const baseStorage = new MemoryStorage();
    const workflowId = 'workflow-resume-terminalizing';
    let workflowStateReads = 0;
    const terminalizingWorkflows = new Set<string>();
    const storage = {
      delete: baseStorage.delete.bind(baseStorage),
      put: baseStorage.put.bind(baseStorage),
      scan: baseStorage.scan.bind(baseStorage),
      batch: baseStorage.batch.bind(baseStorage),
      async get(key: string) {
        const value = await baseStorage.get(key);
        if (key === KEYS.workflow(workflowId)) {
          workflowStateReads++;
          if (workflowStateReads === 2) {
            terminalizingWorkflows.add(workflowId);
          }
        }
        return value;
      },
      [Symbol.dispose]() {
        baseStorage[Symbol.dispose]();
      },
    };

    await baseStorage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));
    await baseStorage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );

    await expect(
      resumeWorkflowFromStorage(
        createResumeWorkflowFromStorageInternals({
          storage,
          terminalizingWorkflows,
        }),
        workflowId,
        true,
        createLifecycleCallbacks({
          getHandle: () => ({ id: workflowId }),
        }) as never,
      ),
    ).rejects.toThrow(`Cannot resume workflow "${workflowId}": termination is in progress`);
  });

  it('resumeWorkflowFromStorage rejects when state disappears during the serialized resume write', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-resume-disappears';

    await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));
    await storage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );

    await expect(
      resumeWorkflowFromStorage(
        createResumeWorkflowFromStorageInternals({
          storage,
        }),
        workflowId,
        true,
        createLifecycleCallbacks({
          getHandle: () => ({ id: workflowId }),
          runSerializedWorkflowStateWrite: async <Result>(
            _workflowId: string,
            writeOperation: () => Promise<Result>,
          ) => {
            await storage.delete(KEYS.workflow(workflowId));
            return writeOperation();
          },
        }) as never,
      ),
    ).rejects.toThrow(`Workflow "${workflowId}" not found in storage`);
  });

  it('resumeWorkflowFromStorage replays worker-mode workflows through the execution strategy', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-resume-worker-mode';
    const startWorkflowStrategy = mock(() => {});
    const dispatchEvent = mock(() => {});
    const workflowState = createWorkflowState(workflowId, {
      executionDeadline: 15_000,
      type: 'worker-resume',
    });
    const checkpoint = createCheckpoint(workflowId, {
      searchAttributes: { region: 'us-west-2' },
      createdAt: 5_000,
      step: 3,
    });

    await storage.put(KEYS.workflow(workflowId), encode(workflowState));
    await storage.put(KEYS.checkpoint(workflowId), serializeCheckpoint(checkpoint));
    await storage.put(KEYS.workflowHeaders(workflowId), encode([['traceparent', '00-test']]));
    await storage.put(KEYS.terminalCleanupNeeded(workflowId), new Uint8Array());

    const handle = { id: workflowId };
    const internals = {
      checkpoints: new Map<string, Checkpoint>(),
      eventLogHeads: new Map(),
      inlineStrategy: null,
      options: { development: false, getNow: () => 20_000, historyPolicy: { maxEvents: null } },
      parkedInlineWorkflows: new Set<string>(),
      registrations: new Map([
        [
          'worker-resume',
          {
            handler: async function* () {
              return 'done';
            },
            version: '1',
          },
        ],
      ]),
      storage,
      strategy: { startWorkflow: startWorkflowStrategy },
      terminalizingWorkflows: new Set<string>(),
      workflowHeaders: new Map<string, Map<string, string>>(),
      workflowNestingDepths: new Map([[workflowId, 2]]),
      workflowTypeByWorkflowId: new Map<string, string>(),
      workflowVersionTuples: new Map<string, { workflowVersion: string }>(),
      workflowsNeedingTerminalCleanup: new Set<string>(),
    };

    const resumedHandle = await resumeWorkflowFromStorage(
      internals as never,
      workflowId,
      true,
      createLifecycleCallbacks({
        dispatchEvent,
        getHandle: () => handle,
      }) as never,
    );

    expect(resumedHandle.id).toBe(handle.id);
    expect(internals.checkpoints.get(workflowId)).toEqual(checkpoint);
    expect(internals.workflowVersionTuples.get(workflowId)).toEqual({ workflowVersion: '1' });
    expect(internals.workflowHeaders.get(workflowId)).toEqual(
      new Map([['traceparent', '00-test']]),
    );
    expect(internals.workflowsNeedingTerminalCleanup.has(workflowId)).toBe(true);
    expect(startWorkflowStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: serializeCheckpoint(checkpoint),
        deadline: 15_000,
        executionStateOwnerId: workflowId,
        headers: [['traceparent', '00-test']],
        input: workflowState.input,
        nestingDepth: 2,
        workflowId,
        workflowType: 'worker-resume',
      }),
    );
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('startWorkflow fires interceptor, persistence, handle creation, and start event in order', async () => {
    const engine = new Engine();
    const callbackOrderWorkflowWorkflow = workflow({ name: 'callback-order-workflow' }).execute(
      async function* () {
        return 'done';
      },
    );
    engine.register(callbackOrderWorkflowWorkflow);

    const events: string[] = [];
    const internals = getInternals(engine);

    const composedInterceptor = {
      workflowStart: (
        ctx: WorkflowStartInterception,
        next: (value: WorkflowStartInterception) => void,
      ) => {
        events.push('interceptor:workflowStart');
        next(ctx);
      },
      activityCall: (_ctx: unknown, next: (value: unknown) => unknown) => next(_ctx),
      workflowComplete: (_ctx: unknown, next: (value: unknown) => unknown) => next(_ctx),
      childWorkflowCall: (_ctx: unknown, next: (value: unknown) => unknown) => next(_ctx),
      signalEmit: (_ctx: unknown, next: (value: unknown) => unknown) => next(_ctx),
      updateCall: (_ctx: unknown, next: (value: unknown) => unknown) => next(_ctx),
    } as never;
    const baseCallbacks = createEngineLifecycleCallbacks(engine);
    const callbacks = {
      ...baseCallbacks,
      getComposedWorkflowInterceptor: () => composedInterceptor,
      createWorkflowHandleWithResultPromise: (workflowId: string) => {
        events.push('createHandle');
        return baseCallbacks.createWorkflowHandleWithResultPromise(workflowId);
      },
    };

    const originalBatch = internals.storage.batch.bind(internals.storage);
    internals.storage.batch = async (operations) => {
      events.push('storage:batch');
      return originalBatch(operations);
    };

    engine.addEventListener('workflow:started', () => {
      events.push('dispatch:workflow:started');
    });

    const handle = await startWorkflow(
      internals,
      'callback-order-workflow',
      { value: 1 },
      undefined,
      undefined,
      callbacks,
    );

    await handle.result();

    // Critical firing order during startWorkflow:
    //  1. interceptor runs before persistence so it can mutate headers
    //  2. storage batch occurs before the handle is created
    //  3. handle is created before the WorkflowStartedEvent dispatches
    const startedIndexes = events
      .map((event, index) => (event === 'dispatch:workflow:started' ? index : -1))
      .filter((index) => index >= 0);
    const startIndex = events.indexOf('interceptor:workflowStart');
    const batchIndex = events.indexOf('storage:batch');
    const handleIndex = events.indexOf('createHandle');

    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(batchIndex).toBeGreaterThan(startIndex);
    expect(handleIndex).toBeGreaterThan(batchIndex);
    // WorkflowStartedEvent should fire at least once after the handle exists.
    expect(startedIndexes.length).toBeGreaterThan(0);
    expect(Math.min(...startedIndexes)).toBeGreaterThan(handleIndex);

    engine[Symbol.dispose]();
  });
});
