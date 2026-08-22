/**
 * WFT-78 acceptance criteria: `ownership: 'workflow-lease'` claim acquisition
 * across TWO REAL engine processes sharing ONE `MemoryStorage` — the actual
 * mechanism ADR 0002 exists to close (two engines both resuming/starting the
 * same workflow's next step), not a mock of it.
 *
 * Gate 1/Gate 2 construction wiring (actually instantiating a
 * `WorkflowClaimRegistry` from `Engine.create({ ownership: 'workflow-lease' })`)
 * is a parallel construction-stage concern this file does not own. These tests
 * install a real `WorkflowClaimRegistry` directly via `getInternals()` — the
 * same sanctioned test-support pattern `activity-worker-dispatcher.test-support.ts`
 * uses — so the CLAIM-ACQUIRING call sites this stage owns (start,
 * delayed-start fire, bulk retry, recovery) are exercised end to end
 * regardless of which stage lands first.
 *
 * MemoryStorage is adequate here (unlike `lease-deposition.test.ts`, which
 * needs `BunSQLiteStorage` to model a write racing INSIDE one
 * `conditionalBatch` call): `MemoryStorage#conditionalBatch` has no internal
 * `await`, so it is non-preemptible once started — the race under test here
 * is between two engines' independent, multi-`await` call chains (read epoch,
 * build fragment, THEN commit), which naturally interleave at each `await`
 * boundary and is exactly what a real cross-process race looks like.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine, WorkflowClaimUnavailableError } from './index.ts';
import { getInternals } from './internals.ts';
import { encodeEpoch } from './lease-codec.ts';
import { encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

/** Per-workflow-id activity execution counts. Ids are unique per test, so one shared map is safe. */
const activityRunCounts = new Map<string, number>();

function recordActivityRun(workflowId: string): void {
  activityRunCounts.set(workflowId, (activityRunCounts.get(workflowId) ?? 0) + 1);
}

/** Runs its one activity immediately — used for the fresh-start claim race. */
const claimRaceStartWorkflow = workflow({ name: 'claim-race-start' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.run(() => {
    recordActivityRun(ctx.workflowId);
    return 'ran';
  });
});

/** Parks on a signal first, so it is durably `running` without ever completing — the recovery-race fixture. */
const claimRaceRecoveryWorkflow = workflow({ name: 'claim-race-recovery' }).execute(
  async function* (ctx: WorkflowContext) {
    yield* ctx.waitForSignal('go');
    return yield* ctx.run(() => {
      recordActivityRun(ctx.workflowId);
      return 'ran';
    });
  },
);

type ClaimWorkflows = Record<
  string,
  typeof claimRaceStartWorkflow | typeof claimRaceRecoveryWorkflow
>;

/** Install a real `WorkflowClaimRegistry` into `engine`'s internals — see the module doc. */
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

/** Construct a `workflow-lease` engine with a real, installed claim registry, `recover: false` so the caller controls timing. */
async function createClaimEngine(
  storage: MemoryStorage,
  engineId: string,
  workflows: ClaimWorkflows,
) {
  const engine = await Engine.create({
    storage,
    workflows,
    ownership: 'workflow-lease',
    workflowClaimTtl: '1m',
    workflowClaimRenewInterval: '5s',
    recover: false,
  });
  installClaimRegistry(engine, engineId, storage);
  return engine;
}

/** Seed a durably `running`, signal-parked workflow via a plain `ownership: 'none'` engine, then dispose it — simulating a crashed prior owner with NO live claim. */
async function seedParkedWorkflow(storage: MemoryStorage, workflowId: string): Promise<void> {
  await using seedEngine = await Engine.create({
    storage,
    workflows: { 'claim-race-recovery': claimRaceRecoveryWorkflow },
    recover: false,
  });
  await seedEngine.start('claim-race-recovery', null, { id: workflowId });
  await waitForCondition(async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null, {
    label: `checkpoint for parked workflow "${workflowId}"`,
  });
}

/** Durably stamp a LIVE (unexpired) claim for `workflowId` held by a "ghost" engine that will never renew or release it. */
async function stampGhostClaim(
  storage: MemoryStorage,
  workflowId: string,
  ghostEngineId: string,
): Promise<void> {
  await storage.batch([
    { type: 'put', key: KEYS.workflowOwnerEpoch(workflowId), value: encodeEpoch(1) },
    {
      type: 'put',
      key: KEYS.workflowOwnerHolder(workflowId),
      value: encodeWorkflowClaimHolder({
        engineId: ghostEngineId,
        epoch: 1,
        expiresAt: Date.now() + 1_000_000,
        claimedAt: Date.now(),
      }),
    },
  ]);
}

