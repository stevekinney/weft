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

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { WorkflowState } from '../types.ts';
import { bufferSignalPayloads, type SignalCallbacks } from './signals.ts';
import { encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

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

describe('signal delivery invokes only the waiter it actually removed', () => {
  it('does not invoke a waiter that was replaced while the ownership read was pending', async () => {
    // The ownership check is an await. Replay or a fresh park can install a
    // replacement waiter during it. `releaseSignalWaiter` correctly leaves the
    // replacement alone, but invoking the captured resolver anyway would
    // advance the superseded generator — so delivery must gate on whether the
    // release actually removed the waiter it validated.
    const base = new MemoryStorage();
    const holderKey = KEYS.workflowOwnerHolder(WORKFLOW_ID);
    await base.put(
      holderKey,
      encodeWorkflowClaimHolder({
        engineId: 'owner-engine',
        epoch: 7,
        expiresAt: Date.now() + 60_000,
        claimedAt: Date.now(),
      }),
    );

    const supersededWaiter = mock(() => {});
    const replacementWaiter = mock(() => {});
    const waiters = new Map<string, () => void>([[WAITER_KEY, supersededWaiter]]);

    // Swap the waiter exactly while the durable holder read is in flight.
    const storage = {
      capabilities: () => base.capabilities(),
      get: async (key: string) => {
        const value = await base.get(key);
        if (key === holderKey) waiters.set(WAITER_KEY, replacementWaiter);
        return value;
      },
      put: (key: string, value: Uint8Array) => base.put(key, value),
      delete: (key: string) => base.delete(key),
      scan: (prefix: string, options?: unknown) => base.scan(prefix, options as never),
      batch: (operations: unknown) => base.batch(operations as never),
      conditionalBatch: (conditions: unknown, operations: unknown) =>
        base.conditionalBatch(conditions as never, operations as never),
      [Symbol.dispose]: () => {},
    } as any;

    const internals = {
      storage,
      // A tracked epoch matching the durable holder makes the check proceed,
      // so the only thing that can stop the wake is the release gate.
      workflowClaimRegistry: { engineId: 'owner-engine', currentEpoch: () => 7 },
      signalWaiters: waiters,
      signalWaitersByWorkflow: new Map<string, Set<string>>([[WORKFLOW_ID, new Set([WAITER_KEY])]]),
      parkedInlineWorkflows: new Set<string>(),
      workflowsNeedingTerminalCleanup: new Set<string>(),
      options: { payloadSizePolicy: { maxBytes: null }, getNow: () => 1 },
    } as any;

    const callbacks: SignalCallbacks = {
      loadWorkflowState: async () => createRunningState(),
      dispatchEvent: mock(() => true),
      broadcast: mock(() => {}),
      getComposedInterceptor: () => null,
      resumeParkedInlineWorkflow: mock(async () => {}),
    };

    await bufferSignalPayloads(
      internals,
      WORKFLOW_ID,
      [{ signalName: SIGNAL_NAME, payload: { ok: true } }],
      callbacks,
    );

    // The superseded resolver must never run.
    expect(supersededWaiter).not.toHaveBeenCalled();
    // And the replacement must survive for its own delivery.
    expect(internals.signalWaiters.get(WAITER_KEY)).toBe(replacementWaiter);
    expect(replacementWaiter).not.toHaveBeenCalled();
  });
});
