import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { loadWorkflowResult } from './storage-io.ts';

function createWorkflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    createdAt: 1_000,
    id: 'workflow-storage-io',
    input: null,
    startedAt: 1_000,
    status: 'running',
    type: 'workflow',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

describe('storage I/O helpers', () => {
  it('rejects loadWorkflowResult for non-terminal workflows', async () => {
    const storage = new MemoryStorage();
    const state = createWorkflowState({ id: 'workflow-still-running' });
    await storage.put(KEYS.workflow(state.id), encode(state));

    await expect(
      loadWorkflowResult({ storage } as never, 'workflow-still-running'),
    ).rejects.toThrow('Workflow "workflow-still-running" is still running');
  });
});
