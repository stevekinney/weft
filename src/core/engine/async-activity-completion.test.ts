/**
 * Direct coverage of `wakeOwnershipCheck`'s wiring in
 * `deliverPendingAsyncActivityResolution` (ADR 0002's `async-activity` wake
 * kind). `async-activity-completion-recovery.test.ts` already exercises both
 * call sites end-to-end under `ownership: 'none'` (registry null, always
 * `'proceed'`); this file adds the `'workflow-lease'` match/discard branches
 * `confirmWakeOwnership` introduces, targeting `parkDeferredAsyncActivity`'s
 * buffered-resolution redelivery — the call site with no accompanying fresh
 * fenced write to fall back on (see that function's doc comment).
 */
import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { yieldToEventLoop } from '../../testing/fake-timers.test-support.ts';
import type { OperationOutcome } from '../types.ts';
import { AsyncActivityDeferral, parkDeferredAsyncActivity } from './async-activity-completion.ts';
import {
  queuePendingAsyncActivityResolution,
  type PendingAsyncActivityResolution,
} from './async-activity-records.ts';
import { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import {
  DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS,
  DEFAULT_WORKFLOW_CLAIM_TTL_MS,
} from './ownership-options.ts';
import { encodeEpoch, encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

async function createWorkflowLeaseEngine(): Promise<{ internals: EngineInternals }> {
  await using engine = await Engine.create({
    storage: new MemoryStorage(),
    ownership: 'workflow-lease',
    workflows: {},
  });
  return { internals: getInternals(engine) };
}

async function installAndAcquireClaim(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  const registry = new WorkflowClaimRegistry({
    storage: internals.storage,
    engineId: 'engine-under-test',
    getNow: () => internals.options.getNow(),
    claimTtlMs: DEFAULT_WORKFLOW_CLAIM_TTL_MS,
    claimRenewIntervalMs: DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS,
  });
  internals.workflowClaimRegistry = registry;
  const result = await registry.acquire(workflowId);
  expect(result.status).toBe('acquired');
}

async function stealWorkflowClaim(internals: EngineInternals, workflowId: string): Promise<void> {
  await internals.storage.batch([
    { type: 'put', key: KEYS.workflowOwnerEpoch(workflowId), value: encodeEpoch(2) },
    {
      type: 'put',
      key: KEYS.workflowOwnerHolder(workflowId),
      value: encodeWorkflowClaimHolder({
        engineId: 'successor-engine',
        epoch: 2,
        expiresAt: internals.options.getNow() + 60_000,
        claimedAt: internals.options.getNow(),
      }),
    },
  ]);
}

function makeCallbacks() {
  return {
    feedOperationResult: mock(() => {}),
    finalizeTimeline: mock(() => {}),
  };
}

const OUTCOME: OperationOutcome = { status: 'completed', value: 'delivered' };

function queueResolution(internals: EngineInternals, workflowId: string, token: string): void {
  const resolution: PendingAsyncActivityResolution = {
    token,
    outcome: OUTCOME,
    timelineStatus: 'completed',
    timelineOutput: 'delivered',
  };
  queuePendingAsyncActivityResolution(internals, workflowId, resolution);
}

describe('parkDeferredAsyncActivity: buffered-resolution redelivery ownership check', () => {
  it('delivers the queued resolution when this engine still holds the parked generation', async () => {
    const { internals } = await createWorkflowLeaseEngine();
    await installAndAcquireClaim(internals, 'wf-deliver');
    queueResolution(internals, 'wf-deliver', 'tok-deliver');

    const callbacks = makeCallbacks();
    // parkDeferredAsyncActivity's queued-resolution branch awaits delivery
    // before returning a never-settling promise, so the returned promise
    // itself never resolves — never await it directly. Fire it and drain the
    // event loop until the in-flight ownership check settles instead.
    void parkDeferredAsyncActivity(
      internals,
      new AsyncActivityDeferral('tok-deliver'),
      {
        workflowId: 'wf-deliver',
        activityName: 'test-activity',
        operationId: 'op-1',
        step: 0,
        attempt: 1,
      },
      callbacks,
    );
    await yieldToEventLoop();
    await yieldToEventLoop();
    await yieldToEventLoop();

    expect(callbacks.finalizeTimeline).toHaveBeenCalledTimes(1);
    expect(callbacks.finalizeTimeline).toHaveBeenCalledWith('wf-deliver', 'completed', 'delivered');
    expect(callbacks.feedOperationResult).toHaveBeenCalledTimes(1);
    expect(callbacks.feedOperationResult).toHaveBeenCalledWith('wf-deliver', OUTCOME, undefined);
    // Staged for the checkpoint commit that never comes in this unit test —
    // proves the delete was staged (delivery ran), not that it was committed.
    expect(internals.pendingAtomicWorkflowCommitSideEffects.has('wf-deliver')).toBe(true);
  });

  it('discards the queued resolution without staging or feeding when a successor now owns the workflow', async () => {
    const { internals } = await createWorkflowLeaseEngine();
    await installAndAcquireClaim(internals, 'wf-discard');
    queueResolution(internals, 'wf-discard', 'tok-discard');
    // No fresh fenced write happens on this delivery path, so simulate the
    // takeover directly against durable storage — this engine's registry
    // still caches the OLD epoch, which is exactly the stale-generation case
    // wakeOwnershipCheck exists to catch.
    await stealWorkflowClaim(internals, 'wf-discard');

    // Also put a durable resolution record so we can assert it survives
    // (the true owner redelivers it — this discard must not delete it).
    await internals.storage.put(
      KEYS.asyncActivityResolution('wf-discard', 'tok-discard'),
      new Uint8Array([1]),
    );

    const callbacks = makeCallbacks();
    void parkDeferredAsyncActivity(
      internals,
      new AsyncActivityDeferral('tok-discard'),
      {
        workflowId: 'wf-discard',
        activityName: 'test-activity',
        operationId: 'op-2',
        step: 0,
        attempt: 1,
      },
      callbacks,
    );
    await yieldToEventLoop();
    await yieldToEventLoop();
    await yieldToEventLoop();

    expect(callbacks.finalizeTimeline).not.toHaveBeenCalled();
    expect(callbacks.feedOperationResult).not.toHaveBeenCalled();
    expect(internals.pendingAtomicWorkflowCommitSideEffects.has('wf-discard')).toBe(false);
    // The durable resolution record survives untouched for the true owner.
    expect(
      await internals.storage.get(KEYS.asyncActivityResolution('wf-discard', 'tok-discard')),
    ).not.toBeNull();
  });
});
