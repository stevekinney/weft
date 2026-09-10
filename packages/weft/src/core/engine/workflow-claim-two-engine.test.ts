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

import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import {
  ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING,
  Engine,
  WorkflowClaimUnavailableError,
} from './index.ts';
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

describe('WFT-134: engine.suspend() does not strand a same-engine resume() under ownership: "workflow-lease"', () => {
  it('suspend forgets the LOCAL claim cache entry, and a same-engine resume() re-acquires and runs to completion', async () => {
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engine = await createClaimEngine(storage, 'engine-a', workflows);
    const workflowId = 'suspend-resume-same-engine';

    // Start through the first committed step: `start()` folds `acquire` into
    // its own commit (WFT-78 test 1 above), so by the time the run parks on
    // `waitForSignal` this engine's registry tracks a real, non-null epoch —
    // the exact precondition the root-cause analysis requires.
    const handle = await engine.start('claim-race-recovery', null, { id: workflowId });
    await waitForCondition(() => engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]() === 1, {
      label: 'inline workflow parked on waitForSignal',
    });
    const registry = getInternals(engine).workflowClaimRegistry;
    expect(registry).not.toBeNull();
    expect(registry?.currentEpoch(workflowId)).not.toBeNull();

    await handle.suspend();

    // Durable invariant (mirrors `termination/suspend.test.ts`'s rotation
    // assertion): the external terminal rotation folded into suspend's commit
    // deletes the durable holder record — suspend leaves the workflow
    // genuinely unowned, not owned-by-this-engine.
    expect(await storage.get(KEYS.workflowOwnerHolder(workflowId))).toBeNull();
    // Local invariant this fix adds (Part 2, `WorkflowClaimRegistry.forgetLocalClaim`):
    // this engine's local cache no longer disagrees with that durable fact.
    // Before the fix this stayed non-null, which routed the resume below onto
    // `acquireStandaloneClaimBeforeResume`'s stale-cache fast path instead of
    // a fresh `acquire()`.
    expect(registry?.currentEpoch(workflowId)).toBeNull();

    // The regression itself: resuming on the SAME engine instance must
    // succeed, not throw WorkflowClaimUnavailableError.
    const resumedHandle = await engine.resume(workflowId);
    expect(registry?.currentEpoch(workflowId)).not.toBeNull();

    await engine.signal(workflowId, 'go');
    const result = await resumedHandle.result();
    expect(result).toBe('ran');
    expect(activityRunCounts.get(workflowId)).toBe(1);
  });

  it('two engines racing to resume the same suspended workflow: exactly one wins (the fence is not weakened)', async () => {
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);
    await using engineB = await createClaimEngine(storage, 'engine-b', workflows);
    const workflowId = 'suspend-resume-two-engine-race';

    const handle = await engineA.start('claim-race-recovery', null, { id: workflowId });
    await waitForCondition(() => engineA[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]() === 1, {
      label: 'inline workflow parked on waitForSignal',
    });
    await handle.suspend();
    expect(await storage.get(KEYS.workflowOwnerHolder(workflowId))).toBeNull();

    // Both engines race a fresh `acquire()` against the now-holderless
    // workflow: neither has a cached epoch (engineA's was cleared by Part 2's
    // `forgetLocalClaim` inside `suspend()` — see the previous test; engineB
    // never held one), so BOTH skip `acquireStandaloneClaimBeforeResume`'s
    // cached-epoch branch entirely and go straight to `registry.acquire()`.
    // This is a DIFFERENT path from Part 1's `holder-absent` fall-through
    // (exercised by the dedicated test below, where a cache is deliberately
    // left stale); this test instead proves the ordinary `acquire()` CAS
    // itself still fences correctly here. Exactly one wins the durable CAS.
    const [outcomeA, outcomeB] = await Promise.allSettled([
      engineA.resume(workflowId),
      engineB.resume(workflowId),
    ]);
    const outcomes = [outcomeA, outcomeB];
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(WorkflowClaimUnavailableError);
    expect((rejection.reason as WorkflowClaimUnavailableError).workflowId).toBe(workflowId);

    const winnerEngine = fulfilled[0] === outcomeA ? engineA : engineB;
    await winnerEngine.signal(workflowId, 'go');
    const winnerHandle = (
      fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof engineA.resume>>>
    ).value;
    expect(await winnerHandle.result()).toBe('ran');
    expect(activityRunCounts.get(workflowId)).toBe(1);
  });

  it('Part 1: a stale local cache entry ("held") against an absent durable holder still resumes via a fresh acquire', async () => {
    // Deliberately reproduces the exact race Part 1 closes WITHOUT going
    // through `suspendWorkflow`'s own `forgetLocalClaim` call (Part 2), so
    // this test exercises `acquireStandaloneClaimBeforeResume`'s
    // `wakeOwnershipCheck` `'holder-absent'` fall-through in isolation: the
    // OTHER two tests above never enter that branch at all, because Part 2
    // already clears the cache before either of them calls `resume()` (see
    // the previous test's comment) — cachedEpoch is null there, so the whole
    // `if (cachedEpoch !== null)` block, and the fall-through inside it, is
    // never reached. This test manufactures "cache says held" independently
    // of suspend to prove Part 1 itself, not just Part 1-and-2-together.
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    const workflowId = 'suspend-resume-stale-cache';

    // Seed a durably suspended workflow via a throwaway plain engine —
    // mirrors `seedParkedWorkflow`'s pattern, but suspends before dispose so
    // the persisted status is 'suspended', not 'running'.
    {
      await using seedEngine = await Engine.create({ storage, workflows, recover: false });
      const seedHandle = await seedEngine.start('claim-race-recovery', null, { id: workflowId });
      await waitForCondition(
        async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null,
        { label: `checkpoint for seeded workflow "${workflowId}"` },
      );
      await seedHandle.suspend();
    }
    expect(await storage.get(KEYS.workflowOwnerHolder(workflowId))).toBeNull();

    await using engine = await createClaimEngine(storage, 'engine-a', workflows);
    const registry = getInternals(engine).workflowClaimRegistry;
    expect(registry).not.toBeNull();

    // Populate this engine's LOCAL cache as though it already held the
    // claim — `acquire()` durably writes BOTH the epoch and holder keys and
    // records them in the registry's cache.
    const acquireResult = await registry?.acquire(workflowId);
    expect(acquireResult?.status).toBe('acquired');
    expect(registry?.currentEpoch(workflowId)).not.toBeNull();

    // Now delete ONLY the durable holder record directly — WITHOUT going
    // through `release()`/`forgetLocalClaim` — reproducing "the cache still
    // says held, but the durable holder is gone" independently of suspend's
    // own rotation. The epoch key is left in place, matching what a real
    // external terminal rotation does (rotate epoch, delete holder only).
    await storage.delete(KEYS.workflowOwnerHolder(workflowId));
    expect(registry?.currentEpoch(workflowId)).not.toBeNull();

    // Before Part 1: `wakeOwnershipCheck` would return `{ status: 'discarded',
    // reason: 'holder-absent' }` and this threw WorkflowClaimUnavailableError
    // immediately. After Part 1: 'holder-absent' falls through to a fresh
    // `registry.acquire()`, which succeeds because nothing else holds the
    // (now genuinely unclaimed) workflow.
    const resumedHandle = await engine.resume(workflowId);
    expect(registry?.currentEpoch(workflowId)).not.toBeNull();

    await engine.signal(workflowId, 'go');
    expect(await resumedHandle.result()).toBe('ran');
    expect(activityRunCounts.get(workflowId)).toBe(1);
  });

  it('Part 2 (suspend.ts): the local claim forgotten after suspend is the PRE-suspend generation, not a fresh one a same-engine resume raced in before the commit promise resolved', async () => {
    // Reproduces the review's exact race: with an asynchronous storage
    // adapter, suspend's durable commit can already be visible while the
    // `await` suspendWorkflow itself is sitting on has not yet resumed. A
    // concurrent same-engine `resume()` can land in that gap, observe the
    // durably-suspended state, and `acquire()` a fresh claim before suspend's
    // own continuation runs. Sampling the epoch to forget AFTER that `await`
    // (the pre-fix code) would then capture resume's fresh epoch, not the one
    // suspend's own rotation deposed, and forget the live claim resume just
    // installed. Gating the specific `conditionalBatch` call suspend's own
    // external-terminal rotation makes (identified by its
    // `wf-owner-holder:<id>` delete) lets the underlying `MemoryStorage`
    // mutation apply (`MemoryStorage#conditionalBatch` has no internal
    // `await`, per this file's module doc) while withholding the resolved
    // PROMISE from `suspendWorkflow`, modeling an adapter with real I/O
    // latency without needing one.
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engine = await createClaimEngine(storage, 'engine-a', workflows);
    const workflowId = 'suspend-precommit-epoch-capture';

    const handle = await engine.start('claim-race-recovery', null, { id: workflowId });
    await waitForCondition(() => engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]() === 1, {
      label: 'inline workflow parked on waitForSignal',
    });
    const registry = getInternals(engine).workflowClaimRegistry;
    expect(registry).not.toBeNull();
    const preSuspendEpoch = registry?.currentEpoch(workflowId) ?? null;
    expect(preSuspendEpoch).not.toBeNull();

    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = true;
    const holderKey = KEYS.workflowOwnerHolder(workflowId);
    const internals = getInternals(engine);
    const realStorage = internals.storage;
    internals.storage = new Proxy(realStorage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            const result = await target.conditionalBatch!(conditions, operations);
            if (armed && operations.some((op) => op.type === 'delete' && op.key === holderKey)) {
              armed = false;
              reached.resolve();
              await release.promise;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const suspendPromise = handle.suspend();
    await reached.promise;

    // Durable invariant: the rotation is already visible even though
    // `suspendPromise` has not resolved.
    expect(await storage.get(holderKey)).toBeNull();

    // A concurrent same-engine resume() races in through the gap: it reads
    // the durably-suspended state and installs a fresh claim before
    // suspend's own promise continuation runs.
    const resumePromise = engine.resume(workflowId);
    await waitForCondition(() => (registry?.currentEpoch(workflowId) ?? null) !== preSuspendEpoch, {
      label: 'resume() installs a fresh claim epoch',
    });
    const freshEpoch = registry?.currentEpoch(workflowId) ?? null;
    expect(freshEpoch).not.toBeNull();
    expect(freshEpoch).not.toBe(preSuspendEpoch);

    release.resolve();
    await suspendPromise;

    // The regression: suspend's forget-local-claim step must not wipe the
    // fresh claim resume() just installed — it must still equal resume's
    // epoch, never `null`, once suspend's own writeOperation finishes.
    expect(registry?.currentEpoch(workflowId)).toBe(freshEpoch);

    const resumedHandle = await resumePromise;
    await engine.signal(workflowId, 'go');
    expect(await resumedHandle.result()).toBe('ran');
    expect(activityRunCounts.get(workflowId)).toBe(1);
  });

  it('resume(): a claim freshly acquired for a workflow that turns terminal mid-flight is released, not leaked (standalone-claim-acquire.ts)', async () => {
    // Reproduces the review's other race: another engine can cancel/time out
    // a suspended workflow AFTER `resumeWorkflowFromStorage()`'s own initial
    // state read but BEFORE `acquireStandaloneClaimBeforeResume` runs.
    // `registry.acquire()` does not itself check workflow status, so it wins
    // a fresh claim for a workflow that is actually terminal; without a fix,
    // nothing ever releases it, and it would keep renewing forever and block
    // a legitimate `start-new`.
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    const workflowId = 'resume-terminal-mid-flight';

    // Seed a durably suspended workflow via a throwaway plain engine,
    // mirroring the "Part 1" test's seeding pattern above.
    {
      await using seedEngine = await Engine.create({ storage, workflows, recover: false });
      const seedHandle = await seedEngine.start('claim-race-recovery', null, { id: workflowId });
      await waitForCondition(
        async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null,
        { label: `checkpoint for seeded workflow "${workflowId}"` },
      );
      await seedHandle.suspend();
    }
    expect(await storage.get(KEYS.workflowOwnerHolder(workflowId))).toBeNull();

    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);
    await using engineB = await createClaimEngine(storage, 'engine-b', workflows);
    const registryA = getInternals(engineA).workflowClaimRegistry;
    expect(registryA).not.toBeNull();

    // Gate engineA's SECOND read of the workflow record: `resume()`'s own
    // local-ownership read (`lifecycle/transition.ts`) happens first and is
    // left unblocked (engineA never locally owned this workflow, so that
    // check is a fast in-memory no-op regardless of timing); the read
    // `resumeWorkflowFromStorage()` makes at its own top is the second. Let
    // the real (still-'suspended') value resolve internally, but withhold it
    // from the caller until engineB's concurrent cancel has committed.
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let matchCount = 0;
    const workflowKey = KEYS.workflow(workflowId);
    const internalsA = getInternals(engineA);
    const realStorageA = internalsA.storage;
    internalsA.storage = new Proxy(realStorageA, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string) => {
            const value = await target.get(key);
            if (key === workflowKey) {
              matchCount += 1;
              if (matchCount === 2) {
                reached.resolve();
                await release.promise;
              }
            }
            return value;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const resumePromise = engineA.resume(workflowId);
    await reached.promise;

    // A different engine terminalizes the workflow while engineA's resume is
    // still holding the stale 'suspended' state it already read.
    await engineB.cancel(workflowId);

    release.resolve();

    await expect(resumePromise).rejects.toThrow(/status is "cancelled"/);

    // The regression: `acquireStandaloneClaimBeforeResume` freshly installed
    // a claim for engineA (no cached epoch, and nothing else held it after
    // engineB's rotation) for what turned out to be a now-terminal workflow.
    // It must be released here, not leaked.
    expect(registryA?.currentEpoch(workflowId)).toBeNull();

    // Proves the release was DURABLE, not just a local cache clear: a
    // legitimate `start-new` must not lose its own claim CAS to a stranded
    // holder record.
    const restarted = await engineA.start('claim-race-recovery', null, {
      id: workflowId,
      onTerminalConflict: 'start-new',
    });
    await engineA.signal(workflowId, 'go');
    expect(await restarted.result()).toBe('ran');
    expect(activityRunCounts.get(workflowId)).toBe(1);
  });
});
