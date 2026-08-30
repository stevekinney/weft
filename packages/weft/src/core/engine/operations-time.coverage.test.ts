import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { serializeCheckpoint } from '../checkpoint/serialization.ts';
import { encode } from '../codec.ts';
import type { Checkpoint, WorkflowState } from '../types.ts';
import { startDelayedWorkflow } from './operations-time.ts';

function createWorkflowState(workflowId: string): WorkflowState {
  return {
    createdAt: 1_000,
    id: workflowId,
    input: null,
    status: 'pending',
    type: 'delayed-workflow',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
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

describe('delayed-start coverage regression', () => {
  it('surfaces the fenced lost-race error when the delayed-start transition CAS fails', async () => {
    const workflowId = 'delayed-start-race';
    const storage = new MemoryStorage();
    const epochBytes = new Uint8Array(8);
    new DataView(epochBytes.buffer).setBigUint64(0, 1n, false);

    await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));
    await storage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );
    await storage.put(KEYS.leaseEpoch(), epochBytes);
    storage.conditionalBatch = async () => false;

    const loadWorkflowState = async () => createWorkflowState(workflowId);

    await expect(
      startDelayedWorkflow(
        {
          deposed: false,
          leaseManager: {
            currentEpochBytes: () => epochBytes,
          },
          options: { getNow: () => 2_000, ownershipMode: 'lease' },
          registrations: new Map([
            [
              'delayed-workflow',
              {
                handler: async function* () {},
                version: '1',
              },
            ],
          ]),
          storage,
        } as never,
        {
          fireAt: 2_000,
          id: `delayed-start:${workflowId}`,
          kind: 'delayed-start',
          workflowId,
        },
        {
          beginWorkflowExecution: () => {},
          dispatchEvent: () => true,
          failWorkflow: async () => {},
          handleCleanupError: () => {},
          loadWorkflowStartHeaders: async () => undefined,
          loadWorkflowState,
          runSerializedWorkflowStateWrite: async (_workflowId, writeOperation) => writeOperation(),
          setWorkflowStartHeaders: () => {},
          workflowVersionTupleFromState: () => ({ workflowVersion: '1' }),
        },
      ),
    ).rejects.toThrow(
      'Delayed-start transition for workflow "delayed-start-race" lost its CAS race.',
    );
  });
});
