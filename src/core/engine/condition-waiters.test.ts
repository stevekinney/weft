import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { yieldToEventLoop } from '../../testing/fake-timers.test-support.ts';
import { notifyConditionWaiters, notifyConditionWaitersForTimerFire } from './condition-waiters.ts';
import { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import {
  DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS,
  DEFAULT_WORKFLOW_CLAIM_TTL_MS,
} from './ownership-options.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

async function createBareEngine(): Promise<{ internals: EngineInternals }> {
  await using engine = await Engine.create({ storage: new MemoryStorage(), workflows: {} });
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

describe('notifyConditionWaiters', () => {
  it('is a harmless no-op when no waiter is registered for the workflow', async () => {
    const { internals } = await createBareEngine();
    expect(() => notifyConditionWaiters(internals, 'wf-no-waiter')).not.toThrow();
  });

  it("resolves the waiter SYNCHRONOUSLY when workflowClaimRegistry is null ('none'/'lease')", async () => {
    const { internals } = await createBareEngine();
    expect(internals.workflowClaimRegistry).toBeNull();

    let resolvedSynchronously = false;
    internals.conditionWaiters.set('wf-sync', () => {
      resolvedSynchronously = true;
    });

    notifyConditionWaiters(internals, 'wf-sync');

    // No await between the call and this assertion: byte-identical to the
    // pre-ADR-0002 behavior this preserves.
    expect(resolvedSynchronously).toBe(true);
  });

  it('resolves the waiter asynchronously once the ownership check confirms a match', async () => {
    const { internals } = await createBareEngine();
    await installAndAcquireClaim(internals, 'wf-match');

    let resolved = false;
    internals.conditionWaiters.set('wf-match', () => {
      resolved = true;
    });

    notifyConditionWaiters(internals, 'wf-match');
    expect(resolved).toBe(false); // not yet — the check is still in flight

    await yieldToEventLoop();
    await yieldToEventLoop();
    expect(resolved).toBe(true);
  });

  it('never resolves the waiter when the ownership check discards a stale generation', async () => {
    const { internals } = await createBareEngine();
    await installAndAcquireClaim(internals, 'wf-stale');
    // Externally released: the durable holder is gone, so the re-read finds
    // no matching generation for this engine.
    await internals.storage.delete(KEYS.workflowOwnerHolder('wf-stale'));

    let resolved = false;
    internals.conditionWaiters.set('wf-stale', () => {
      resolved = true;
    });

    notifyConditionWaiters(internals, 'wf-stale');
    await yieldToEventLoop();
    await yieldToEventLoop();
    expect(resolved).toBe(false);
  });

  it('looks up the resolver fresh after the async check, never a stale captured reference', async () => {
    const { internals } = await createBareEngine();
    await installAndAcquireClaim(internals, 'wf-fresh-lookup');

    let staleCalled = false;
    let freshCalled = false;
    internals.conditionWaiters.set('wf-fresh-lookup', () => {
      staleCalled = true;
    });

    notifyConditionWaiters(internals, 'wf-fresh-lookup');

    // Replace the resolver before the in-flight async check settles — the
    // newer registration must be the one invoked.
    internals.conditionWaiters.set('wf-fresh-lookup', () => {
      freshCalled = true;
    });

    await yieldToEventLoop();
    await yieldToEventLoop();

    expect(staleCalled).toBe(false);
    expect(freshCalled).toBe(true);
  });
});

describe('notifyConditionWaitersForTimerFire', () => {
  it("resolves the waiter and returns 'proceed' when workflowClaimRegistry is null ('none'/'lease')", async () => {
    const { internals } = await createBareEngine();
    expect(internals.workflowClaimRegistry).toBeNull();

    let resolved = false;
    internals.conditionWaiters.set('wf-sync', () => {
      resolved = true;
    });

    const decision = await notifyConditionWaitersForTimerFire(internals, 'wf-sync');

    expect(decision).toBe('proceed');
    expect(resolved).toBe(true);
  });

  it("resolves the waiter and returns 'proceed' once the ownership check confirms a match, ONLY after being awaited", async () => {
    const { internals } = await createBareEngine();
    await installAndAcquireClaim(internals, 'wf-match');

    let resolved = false;
    internals.conditionWaiters.set('wf-match', () => {
      resolved = true;
    });

    const decisionPromise = notifyConditionWaitersForTimerFire(internals, 'wf-match');
    // Not yet — unlike notifyConditionWaiters's fire-and-forget branch, the
    // caller (operations-time.ts) is expected to await this promise before
    // treating the fire as settled, which is exactly what this proves.
    expect(resolved).toBe(false);

    expect(await decisionPromise).toBe('proceed');
    expect(resolved).toBe(true);
  });

  it("never resolves the waiter and returns 'discard' when the ownership check discards a stale generation", async () => {
    const { internals } = await createBareEngine();
    await installAndAcquireClaim(internals, 'wf-stale');
    await internals.storage.delete(KEYS.workflowOwnerHolder('wf-stale'));

    let resolved = false;
    internals.conditionWaiters.set('wf-stale', () => {
      resolved = true;
    });

    const decision = await notifyConditionWaitersForTimerFire(internals, 'wf-stale');

    expect(decision).toBe('discard');
    expect(resolved).toBe(false);
  });
});
