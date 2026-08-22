/**
 * ADR 0002 row `startDelayedWorkflow` (delayed-start timer fire):
 * claim-acquiring — the FIRST point a delayed-start workflow gets an owner,
 * since its create batch is intentionally external (no claim fold there; see
 * `lifecycle/start-commit.ts`). Covers `operations-time.ts`'s fold branch in
 * `startDelayedWorkflow` end to end, including the background-scanner "skip,
 * never throw" contract on a lost race.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import type { TimerEntry, WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

const activityRunCounts = new Map<string, number>();

const delayedClaimWorkflow = workflow({ name: 'delayed-claim-fold' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.run(() => {
    activityRunCounts.set(ctx.workflowId, (activityRunCounts.get(ctx.workflowId) ?? 0) + 1);
    return 'ran';
  });
});

function installClaimRegistry(
  engine: { [Symbol.asyncDispose]: () => Promise<void> },
  engineId: string,
  storage: MemoryStorage,
): WorkflowClaimRegistry {
  const registry = new WorkflowClaimRegistry({
    storage,
    engineId,
    getNow: () => Date.now(),
    claimTtlMs: 60_000,
    claimRenewIntervalMs: 5_000,
  });
  getInternals(engine).workflowClaimRegistry = registry;
  return registry;
}

async function createClaimEngine(storage: MemoryStorage, engineId: string) {
  const engine = await Engine.create({
    storage,
    workflows: { 'delayed-claim-fold': delayedClaimWorkflow },
    ownership: 'workflow-lease',
    workflowClaimTtl: '1m',
    workflowClaimRenewInterval: '5s',
    recover: false,
  });
  installClaimRegistry(engine, engineId, storage);
  return engine;
}

/** Read back the durably persisted delayed-start `TimerEntry` for `workflowId`. */
async function loadDelayedStartTimerEntry(
  storage: MemoryStorage,
  workflowId: string,
): Promise<TimerEntry> {
  for await (const [, value] of storage.scan('wf-delayed:')) {
    const entry = decode(value) as TimerEntry;
    if (entry.workflowId === workflowId) return entry;
  }
  throw new Error(`no delayed-start timer entry found for "${workflowId}"`);
}

describe('operations-time.ts: delayed-start timer fire folds acquire() under workflow-lease', () => {
  it('acquires the claim at fire time, not at create time', async () => {
    const storage = new MemoryStorage();
    await using engine = await createClaimEngine(storage, 'engine-a');
    const workflowId = 'wf-delayed-fold-1';

    await engine.start('delayed-claim-fold', null, {
      id: workflowId,
      startAt: Date.now() + 60_000,
    });

    // The create batch is intentionally external — no claim yet.
    expect(getInternals(engine).workflowClaimRegistry?.currentEpoch(workflowId)).toBeNull();

    const entry = await loadDelayedStartTimerEntry(storage, workflowId);
    await engine.fireTimer(entry);

    await waitForCondition(
      async () => getInternals(engine).workflowClaimRegistry?.currentEpoch(workflowId) === 1,
      { label: 'claim acquired at delayed-start fire' },
    );
    const handle = engine.getHandle(workflowId);
    expect(await handle.result()).toBe('ran');
    expect(activityRunCounts.get(workflowId)).toBe(1);
  });

  it('two engines racing the same delayed-start fire: exactly one wins and the loser silently skips (never throws)', async () => {
    const storage = new MemoryStorage();
    await using engineA = await createClaimEngine(storage, 'engine-a');
    await using engineB = await createClaimEngine(storage, 'engine-b');
    const workflowId = 'wf-delayed-fold-race';

    await engineA.start('delayed-claim-fold', null, {
      id: workflowId,
      startAt: Date.now() + 60_000,
    });
    const entry = await loadDelayedStartTimerEntry(storage, workflowId);

    // Background-scanner semantics: fireTimer() must never throw, win or lose.
    const [outcomeA, outcomeB] = await Promise.allSettled([
      engineA.fireTimer(entry),
      engineB.fireTimer(entry),
    ]);
    expect(outcomeA.status).toBe('fulfilled');
    expect(outcomeB.status).toBe('fulfilled');

    const epochA = getInternals(engineA).workflowClaimRegistry?.currentEpoch(workflowId) ?? null;
    const epochB = getInternals(engineB).workflowClaimRegistry?.currentEpoch(workflowId) ?? null;
    // Exactly one engine actually won the claim CAS.
    expect([epochA, epochB].filter((epoch) => epoch !== null)).toHaveLength(1);

    const winner = epochA !== null ? engineA : engineB;
    const winnerHandle = winner.getHandle(workflowId);
    const result = await winnerHandle.result();
    expect(result).toBe('ran');
    // The loser never drove the generator — only one activity execution total.
    expect(activityRunCounts.get(workflowId)).toBe(1);
  });
});
