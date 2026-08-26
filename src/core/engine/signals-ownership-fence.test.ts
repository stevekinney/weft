/**
 * ADR 0002 fencing for direct signal delivery.
 *
 * `bufferSignalPayloads()` durably buffers a signal — deliberately unfenced,
 * since any engine may signal any workflow — and then wakes this engine's
 * in-memory waiter. That second step advances the workflow's generator, so it
 * is a claim-requiring wake path. Deposition drops the registry's claim entry
 * while leaving `internals.signalWaiters` populated, so an unfenced delivery
 * would advance a deposed generator alongside the successor's replayed one.
 *
 * This path was not among the reported review findings; it was found by
 * enumerating every in-memory waiter-settle site rather than only the flagged
 * ones.
 */
import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import type { WorkflowState } from '../types.ts';
import { bufferSignalPayloads, type SignalCallbacks } from './signals.ts';

const WORKFLOW_ID = 'workflow-signal-fence';
const SIGNAL_NAME = 'approve';
const WAITER_KEY = `${WORKFLOW_ID}:${SIGNAL_NAME}`;

function createRunningState(): WorkflowState {
  return {
    id: WORKFLOW_ID,
    type: 'fence-workflow',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  } as WorkflowState;
}

function createHarness(registry: unknown) {
  const waiter = mock(() => {});
  const resumeParkedInlineWorkflow = mock(async () => {});
  const internals = {
    storage: new MemoryStorage(),
    workflowClaimRegistry: registry,
    signalWaiters: new Map<string, () => void>([[WAITER_KEY, waiter]]),
    signalWaitersByWorkflow: new Map<string, Set<string>>([[WORKFLOW_ID, new Set([WAITER_KEY])]]),
    parkedInlineWorkflows: new Set<string>(),
    workflowsNeedingTerminalCleanup: new Set<string>(),
    options: {
      payloadSizePolicy: { maxBytes: null },
      getNow: () => 1,
    },
  } as any;

  const callbacks: SignalCallbacks = {
    loadWorkflowState: async () => createRunningState(),
    dispatchEvent: mock(() => true),
    broadcast: mock(() => {}),
    getComposedInterceptor: () => null,
    resumeParkedInlineWorkflow,
  };

  return { internals, callbacks, waiter };
}

/**
 * Count durable signal-payload records for the workflow. There is no exported
 * per-workflow signal prefix helper, and the payload key embeds a sort class
 * and sequence, so this scans the `sig` namespace and matches on the encoded
 * workflow id rather than reconstructing the exact key.
 */
async function bufferedSignalKeyCount(internals: { storage: MemoryStorage }): Promise<number> {
  let count = 0;
  for await (const [key] of internals.storage.scan('sig')) {
    if (key.includes(WORKFLOW_ID)) count += 1;
  }
  return count;
}

describe('direct signal delivery is fenced on the claim generation', () => {
  it('does not wake a stale waiter on a deposed engine, but still buffers durably', async () => {
    // `currentEpoch` returning null is the post-deposition state: a lost renewal
    // dropped the claim entry while the in-memory waiter survived.
    const { internals, callbacks, waiter } = createHarness({
      engineId: 'deposed-engine',
      currentEpoch: () => null,
    });

    await bufferSignalPayloads(
      internals,
      WORKFLOW_ID,
      [{ signalName: SIGNAL_NAME, payload: { ok: true } }],
      callbacks,
    );

    // Waking this waiter is what advances the deposed generator.
    expect(waiter).not.toHaveBeenCalled();
    expect(internals.signalWaiters.get(WAITER_KEY)).toBe(waiter);
    // The signal must still be durable so the true owner's poll delivers it.
    expect(await bufferedSignalKeyCount(internals)).toBeGreaterThan(0);
  });

  it('wakes the waiter normally when no claim registry is installed', async () => {
    // `ownership: 'none'`/`'lease'` must stay byte-identical to pre-ADR-0002.
    const { internals, callbacks, waiter } = createHarness(null);

    await bufferSignalPayloads(
      internals,
      WORKFLOW_ID,
      [{ signalName: SIGNAL_NAME, payload: { ok: true } }],
      callbacks,
    );

    expect(waiter).toHaveBeenCalled();
    expect(internals.signalWaiters.has(WAITER_KEY)).toBe(false);
  });
});
