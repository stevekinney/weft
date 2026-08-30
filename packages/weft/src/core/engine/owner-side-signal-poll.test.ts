import { describe, expect, it } from 'bun:test';

import type { OwnerSideSignalPollTarget, ParkedSignalWait } from './owner-side-signal-poll.ts';
import { runOwnerSideSignalPoll } from './owner-side-signal-poll.ts';

/**
 * A minimal, deterministic double for {@link OwnerSideSignalPollTarget}. Each
 * test wires exactly the parked waits, buffered signals, and wake behavior it
 * needs — no shared mutable module state.
 */
function createTarget(options: {
  parkedWaits: ParkedSignalWait[];
  buffered?: Set<string>; // `${workflowId}:${signalName}`
  wakeImplementation?: (workflowId: string) => Promise<void>;
}): { target: OwnerSideSignalPollTarget; wokenWorkflowIds: string[] } {
  const wokenWorkflowIds: string[] = [];
  const buffered = options.buffered ?? new Set<string>();

  const target: OwnerSideSignalPollTarget = {
    listParkedSignalWaits: () => options.parkedWaits,
    hasBufferedSignal: async (workflowId, signalName) =>
      buffered.has(`${workflowId}:${signalName}`),
    wakeWorkflow: async (workflowId) => {
      wokenWorkflowIds.push(workflowId);
      if (options.wakeImplementation !== undefined) {
        await options.wakeImplementation(workflowId);
      }
    },
  };

  return { target, wokenWorkflowIds };
}

describe('runOwnerSideSignalPoll', () => {
  it('reports an empty pass when this engine has no parked workflows', async () => {
    const { target } = createTarget({ parkedWaits: [] });

    const result = await runOwnerSideSignalPoll({ target, getNow: () => 1_000 });

    expect(result).toEqual({
      startedAt: 1_000,
      finishedAt: 1_000,
      outcomes: [],
      wokenCount: 0,
    });
  });

  it('leaves a parked workflow alone when its awaited signal has not been buffered', async () => {
    const { target, wokenWorkflowIds } = createTarget({
      parkedWaits: [{ workflowId: 'wf-1', signalName: 'approve' }],
      buffered: new Set(),
    });

    const result = await runOwnerSideSignalPoll({ target, getNow: () => 2_000 });

    expect(result.outcomes).toEqual([
      { workflowId: 'wf-1', signalName: 'approve', status: 'not-buffered' },
    ]);
    expect(result.wokenCount).toBe(0);
    expect(wokenWorkflowIds).toEqual([]);
  });

  it('wakes a parked workflow whose awaited signal has been buffered', async () => {
    const { target, wokenWorkflowIds } = createTarget({
      parkedWaits: [{ workflowId: 'wf-1', signalName: 'approve' }],
      buffered: new Set(['wf-1:approve']),
    });

    const result = await runOwnerSideSignalPoll({ target, getNow: () => 3_000 });

    expect(result.outcomes).toEqual([
      { workflowId: 'wf-1', signalName: 'approve', status: 'woken' },
    ]);
    expect(result.wokenCount).toBe(1);
    expect(wokenWorkflowIds).toEqual(['wf-1']);
  });

  it('continues waking the remaining parked workflows when one wake delivery throws', async () => {
    const wakeError = new Error('delivery failed for wf-1');
    const { target, wokenWorkflowIds } = createTarget({
      parkedWaits: [
        { workflowId: 'wf-1', signalName: 'approve' },
        { workflowId: 'wf-2', signalName: 'approve' },
        { workflowId: 'wf-3', signalName: 'approve' },
      ],
      buffered: new Set(['wf-1:approve', 'wf-2:approve', 'wf-3:approve']),
      wakeImplementation: async (workflowId) => {
        if (workflowId === 'wf-1') throw wakeError;
      },
    });

    const result = await runOwnerSideSignalPoll({ target, getNow: () => 4_000 });

    expect(result.outcomes).toEqual([
      { workflowId: 'wf-1', signalName: 'approve', status: 'wake-failed', error: wakeError },
      { workflowId: 'wf-2', signalName: 'approve', status: 'woken' },
      { workflowId: 'wf-3', signalName: 'approve', status: 'woken' },
    ]);
    // wf-1's wake was attempted (and threw) — it must not have prevented wf-2/wf-3.
    expect(wokenWorkflowIds).toEqual(['wf-1', 'wf-2', 'wf-3']);
    expect(result.wokenCount).toBe(2);
  });

  it('probes and wakes multiple distinct signal waits for the same workflow independently', async () => {
    const { target, wokenWorkflowIds } = createTarget({
      parkedWaits: [
        { workflowId: 'wf-1', signalName: 'approve' },
        { workflowId: 'wf-1', signalName: 'reject' },
      ],
      buffered: new Set(['wf-1:approve']),
    });

    const result = await runOwnerSideSignalPoll({ target, getNow: () => 5_000 });

    expect(result.outcomes).toEqual([
      { workflowId: 'wf-1', signalName: 'approve', status: 'woken' },
      { workflowId: 'wf-1', signalName: 'reject', status: 'not-buffered' },
    ]);
    expect(wokenWorkflowIds).toEqual(['wf-1']);
    expect(result.wokenCount).toBe(1);
  });

  it('records startedAt/finishedAt from the injected clock, read before and after the pass', async () => {
    const timestamps = [10, 20];
    const { target } = createTarget({ parkedWaits: [] });

    const result = await runOwnerSideSignalPoll({
      target,
      getNow: () => timestamps.shift() ?? -1,
    });

    expect(result.startedAt).toBe(10);
    expect(result.finishedAt).toBe(20);
  });
});
