import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { countNonTerminalRunsForRevision } from './nonterminal-revision-count.ts';

function makeWorkflowState(overrides: Partial<WorkflowState> & { id: string }): WorkflowState {
  return {
    type: 'checkout',
    status: 'running',
    input: {},
    createdAt: 1,
    updatedAt: 1,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

async function seedWorkflow(storage: MemoryStorage, state: WorkflowState): Promise<void> {
  await storage.put(KEYS.workflow(state.id), encode(state));
}

describe('countNonTerminalRunsForRevision', () => {
  it('counts only non-terminal runs matching both type and revision exactly', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', revision: 'rev-a', status: 'running' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-2', revision: 'rev-a', status: 'pending' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-3', revision: 'rev-a', status: 'suspended' }),
    );
    // Different revision of the same type — must not count.
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-4', revision: 'rev-b', status: 'running' }),
    );
    // Terminal status on the target revision — must not count.
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-5', revision: 'rev-a', status: 'completed' }),
    );
    // Different type, same revision string — must not count.
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-6', type: 'other', revision: 'rev-a', status: 'running' }),
    );
    // Legacy record with no persisted revision — must never match a defined revision.
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-7', status: 'running' }));

    const count = await countNonTerminalRunsForRevision(storage, 'checkout', 'rev-a');
    expect(count).toBe(3);
  });

  it('excludes wf: side-records (checkpoint, offload, archive, timeline) from the scan', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', revision: 'rev-a', status: 'running' }),
    );
    // Side-records under the `wf:` prefix carrying a `status: 'running'` field
    // would, without the top-level-key filter, decode as a spurious match.
    await storage.put(
      KEYS.timeline('wf-1', 1),
      encode({
        step: 1,
        operationType: 'activity',
        operationLabel: 'charge',
        inputSummary: '{}',
        timestamp: 1,
        status: 'running',
        type: 'checkout',
        revision: 'rev-a',
      }),
    );
    await storage.put(
      KEYS.checkpoint('wf-1'),
      encode({
        workflowId: 'wf-1',
        step: 0,
        status: 'running',
        type: 'checkout',
        revision: 'rev-a',
      }),
    );

    const count = await countNonTerminalRunsForRevision(storage, 'checkout', 'rev-a');
    expect(count).toBe(1);
  });

  it('returns 0 for a revision no workflow references', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', revision: 'rev-a', status: 'running' }),
    );

    expect(await countNonTerminalRunsForRevision(storage, 'checkout', 'rev-nonexistent')).toBe(0);
  });
});
