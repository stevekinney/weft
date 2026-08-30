import { describe, expect, it } from 'bun:test';

import type { OwnerSideUpdatePollTarget } from './owner-side-update-poll.ts';
import { runOwnerSideUpdatePoll } from './owner-side-update-poll.ts';

/**
 * A minimal, deterministic double for {@link OwnerSideUpdatePollTarget}. Each
 * test wires exactly the held workflow ids, pending-update flags, and drain
 * behavior it needs — no shared mutable module state.
 */
function createTarget(options: {
  heldWorkflowIds: string[];
  pending?: Set<string>;
  drainImplementation?: (workflowId: string) => Promise<void>;
}): { target: OwnerSideUpdatePollTarget; drainedWorkflowIds: string[] } {
  const drainedWorkflowIds: string[] = [];
  const pending = options.pending ?? new Set<string>();

  const target: OwnerSideUpdatePollTarget = {
    listHeldWorkflowIds: () => options.heldWorkflowIds,
    hasPendingUpdates: async (workflowId) => pending.has(workflowId),
    drainPendingUpdates: async (workflowId) => {
      drainedWorkflowIds.push(workflowId);
      if (options.drainImplementation !== undefined) {
        await options.drainImplementation(workflowId);
      }
    },
  };

  return { target, drainedWorkflowIds };
}

describe('runOwnerSideUpdatePoll', () => {
  it('reports an empty pass when this engine holds no workflows', async () => {
    const { target } = createTarget({ heldWorkflowIds: [] });

    const result = await runOwnerSideUpdatePoll({ target, getNow: () => 1_000 });

    expect(result).toEqual({
      startedAt: 1_000,
      finishedAt: 1_000,
      outcomes: [],
      drainedCount: 0,
    });
  });

  it('leaves a held workflow alone when it has no pending coordinated updates', async () => {
    const { target, drainedWorkflowIds } = createTarget({
      heldWorkflowIds: ['wf-1'],
      pending: new Set(),
    });

    const result = await runOwnerSideUpdatePoll({ target, getNow: () => 2_000 });

    expect(result.outcomes).toEqual([{ workflowId: 'wf-1', status: 'no-pending-updates' }]);
    expect(result.drainedCount).toBe(0);
    expect(drainedWorkflowIds).toEqual([]);
  });

  it('drains a held workflow with at least one pending coordinated update', async () => {
    const { target, drainedWorkflowIds } = createTarget({
      heldWorkflowIds: ['wf-1'],
      pending: new Set(['wf-1']),
    });

    const result = await runOwnerSideUpdatePoll({ target, getNow: () => 3_000 });

    expect(result.outcomes).toEqual([{ workflowId: 'wf-1', status: 'drained' }]);
    expect(result.drainedCount).toBe(1);
    expect(drainedWorkflowIds).toEqual(['wf-1']);
  });

  it('continues draining the remaining held workflows when one drain throws', async () => {
    const drainError = new Error('drain failed for wf-1');
    const { target, drainedWorkflowIds } = createTarget({
      heldWorkflowIds: ['wf-1', 'wf-2'],
      pending: new Set(['wf-1', 'wf-2']),
      drainImplementation: async (workflowId) => {
        if (workflowId === 'wf-1') throw drainError;
      },
    });

    const result = await runOwnerSideUpdatePoll({ target, getNow: () => 4_000 });

    expect(result.outcomes).toEqual([
      { workflowId: 'wf-1', status: 'drain-failed', error: drainError },
      { workflowId: 'wf-2', status: 'drained' },
    ]);
    expect(result.drainedCount).toBe(1);
    expect(drainedWorkflowIds).toEqual(['wf-1', 'wf-2']);
  });

  it('probes and drains multiple held workflows independently', async () => {
    const { target, drainedWorkflowIds } = createTarget({
      heldWorkflowIds: ['wf-1', 'wf-2', 'wf-3'],
      pending: new Set(['wf-1', 'wf-3']),
    });

    const result = await runOwnerSideUpdatePoll({ target, getNow: () => 5_000 });

    expect(result.outcomes).toEqual([
      { workflowId: 'wf-1', status: 'drained' },
      { workflowId: 'wf-2', status: 'no-pending-updates' },
      { workflowId: 'wf-3', status: 'drained' },
    ]);
    expect(result.drainedCount).toBe(2);
    expect(drainedWorkflowIds).toEqual(['wf-1', 'wf-3']);
  });
});