describe('WFT-78: two engines sharing one store under ownership: "workflow-lease"', () => {
  it('two engines racing to start the same workflow id: exactly one wins and the loser runs no user code', async () => {
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-start': claimRaceStartWorkflow };
    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);
    await using engineB = await createClaimEngine(storage, 'engine-b', workflows);
    const workflowId = 'claim-race-start-1';

    const [outcomeA, outcomeB] = await Promise.allSettled([
      engineA.start('claim-race-start', null, { id: workflowId }),
      engineB.start('claim-race-start', null, { id: workflowId }),
    ]);
    const outcomes = [outcomeA, outcomeB];
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    // Exactly one engine's start() won the claim CAS.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(WorkflowClaimUnavailableError);
    expect((rejection.reason as WorkflowClaimUnavailableError).workflowId).toBe(workflowId);

    const winnerHandle = (
      fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof engineA.start>>>
    ).value;
    await winnerHandle.result();

    // The claim fold commits BEFORE the generator launches, so the loser's
    // start() throws before any user code could run — assert this on the
    // activity's OWN side effect (not a returned status), which would still
    // pass a buggy build that let both engines launch the generator and only
    // diverged at the checkpoint commit.
    expect(activityRunCounts.get(workflowId)).toBe(1);
  });

  it('two engines recovering two eligible workflows each make durable progress on a different one', async () => {
    const storage = new MemoryStorage();
    await seedParkedWorkflow(storage, 'recover-race-1');
    await seedParkedWorkflow(storage, 'recover-race-2');

    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);
    await using engineB = await createClaimEngine(storage, 'engine-b', workflows);

    const [handlesA, handlesB] = await Promise.all([engineA.recoverAll(), engineB.recoverAll()]);
    const idsA = handlesA.map((handle) => handle.id).toSorted();
    const idsB = handlesB.map((handle) => handle.id).toSorted();

    // No double-recovery: the two engines' recovered sets are disjoint and, together,
    // cover both seeded workflows exactly once — each engine progresses a DIFFERENT one.
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect([...idsA, ...idsB].toSorted()).toEqual(['recover-race-1', 'recover-race-2']);
    expect(idsA).toHaveLength(1);
    expect(idsB).toHaveLength(1);

    // Both make DURABLE progress: signal each recovered handle's owner and confirm
    // its activity actually ran exactly once — not merely that recovery "returned".
    for (const [handles, engine] of [
      [handlesA, engineA],
      [handlesB, engineB],
    ] as const) {
      const handle = handles[0];
      if (handle === undefined) continue;
      await engine.getHandle(handle.id)?.signal('go');
      const result = await handle.result();
      expect(result).toBe('ran');
      expect(activityRunCounts.get(handle.id)).toBe(1);
    }
  });

  it('a background sweep that loses one claim still recovers the others', async () => {
    const storage = new MemoryStorage();
    await seedParkedWorkflow(storage, 'sweep-race-contested');
    await seedParkedWorkflow(storage, 'sweep-race-free');
    await stampGhostClaim(storage, 'sweep-race-contested', 'ghost-engine');

    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engine = await createClaimEngine(storage, 'engine-a', workflows);

    // recoverAll() must never throw for a lost claim — it isolates per workflow.
    const handles = await engine.recoverAll();
    const recoveredIds = handles.map((handle) => handle.id);
    expect(recoveredIds).toEqual(['sweep-race-free']);

    // The contested workflow was never claimed by this engine — the loser
    // truly never touched it, not merely "didn't return a handle for it".
    expect(getInternals(engine).workflowClaimRegistry?.currentEpoch('sweep-race-contested')).toBe(
      null,
    );

    // The uncontested workflow made real durable progress.
    await engine.getHandle('sweep-race-free')?.signal('go');
    const result = await engine.getHandle('sweep-race-free')?.result();
    expect(result).toBe('ran');
    expect(activityRunCounts.get('sweep-race-free')).toBe(1);
  });

  it('engine.resume(id) throws WorkflowClaimUnavailableError on a lost race', async () => {
    const storage = new MemoryStorage();
    await seedParkedWorkflow(storage, 'explicit-resume-race');
    await stampGhostClaim(storage, 'explicit-resume-race', 'ghost-engine');

    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engine = await createClaimEngine(storage, 'engine-a', workflows);

    const rejection = expect(engine.resume('explicit-resume-race')).rejects;
    await rejection.toBeInstanceOf(WorkflowClaimUnavailableError);
    await rejection.toMatchObject({ workflowId: 'explicit-resume-race', heldBy: 'ghost-engine' });

    // An explicit single-workflow caller throws — unlike recoverAll(), which isolates.
    expect(getInternals(engine).workflowClaimRegistry?.currentEpoch('explicit-resume-race')).toBe(
      null,
    );
  });
});
