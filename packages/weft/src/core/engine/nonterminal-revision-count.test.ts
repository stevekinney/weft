import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import {
  countNonTerminalRunsForRevision,
  countWorkflowStateRevisionsByStatus,
} from './nonterminal-revision-count.ts';

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

describe('countWorkflowStateRevisionsByStatus', () => {
  it('is the one wf: scan countNonTerminalRunsForRevision now delegates to — byte-identical nonTerminalRuns for every existing case', async () => {
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
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-4', revision: 'rev-b', status: 'running' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-5', revision: 'rev-a', status: 'completed' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-6', type: 'other', revision: 'rev-a', status: 'running' }),
    );
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-7', status: 'running' }));

    const combined = await countWorkflowStateRevisionsByStatus(storage, 'checkout', 'rev-a');
    const wrapped = await countNonTerminalRunsForRevision(storage, 'checkout', 'rev-a');
    expect(combined.nonTerminalRuns).toBe(3);
    expect(wrapped).toBe(combined.nonTerminalRuns);
  });

  it('counts completed/failed/cancelled/timed-out states pinned to the exact (type, revision) as terminalRuns, excluding non-terminal and mismatched (type, revision)', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-completed', revision: 'rev-a', status: 'completed' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-failed', revision: 'rev-a', status: 'failed' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-cancelled', revision: 'rev-a', status: 'cancelled' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-timed-out', revision: 'rev-a', status: 'timed-out' }),
    );
    // Non-terminal on the exact revision — must not count as terminal.
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-running', revision: 'rev-a', status: 'running' }),
    );
    // Terminal, but a different revision — must not count.
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-other-rev', revision: 'rev-b', status: 'completed' }),
    );
    // Terminal, but a different type — must not count.
    await seedWorkflow(
      storage,
      makeWorkflowState({
        id: 'wf-other-type',
        type: 'other',
        revision: 'rev-a',
        status: 'completed',
      }),
    );
    // Legacy record with no persisted revision — must never match a defined revision.
    await seedWorkflow(storage, makeWorkflowState({ id: 'wf-legacy', status: 'completed' }));

    const counts = await countWorkflowStateRevisionsByStatus(storage, 'checkout', 'rev-a');
    expect(counts.terminalRuns).toBe(4);
    expect(counts.nonTerminalRuns).toBe(1);
  });

  it('returns zeros for a revision no workflow references', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', revision: 'rev-a', status: 'completed' }),
    );

    const counts = await countWorkflowStateRevisionsByStatus(
      storage,
      'checkout',
      'rev-nonexistent',
    );
    expect(counts).toEqual({ nonTerminalRuns: 0, terminalRuns: 0 });
  });
});
