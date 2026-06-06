import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import type { WorkflowState } from '../types.ts';
import {
  getParkedWorkflowResumeDisposition,
  resumeParkedInlineWorkflow,
  type InlineParkingCallbacks,
  type ParkedWorkflowResumeDisposition,
} from './inline-parking.ts';

function createWorkflowState(
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: 1,
    id: workflowId,
    input: null,
    startedAt: 1,
    status: 'running',
    type: 'workflow',
    updatedAt: 1,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

function createCallbacks(overrides: Partial<InlineParkingCallbacks> = {}): InlineParkingCallbacks {
  return {
    createLifecycleCallbacks: () => ({}) as never,
    createTerminationCallbacks: () => ({}) as never,
    evaluateConstraints: mock(async () => true),
    getParkedWorkflowResumeDisposition: mock(
      async (): Promise<ParkedWorkflowResumeDisposition> => 'terminal-or-missing',
    ),
    hasBufferedSignal: mock(async () => false),
    loadWorkflowState: mock(async () => null),
    parkInlineWorkflowAfterCheckpoint: mock(async () => false),
    persistCheckpoint: mock(async () => {}),
    processOperation: mock(async () => {}),
    readCheckpointBytes: mock(async () => null),
    resumeParkedInlineWorkflow: mock(async () => {}),
    runSerializedWorkflowStateWrite: async (_workflowId, writeOperation) => writeOperation(),
    translateOperationRequest: mock(() => ({}) as never),
    validateDevelopmentCheckpoint: mock(() => {}),
    ...overrides,
  };
}

describe('engine inline parking helpers', () => {
  it('does not resume workflows that are not marked parked', async () => {
    const parkedInlineWorkflows = new Set<string>();
    const resolveResumeDisposition = mock(async () => 'resumable' as const);

    await resumeParkedInlineWorkflow(
      { parkedInlineWorkflows, storage: new MemoryStorage() } as never,
      'workflow-not-parked',
      createCallbacks({ getParkedWorkflowResumeDisposition: resolveResumeDisposition }),
    );

    expect(resolveResumeDisposition).not.toHaveBeenCalled();
  });

  it('restores resumable parked markers when resume fails', async () => {
    const workflowId = 'workflow-parked-resumable';
    const parkedInlineWorkflows = new Set([workflowId]);

    await expect(
      resumeParkedInlineWorkflow(
        { parkedInlineWorkflows, storage: new MemoryStorage() } as never,
        workflowId,
        createCallbacks({
          getParkedWorkflowResumeDisposition: async () => 'resumable',
        }),
      ),
    ).rejects.toThrow(`Workflow "${workflowId}" not found in storage`);

    expect(parkedInlineWorkflows.has(workflowId)).toBe(true);
  });

  it('does not restore corrupt parked markers when resume fails', async () => {
    const workflowId = 'workflow-parked-corrupt';
    const parkedInlineWorkflows = new Set([workflowId]);

    await expect(
      resumeParkedInlineWorkflow(
        { parkedInlineWorkflows, storage: new MemoryStorage() } as never,
        workflowId,
        createCallbacks({
          getParkedWorkflowResumeDisposition: async () => 'corrupt',
        }),
      ),
    ).rejects.toThrow(`Workflow "${workflowId}" not found in storage`);

    expect(parkedInlineWorkflows.has(workflowId)).toBe(false);
  });

  it('classifies parked workflow resume disposition from state and checkpoint data', async () => {
    const workflowId = 'workflow-disposition';
    const terminalizingWorkflows = new Set<string>();

    await expect(
      getParkedWorkflowResumeDisposition(
        { terminalizingWorkflows } as never,
        workflowId,
        createCallbacks(),
      ),
    ).resolves.toBe('terminal-or-missing');

    await expect(
      getParkedWorkflowResumeDisposition(
        { terminalizingWorkflows } as never,
        workflowId,
        createCallbacks({
          loadWorkflowState: async () => createWorkflowState(workflowId, { status: 'completed' }),
        }),
      ),
    ).resolves.toBe('terminal-or-missing');

    await expect(
      getParkedWorkflowResumeDisposition(
        { terminalizingWorkflows } as never,
        workflowId,
        createCallbacks({
          loadWorkflowState: async () => createWorkflowState(workflowId),
          readCheckpointBytes: async () => null,
        }),
      ),
    ).resolves.toBe('corrupt');

    await expect(
      getParkedWorkflowResumeDisposition(
        { terminalizingWorkflows } as never,
        workflowId,
        createCallbacks({
          loadWorkflowState: async () => createWorkflowState(workflowId),
          readCheckpointBytes: async () => new Uint8Array([1]),
        }),
      ),
    ).resolves.toBe('resumable');
  });
});
