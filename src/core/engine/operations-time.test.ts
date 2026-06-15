import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { serializeCheckpoint } from '../checkpoint/serialization.ts';
import { encode } from '../codec.ts';
import { DevelopmentWarningEvent } from '../events.ts';
import type { Checkpoint, TimerEntry, WorkflowState } from '../types.ts';
import { startDelayedWorkflow, type TimeOperationCallbacks } from './operations-time.ts';

function createWorkflowState(
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: 1_000,
    id: workflowId,
    input: { value: 1 },
    status: 'pending',
    type: 'delayed-workflow',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

function createCheckpoint(workflowId: string): Checkpoint {
  return {
    accumulatedResults: [],
    createdAt: 1_000,
    locals: {},
    schemaVersion: 2,
    searchAttributes: {},
    step: 0,
    version: '1',
    workflowId,
  };
}

function createDelayedStartEntry(
  workflowId: string,
  overrides: Partial<TimerEntry> = {},
): TimerEntry {
  return {
    fireAt: 2_000,
    id: `delayed-start:${workflowId}`,
    kind: 'delayed-start',
    workflowId,
    ...overrides,
  };
}

function createCallbacks(
  overrides: Partial<TimeOperationCallbacks> = {},
): Pick<
  TimeOperationCallbacks,
  | 'beginWorkflowExecution'
  | 'dispatchEvent'
  | 'failWorkflow'
  | 'handleCleanupError'
  | 'loadWorkflowStartHeaders'
  | 'loadWorkflowState'
  | 'runSerializedWorkflowStateWrite'
  | 'setWorkflowStartHeaders'
  | 'workflowVersionTupleFromState'
> {
  return {
    beginWorkflowExecution: mock(() => {}),
    dispatchEvent: mock(() => {}),
    failWorkflow: mock(async () => {}),
    handleCleanupError: mock(() => {}),
    loadWorkflowStartHeaders: mock(async () => undefined),
    loadWorkflowState: mock(async () => null),
    runSerializedWorkflowStateWrite: async (_workflowId, writeOperation) => writeOperation(),
    setWorkflowStartHeaders: mock(() => {}),
    workflowVersionTupleFromState: () => ({ workflowVersion: '1' }),
    ...overrides,
  };
}

type DelayedStartServicesFixture = {
  beginWorkflowExecution: () => void;
  failed: Array<[string, Error]>;
  failWorkflow(id: string, error: Error): Promise<void>;
  registration: { handler: () => AsyncGenerator<unknown, void, unknown>; version: string };
  state: WorkflowState;
  storage: MemoryStorage;
  workflowId: string;
};

async function createDelayedStartServicesFixture(
  workflowId: string,
): Promise<DelayedStartServicesFixture> {
  const storage = new MemoryStorage();
  const state = createWorkflowState(workflowId);
  const checkpoint = createCheckpoint(workflowId);
  const registration = { handler: async function* () {}, version: '1' };
  const beginWorkflowExecution = mock(() => {});
  const failed: Array<[string, Error]> = [];
  const failWorkflow = async (id: string, error: Error): Promise<void> => {
    failed.push([id, error]);
  };

  await storage.put(KEYS.workflow(workflowId), encode(state));
  await storage.put(KEYS.checkpoint(workflowId), serializeCheckpoint(checkpoint));
  await storage.put(KEYS.workflowHasServices(workflowId), new Uint8Array(0));

  return {
    beginWorkflowExecution,
    failed,
    failWorkflow,
    registration,
    state,
    storage,
    workflowId,
  };
}

describe('engine time operation helpers', () => {
  it('ignores delayed-start timers for missing or non-pending workflows', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-delayed-not-pending';
    const failWorkflow = mock(async () => {});

    await startDelayedWorkflow(
      { options: { getNow: () => 2_000 }, registrations: new Map(), storage } as never,
      createDelayedStartEntry(workflowId),
      createCallbacks({
        failWorkflow,
        loadWorkflowState: async () => createWorkflowState(workflowId, { status: 'running' }),
      }),
    );

    expect(failWorkflow).not.toHaveBeenCalled();
  });

  it('fails delayed-start workflows with missing checkpoint or registration data', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-delayed-missing-data';
    const state = createWorkflowState(workflowId);
    const failWorkflow = mock(async () => {});

    await startDelayedWorkflow(
      { options: { getNow: () => 2_000 }, registrations: new Map(), storage } as never,
      createDelayedStartEntry(workflowId),
      createCallbacks({ failWorkflow, loadWorkflowState: async () => state }),
    );

    expect(failWorkflow).toHaveBeenCalledWith(
      workflowId,
      expect.objectContaining({
        message: `Checkpoint not found for delayed workflow "${workflowId}"`,
      }),
    );

    failWorkflow.mockClear();
    await storage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );

    await startDelayedWorkflow(
      { options: { getNow: () => 2_000 }, registrations: new Map(), storage } as never,
      createDelayedStartEntry(workflowId),
      createCallbacks({ failWorkflow, loadWorkflowState: async () => state }),
    );

    expect(failWorkflow).toHaveBeenCalledWith(
      workflowId,
      expect.objectContaining({
        message: `No workflow registered with name "${state.type}"`,
      }),
    );
  });

  it('fails delayed-start workflows with invalid execution timeout values', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-delayed-invalid-timeout';
    const state = createWorkflowState(workflowId);
    const failWorkflow = mock(async () => {});
    const registration = { handler: async function* () {}, version: '1' };

    await storage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );

    await startDelayedWorkflow(
      {
        options: { getNow: () => 2_000 },
        registrations: new Map([[state.type, registration]]),
        storage,
      } as never,
      createDelayedStartEntry(workflowId, { executionTimeoutMs: -1 }),
      createCallbacks({ failWorkflow, loadWorkflowState: async () => state }),
    );

    expect(failWorkflow).toHaveBeenCalledWith(
      workflowId,
      expect.objectContaining({
        message: `Invalid delayed execution timeout for workflow "${workflowId}"`,
      }),
    );

    failWorkflow.mockClear();
    await startDelayedWorkflow(
      {
        options: { getNow: () => Number.MAX_SAFE_INTEGER },
        registrations: new Map([[state.type, registration]]),
        storage,
      } as never,
      createDelayedStartEntry(workflowId, { executionTimeoutMs: Number.MAX_SAFE_INTEGER }),
      createCallbacks({ failWorkflow, loadWorkflowState: async () => state }),
    );

    expect(failWorkflow).toHaveBeenCalledWith(
      workflowId,
      expect.objectContaining({
        message: `Invalid delayed execution timeout for workflow "${workflowId}"`,
      }),
    );
  });

  it('starts delayed workflows only when serialized state is still pending', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-delayed-start';
    const state = createWorkflowState(workflowId, { executionStateOwnerId: 'owner-workflow' });
    const checkpoint = createCheckpoint(workflowId);
    const registration = { handler: async function* () {}, version: '1' };
    const beginWorkflowExecution = mock(() => {});
    const setWorkflowStartHeaders = mock(() => {});

    await storage.put(KEYS.workflow(workflowId), encode(state));
    await storage.put(KEYS.checkpoint(workflowId), serializeCheckpoint(checkpoint));

    await startDelayedWorkflow(
      {
        checkpoints: new Map<string, Checkpoint>(),
        inlineStrategy: {},
        workflowServices: new Map<string, unknown>(),
        options: { getNow: () => 2_000 },
        registrations: new Map([[state.type, registration]]),
        storage,
        workflowVersionTuples: new Map(),
      } as never,
      createDelayedStartEntry(workflowId, { executionTimeoutMs: 500 }),
      createCallbacks({
        beginWorkflowExecution,
        loadWorkflowStartHeaders: async () => new Map([['traceparent', '00-test']]),
        loadWorkflowState: async () => state,
        setWorkflowStartHeaders,
      }),
    );

    expect(beginWorkflowExecution).toHaveBeenCalledWith(
      workflowId,
      state.type,
      state.input,
      checkpoint,
      2_500,
      'owner-workflow',
      registration,
    );
    expect(setWorkflowStartHeaders).toHaveBeenCalledWith(
      workflowId,
      new Map([['traceparent', '00-test']]),
    );

    beginWorkflowExecution.mockClear();
    let loadCount = 0;
    await startDelayedWorkflow(
      {
        checkpoints: new Map<string, Checkpoint>(),
        inlineStrategy: {},
        workflowServices: new Map<string, unknown>(),
        options: { getNow: () => 3_000 },
        registrations: new Map([[state.type, registration]]),
        storage,
        workflowVersionTuples: new Map(),
      } as never,
      createDelayedStartEntry(workflowId),
      createCallbacks({
        beginWorkflowExecution,
        loadWorkflowState: mock(async () => {
          loadCount += 1;
          return createWorkflowState(workflowId, {
            status: loadCount === 1 ? 'pending' : 'completed',
          });
        }),
        runSerializedWorkflowStateWrite: async (_workflowId, writeOperation) => {
          return writeOperation();
        },
      }),
    );

    expect(beginWorkflowExecution).not.toHaveBeenCalled();
  });

  it('fails a recovered delayed-start run whose services the resolver reports unavailable', async () => {
    const fixture = await createDelayedStartServicesFixture('workflow-delayed-no-services');
    // This run WAS launched with services, so its durable "expects services"
    // marker is present — that is what makes the recovery seam consult the
    // resolver on this fresh-process timer firing.

    await startDelayedWorkflow(
      {
        checkpoints: new Map<string, Checkpoint>(),
        // Inline engine with an empty services map (fresh-process recovery) and a
        // resolver that reports the run unavailable.
        inlineStrategy: {},
        workflowServices: new Map<string, unknown>(),
        options: {
          getNow: () => 2_000,
          resolveWorkflowServices: () => ({ status: 'unavailable', reason: 'no config' }),
        },
        registrations: new Map([[fixture.state.type, fixture.registration]]),
        storage: fixture.storage,
        workflowVersionTuples: new Map(),
      } as never,
      createDelayedStartEntry(fixture.workflowId, { executionTimeoutMs: 500 }),
      createCallbacks({
        beginWorkflowExecution: fixture.beginWorkflowExecution,
        failWorkflow: fixture.failWorkflow,
        loadWorkflowState: async () => fixture.state,
        runSerializedWorkflowStateWrite: async (_workflowId, writeOperation) => writeOperation(),
      }),
    );

    // The run is failed with the canonical unavailable-services error, and the
    // generator is never started.
    expect(fixture.failed).toHaveLength(1);
    expect(fixture.failed[0]![1].message).toContain('services unavailable');
    expect(fixture.beginWorkflowExecution).not.toHaveBeenCalled();
  });

  it('fails a recovered delayed-start run and warns when it expected services but no resolver is configured', async () => {
    const fixture = await createDelayedStartServicesFixture('workflow-delayed-missing-resolver');
    const warnings: DevelopmentWarningEvent[] = [];

    await startDelayedWorkflow(
      {
        checkpoints: new Map<string, Checkpoint>(),
        inlineStrategy: {},
        workflowServices: new Map<string, unknown>(),
        options: { getNow: () => 2_000 },
        registrations: new Map([[fixture.state.type, fixture.registration]]),
        storage: fixture.storage,
        workflowVersionTuples: new Map(),
      } as never,
      createDelayedStartEntry(fixture.workflowId, { executionTimeoutMs: 500 }),
      createCallbacks({
        beginWorkflowExecution: fixture.beginWorkflowExecution,
        dispatchEvent: (event) => {
          if (event instanceof DevelopmentWarningEvent) {
            warnings.push(event);
          }
        },
        failWorkflow: fixture.failWorkflow,
        loadWorkflowState: async () => fixture.state,
        runSerializedWorkflowStateWrite: async (_workflowId, writeOperation) => writeOperation(),
      }),
    );

    expect(fixture.failed).toHaveLength(1);
    expect(fixture.failed[0]![1].message).toContain('resolveWorkflowServices');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe(fixture.workflowId);
    expect(warnings[0]!.message).toContain('resolveWorkflowServices');
    expect(fixture.beginWorkflowExecution).not.toHaveBeenCalled();
  });

  it('starts a recovered delayed-start run with no services without consulting the resolver', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-delayed-plain';
    const state = createWorkflowState(workflowId, { executionStateOwnerId: workflowId });
    const checkpoint = createCheckpoint(workflowId);
    const registration = { handler: async function* () {}, version: '1' };
    const beginWorkflowExecution = mock(() => {});
    let resolverCalls = 0;
    const failed: Array<[string, Error]> = [];
    const failWorkflow = async (id: string, error: Error): Promise<void> => {
      failed.push([id, error]);
    };

    await storage.put(KEYS.workflow(workflowId), encode(state));
    await storage.put(KEYS.checkpoint(workflowId), serializeCheckpoint(checkpoint));
    // No `wf-has-services` marker: this run was started WITHOUT services. A
    // fail-closed resolver must NOT be consulted, and the run must start normally.

    await startDelayedWorkflow(
      {
        checkpoints: new Map<string, Checkpoint>(),
        inlineStrategy: {},
        workflowServices: new Map<string, unknown>(),
        options: {
          getNow: () => 2_000,
          resolveWorkflowServices: () => {
            resolverCalls += 1;
            return { status: 'unavailable', reason: 'should never be consulted' };
          },
        },
        registrations: new Map([[state.type, registration]]),
        storage,
        workflowVersionTuples: new Map(),
      } as never,
      createDelayedStartEntry(workflowId, { executionTimeoutMs: 500 }),
      createCallbacks({
        beginWorkflowExecution,
        failWorkflow,
        loadWorkflowState: async () => state,
        runSerializedWorkflowStateWrite: async (_workflowId, writeOperation) => writeOperation(),
      }),
    );

    // The resolver was never consulted and the generator was started normally.
    expect(resolverCalls).toBe(0);
    expect(failed).toHaveLength(0);
    expect(beginWorkflowExecution).toHaveBeenCalledTimes(1);
  });

  // Both delayed-start terminal-cleanup tests share the same recovery harness:
  // seed a workflow + checkpoint, run startDelayedWorkflow against a fresh-process
  // internals object (empty in-memory cleanup set), and observe whether the run
  // re-joins the set. They differ only in whether the durable terminalCleanupNeeded
  // marker is present, so the marker decision and the final assertion stay at the
  // call site while this helper owns the duplicated setup + invocation.
  async function runDelayedStartTerminalCleanup(options: {
    workflowId: string;
    writeDurableMarker: boolean;
  }): Promise<{
    workflowsNeedingTerminalCleanup: Set<string>;
    beginWorkflowExecution: ReturnType<typeof mock>;
  }> {
    const storage = new MemoryStorage();
    const state = createWorkflowState(options.workflowId, {
      executionStateOwnerId: options.workflowId,
    });
    const checkpoint = createCheckpoint(options.workflowId);
    const registration = { handler: async function* () {}, version: '1' };
    const beginWorkflowExecution = mock(() => {});
    const workflowsNeedingTerminalCleanup = new Set<string>();

    await storage.put(KEYS.workflow(options.workflowId), encode(state));
    await storage.put(KEYS.checkpoint(options.workflowId), serializeCheckpoint(checkpoint));
    if (options.writeDurableMarker) {
      await storage.put(KEYS.terminalCleanupNeeded(options.workflowId), new Uint8Array(0));
    }

    await startDelayedWorkflow(
      {
        checkpoints: new Map<string, Checkpoint>(),
        inlineStrategy: {},
        workflowServices: new Map<string, unknown>(),
        workflowsNeedingTerminalCleanup,
        options: { getNow: () => 2_000 },
        registrations: new Map([[state.type, registration]]),
        storage,
        workflowVersionTuples: new Map(),
      } as never,
      createDelayedStartEntry(options.workflowId, { executionTimeoutMs: 500 }),
      createCallbacks({
        beginWorkflowExecution,
        loadWorkflowState: async () => state,
        runSerializedWorkflowStateWrite: async (_workflowId, writeOperation) => writeOperation(),
      }),
    );

    return { workflowsNeedingTerminalCleanup, beginWorkflowExecution };
  }

  it('re-derives terminal-cleanup tracking from the durable marker on fresh-process recovery', async () => {
    // Regression: on a fresh process the in-memory workflowsNeedingTerminalCleanup
    // set is empty. A recovered delayed-start run whose durable terminalCleanupNeeded
    // key is present (e.g. a services-only run, which has no headers to re-add it)
    // must re-join the set, or completeWorkflow skips the deferred durable sweep and
    // leaks the run's per-run scratch (the wf-has-services marker). Mirrors the
    // running-workflow resume path's loadTerminalCleanupTrackedState.
    const { workflowsNeedingTerminalCleanup, beginWorkflowExecution } =
      await runDelayedStartTerminalCleanup({
        workflowId: 'workflow-delayed-rederive',
        writeDurableMarker: true,
      });

    // The run rejoined the cleanup set, so its later completion will schedule the
    // deferred durable sweep. Without the fix the set stays empty.
    expect(workflowsNeedingTerminalCleanup.has('workflow-delayed-rederive')).toBe(true);
    expect(beginWorkflowExecution).toHaveBeenCalledTimes(1);
  });

  it('leaves terminal-cleanup tracking empty when no durable marker exists', async () => {
    // The complement: a delayed-start run with no durable terminalCleanupNeeded key
    // (no headers, no services) must NOT join the cleanup set — scheduling a sweep
    // for a run with nothing to sweep would be wasted work.
    const { workflowsNeedingTerminalCleanup, beginWorkflowExecution } =
      await runDelayedStartTerminalCleanup({
        workflowId: 'workflow-delayed-no-marker',
        writeDurableMarker: false,
      });

    expect(workflowsNeedingTerminalCleanup.has('workflow-delayed-no-marker')).toBe(false);
    expect(beginWorkflowExecution).toHaveBeenCalledTimes(1);
  });
});
