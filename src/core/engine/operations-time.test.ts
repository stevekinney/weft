import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { serializeCheckpoint } from '../checkpoint/serialization.ts';
import { encode } from '../codec.ts';
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
    version: '1',
    ...overrides,
  };
}

function createCheckpoint(workflowId: string): Checkpoint {
  return {
    accumulatedResults: [],
    createdAt: 1_000,
    locals: {},
    pendingSignals: [],
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
});
