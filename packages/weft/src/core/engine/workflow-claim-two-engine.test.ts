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
import { ExtData, decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import { describe, expect, it } from 'bun:test';

import { GENERATION_KEYS } from '../../storage/generation-keys.ts';
import {
  KEYS,
  encodeStorageKeyComponent,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { rejectionOf, throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { decode, encode } from '../codec.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { CURRENT_CHECKPOINT_SCHEMA_VERSION } from '../types/checkpoint.ts';
import { purgeWorkflow } from './bulk-operations-purge.ts';
import { TERMINAL_CLEANUP_DELAY_MS } from './bulk-operations.ts';
import { decodeGeneration } from './generation-codec.ts';
import {
  ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING,
  Engine,
  WorkflowClaimUnavailableError,
} from './index.ts';
import { getInternals } from './internals.ts';
import { decodeEpoch, encodeEpoch } from './lease-codec.ts';
import { EngineDeposedError } from './lease-errors.ts';
import { loadWorkflowState } from './storage-io.ts';
import { decodeWorkflowClaimHolder, encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';
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

/** Parks on a signal, then returns its own input, so two runs of one id have distinct durable results. */
const claimRaceEchoWorkflow = workflow({ name: 'claim-race-echo' }).execute(async function* (
  ctx: WorkflowContext,
  input: string,
) {
  yield* ctx.waitForSignal('go');
  return input;
});

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
  // Manual background tasks: the renewal/reclaim interval is bound to the
  // registry `Engine.create` built, not the one installed below, so an
  // automatic tick could claim a workflow under an engine id the test
  // never controls. Nothing here needs the interval.
  const engine = await Engine.create({
    storage,
    workflows,
    ownership: 'workflow-lease',
    workflowClaimTtl: '1m',
    workflowClaimRenewInterval: '5s',
    recover: false,
    backgroundTasks: 'manual',
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
    expect([...idsA, ...idsB].toSorted((left, right) => left.localeCompare(right))).toEqual([
      'recover-race-1',
      'recover-race-2',
    ]);
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

    const rejection = expect(await rejectionOf(engine.resume('explicit-resume-race')));
    rejection.toBeInstanceOf(WorkflowClaimUnavailableError);
    rejection.toMatchObject({ workflowId: 'explicit-resume-race', heldBy: 'ghost-engine' });

    // An explicit single-workflow caller throws — unlike recoverAll(), which isolates.
    expect(getInternals(engine).workflowClaimRegistry?.currentEpoch('explicit-resume-race')).toBe(
      null,
    );
  });
});

// COR-1390: a holder whose claim lapses (a starved renewal on a loaded host)
// still sees the run's outcome through `handle.result()`, which reads it from
// the store. `lostWorkflowClaim` is how it learns the outcome is not its own: the
// answer comes from the engine ID each terminal write records, kept on the handle
// when its `result()` settles.
describe('Engine.lostWorkflowClaim', () => {
  const lapseMs = 60_000 + 2 * 5_000 + 1;

  /** Two `workflow-lease` engines on one store whose claim registries share a controllable clock. */
  async function createLapsingEngines(storage: MemoryStorage) {
    const clock = { now: 1_000_000 };
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    const createEngine = async (engineId: string) => {
      const engine = await Engine.create({
        storage,
        workflows,
        ownership: 'workflow-lease',
        workflowClaimTtl: 60_000,
        workflowClaimRenewInterval: 5_000,
        recover: false,
        backgroundTasks: 'manual',
      });
      const registry = new WorkflowClaimRegistry({
        storage,
        engineId,
        getNow: () => clock.now,
        claimTtlMs: 60_000,
        claimRenewIntervalMs: 5_000,
        warn: () => {},
      });
      getInternals(engine).workflowClaimRegistry = registry;
      return { engine, registry };
    };
    return { clock, first: await createEngine('engine-a'), second: await createEngine('engine-b') };
  }

  /** Engine B takes engine A's lapsed claim on `workflowId`, drives the run, and completes it. */
  async function takeOverAndComplete(
    clock: { now: number },
    second: Awaited<ReturnType<typeof createLapsingEngines>>['second'],
    workflowId: string,
  ) {
    clock.now += lapseMs;
    expect(await second.registry.takeover(workflowId)).toMatchObject({ status: 'acquired' });
    await second.engine.recoverAll();
    const handleOnSecond = second.engine.getHandle(workflowId);
    await handleOnSecond.signal('go');
    expect(await handleOnSecond.result()).toBe('ran');
    return handleOnSecond;
  }

  it('is false under ownership: "none"', async () => {
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engine = await Engine.create({ storage, workflows, recover: false });
    const handle = await engine.start('claim-race-recovery', null, { id: 'any-workflow' });
    await handle.signal('go');
    expect(await handle.result()).toBe('ran');

    expect(engine.lostWorkflowClaim(handle)).toBe(false);
  });

  it('is false for a handle whose result has not settled', async () => {
    const storage = new MemoryStorage();
    const { first } = await createLapsingEngines(storage);
    await using firstEngine = first.engine;
    const handle = await firstEngine.start('claim-race-recovery', null, { id: 'unsettled-run' });
    expect(firstEngine.lostWorkflowClaim(handle)).toBe(false);

    const outcome = handle.result();
    void outcome.catch(() => {});
    expect(firstEngine.lostWorkflowClaim(handle)).toBe(false);
  });

  it('tells the holder whose lapsed claim another engine reclaimed that the result it observes is not its own', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'lapsed-claim-handoff';
    await seedParkedWorkflow(storage, workflowId);
    const { clock, first, second } = await createLapsingEngines(storage);
    await using firstEngine = first.engine;
    await using secondEngine = second.engine;

    // The first engine recovers the parked run and holds its claim.
    const recoveredByFirst = await firstEngine.recoverAll();
    expect(recoveredByFirst.map((handle) => handle.id)).toEqual([workflowId]);
    const handleOnFirst = firstEngine.getHandle(workflowId);
    const observedByFirst = handleOnFirst.result();
    expect(firstEngine.lostWorkflowClaim(handleOnFirst)).toBe(false);

    // Its claim lapses without a renewal; the second engine reclaims the run and finishes it.
    const handleOnSecond = await takeOverAndComplete(clock, second, workflowId);

    // The first engine's waiter settles with the run's outcome, read from the store...
    await firstEngine.runMaintenance();
    expect(await observedByFirst).toBe('ran');
    // ...but the outcome is the second engine's, not the first's.
    expect(firstEngine.lostWorkflowClaim(handleOnFirst)).toBe(true);
    expect(secondEngine.lostWorkflowClaim(handleOnSecond)).toBe(false);
    expect(activityRunCounts.get(workflowId)).toBe(1);
  });

  it('keeps answering for the run that lost its claim after a start-new replacement reuses the workflow id', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'lost-claim-then-replaced';
    await seedParkedWorkflow(storage, workflowId);
    const { clock, first, second } = await createLapsingEngines(storage);
    await using firstEngine = first.engine;
    await using secondEngine = second.engine;

    const [originalOnFirst] = await firstEngine.recoverAll();
    expect(originalOnFirst?.id).toBe(workflowId);
    const originalOutcome = originalOnFirst?.result();
    await takeOverAndComplete(clock, second, workflowId);
    await firstEngine.runMaintenance();
    expect(await originalOutcome).toBe('ran');
    expect(firstEngine.lostWorkflowClaim(originalOnFirst!)).toBe(true);

    // Engine A then starts a replacement run under the same id, with a fresh claim.
    const replacementOnFirst = await firstEngine.start('claim-race-recovery', null, {
      id: workflowId,
      onTerminalConflict: 'start-new',
    });
    const replacementOutcome = replacementOnFirst.result();
    expect(firstEngine.lostWorkflowClaim(replacementOnFirst)).toBe(false);
    expect(firstEngine.lostWorkflowClaim(originalOnFirst!)).toBe(true);

    // The replacement settles with an outcome its own engine committed.
    await firstEngine.signal(workflowId, 'go');
    expect(await replacementOutcome).toBe('ran');
    expect(firstEngine.lostWorkflowClaim(replacementOnFirst)).toBe(false);
    expect(firstEngine.lostWorkflowClaim(originalOnFirst!)).toBe(true);
    expect(secondEngine.lostWorkflowClaim(secondEngine.getHandle(workflowId))).toBe(false);
  });

  it('keeps reporting a lost claim through a same-engine suspend and resume', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'suspended-resumed-then-lost';
    const { clock, first, second } = await createLapsingEngines(storage);
    await using firstEngine = first.engine;
    await using secondEngine = second.engine;

    const handle = await firstEngine.start('claim-race-recovery', null, { id: workflowId });
    const outcome = handle.result();
    await waitForCondition(async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null, {
      label: 'checkpoint for the started run',
    });
    const epochBeforeSuspend = first.registry.currentEpoch(workflowId);
    await handle.suspend();
    await firstEngine.resume(workflowId);
    expect(first.registry.currentEpoch(workflowId)).not.toBe(epochBeforeSuspend);
    expect(firstEngine.lostWorkflowClaim(handle)).toBe(false);

    // Engine A's claim lapses; engine B takes the run and completes it.
    await takeOverAndComplete(clock, second, workflowId);
    await firstEngine.runMaintenance();
    expect(await outcome).toBe('ran');

    expect(firstEngine.lostWorkflowClaim(handle)).toBe(true);
    expect(firstEngine.lostWorkflowClaim(firstEngine.getHandle(workflowId))).toBe(true);
    expect(secondEngine.lostWorkflowClaim(secondEngine.getHandle(workflowId))).toBe(false);
  });

  it('keeps reporting a lost claim when a resume that won a fresh claim is rejected by the status re-check', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'lost-then-rejected-resume';
    const { clock, first, second } = await createLapsingEngines(storage);
    await using firstEngine = first.engine;
    await using secondEngine = second.engine;

    const handle = await firstEngine.start('claim-race-recovery', null, { id: workflowId });
    const outcome = handle.result();
    void outcome.catch(() => {});
    await waitForCondition(async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null, {
      label: 'checkpoint for the started run',
    });
    clock.now += lapseMs;
    // Engine B takes the lapsed claim and suspends the run, so A holds nothing durable for it.
    expect(await second.registry.takeover(workflowId)).toMatchObject({ status: 'acquired' });
    await secondEngine.recoverAll();
    await secondEngine.getHandle(workflowId).suspend();

    // Hold engine A's resume after it read the suspended state, before it acquires a claim.
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let workflowReads = 0;
    const workflowKey = KEYS.workflow(workflowId);
    const internalsA = getInternals(firstEngine);
    const realStorageA = internalsA.storage;
    internalsA.storage = new Proxy(realStorageA, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string) => {
            const value = await target.get(key);
            if (key === workflowKey) {
              workflowReads += 1;
              if (workflowReads === 2) {
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
    const resumePromise = firstEngine.resume(workflowId);
    await reached.promise;
    // Engine B cancels the suspended run while A's resume is held.
    await secondEngine.cancel(workflowId);

    // A's resume wins a fresh claim, then its status re-check rejects it and releases that claim.
    release.resolve();
    expect(await throwingRejectionOf(resumePromise)).toThrow(/status is "cancelled"/);
    expect(first.registry.currentEpoch(workflowId)).toBeNull();

    // A's result settles with the cancellation B committed, so the loss is still reported.
    await firstEngine.runMaintenance();
    await rejectionOf(outcome);
    expect(firstEngine.lostWorkflowClaim(handle)).toBe(true);
  });

  it('reports no loss for a run this engine reacquired after a loss and then failed at an early exit', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'reacquired-then-early-exit';
    let now = 1_000_000;
    const lapseTimeMs = 3_000 + 2 * 1_000 + 1;
    const createEngine = async () => {
      const engine = new Engine({
        storage,
        ownership: 'workflow-lease',
        backgroundTasks: 'manual',
        getNow: () => now,
        workflowClaimTtl: 3_000,
        workflowClaimRenewInterval: 1_000,
      });
      engine.register(claimRaceRecoveryWorkflow);
      await engine.recoverAll();
      return engine;
    };
    await using engineA = await createEngine();
    await using engineB = await createEngine();

    const handle = await engineA.start('claim-race-recovery', null, {
      id: workflowId,
      services: {},
    });
    const outcome = handle.result();
    void outcome.catch(() => {});
    await waitForCondition(async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null, {
      label: 'checkpoint for the started run',
    });

    // Engine B takes the lapsed claim and holds it without driving the run, then its claim lapses too.
    now += lapseTimeMs;
    expect(await getInternals(engineB).workflowClaimRegistry!.takeover(workflowId)).toMatchObject({
      status: 'acquired',
    });
    now += lapseTimeMs;

    // Engine A reclaims the run. Its live services are gone and no resolver can re-provide them,
    // so the run fails at the services check, under the new claim, before the resume commits.
    getInternals(engineA).workflowServices.delete(workflowId);
    // The first pass renews, finds the claim lost, and starts the takeover cooldown; the second reclaims.
    await engineA.runMaintenance(now);
    now += 1_500;
    await engineA.runMaintenance(now);
    const error = await rejectionOf(outcome);

    expect((error as Error).message).toMatch(/services/i);
    expect(engineA.lostWorkflowClaim(handle)).toBe(false);
  });

  it('stamps the committing engine on every terminal write under workflow-lease, and nothing under ownership: "none"', async () => {
    const storage = new MemoryStorage();
    const failingWorkflow = workflow({ name: 'claim-race-fail' }).execute(async function* () {
      throw new Error('boom');
    });
    const workflows = {
      'claim-race-start': claimRaceStartWorkflow,
      'claim-race-recovery': claimRaceRecoveryWorkflow,
      'claim-race-fail': failingWorkflow,
    } as unknown as ClaimWorkflows;
    await using engine = await createClaimEngine(storage, 'engine-a', workflows);
    const committedBy = async (workflowId: string) => {
      const bytes = await storage.get(KEYS.workflow(workflowId));
      return (msgpackDecode(bytes!) as { terminalCommittedBy?: string }).terminalCommittedBy;
    };

    const completed = await engine.start('claim-race-start', null, { id: 'stamp-completed' });
    expect(await completed.result()).toBe('ran');
    const failed = await engine.start('claim-race-fail', null, { id: 'stamp-failed' });
    await rejectionOf(failed.result());
    const cancelled = await engine.start('claim-race-recovery', null, { id: 'stamp-cancelled' });
    await cancelled.cancel();
    await rejectionOf(cancelled.result());

    expect(await committedBy('stamp-completed')).toBe('engine-a');
    expect(await committedBy('stamp-failed')).toBe('engine-a');
    expect(await committedBy('stamp-cancelled')).toBe('engine-a');

    const plainStorage = new MemoryStorage();
    await using plain = await Engine.create({ storage: plainStorage, workflows, recover: false });
    const plainRun = await plain.start('claim-race-start', null, { id: 'stamp-plain' });
    expect(await plainRun.result()).toBe('ran');
    const plainBytes = await plainStorage.get(KEYS.workflow('stamp-plain'));
    expect(
      (msgpackDecode(plainBytes!) as { terminalCommittedBy?: string }).terminalCommittedBy,
    ).toBe(undefined);
  });

  it('stays false for a run this engine completed and replaced itself', async () => {
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-start': claimRaceStartWorkflow };
    await using engine = await createClaimEngine(storage, 'engine-a', workflows);
    const workflowId = 'completed-then-replaced';

    const original = await engine.start('claim-race-start', null, { id: workflowId });
    expect(await original.result()).toBe('ran');
    const replacement = await engine.start('claim-race-start', null, {
      id: workflowId,
      onTerminalConflict: 'start-new',
    });
    expect(await replacement.result()).toBe('ran');

    expect(engine.lostWorkflowClaim(original)).toBe(false);
    expect(engine.lostWorkflowClaim(replacement)).toBe(false);
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
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](handle.id);
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
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](handle.id);
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
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](handle.id);
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

    expect(await throwingRejectionOf(resumePromise)).toThrow(/status is "cancelled"/);

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

describe('WFT-134 review round 2: claim-generation release correctness', () => {
  it('resume(): holder-absent fallthrough for a STALE CACHED claim, raced against a genuine foreign cancel, releases the fresh claim without leaking it (standalone-claim-acquire.ts, issue A)', async () => {
    // Part 1 (above) proves the `cachedEpoch !== null` -> `holder-absent`
    // fallthrough resumes successfully when nothing else races it. The
    // "terminal-mid-flight" test (above) proves a FRESH (never-cached)
    // acquire gets released when the workflow turns out to be terminal. This
    // test is the interleaving the round-2 finding is actually about: a
    // STALE CACHED epoch (not a fresh acquire) whose `holder-absent` signal
    // comes from a GENUINE foreign termination racing in between
    // `resumeWorkflowFromStorage()`'s own state read and the ownership
    // check — never exercised by either test above in isolation.
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    const workflowId = 'holder-absent-stale-cache-foreign-race';

    await seedParkedWorkflow(storage, workflowId);

    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);
    await using engineB = await createClaimEngine(storage, 'engine-b', workflows);
    const registryA = getInternals(engineA).workflowClaimRegistry;
    expect(registryA).not.toBeNull();

    // Populate engineA's LOCAL cache as though it already held the claim
    // from an earlier pass (mirrors Part 1's setup) — the precondition for
    // entering `acquireStandaloneClaimBeforeResume`'s `cachedEpoch !== null`
    // branch at all. Without this, a fresh engine's resume() takes the "no
    // claim cached yet" path and never reaches the `holder-absent`
    // fallthrough this finding is about.
    const staleAcquire = await registryA?.acquire(workflowId);
    expect(staleAcquire?.status).toBe('acquired');
    expect(registryA?.currentEpoch(workflowId)).not.toBeNull();

    // Gate engineA's OWN top-of-function state read inside
    // `resumeWorkflowFromStorage` (the SECOND `get(workflowKey)` — the first
    // is `resume()`'s own local-ownership check, a fast in-memory no-op
    // here since engineA never locally started this workflow). Let the real
    // (still-'running') value resolve internally, but withhold it from the
    // caller until engineB's concurrent cancel has committed.
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

    // engineB genuinely terminalizes the workflow WHILE engineA's resume is
    // still holding the stale 'running' state it already read — this durably
    // deletes `wf-owner-holder:<id>` and rotates the epoch, the SAME
    // `'holder-absent'` signature `suspendWorkflow`'s own rotation leaves,
    // but this time from a GENUINE foreign termination, not engineA's own
    // prior suspend.
    await engineB.cancel(workflowId);

    release.resolve();

    expect(await throwingRejectionOf(resumePromise)).toThrow(/status is "cancelled"/);

    // The regression this finding describes: `acquireStandaloneClaimBeforeResume`
    // saw `cachedEpoch !== null` (the stale entry `staleAcquire` installed),
    // `wakeOwnershipCheck` reported `'holder-absent'` (engineB's rotation,
    // not engineA's own suspend), and fell through to a fresh
    // `registry.acquire()` for what turned out to be a now-terminal
    // workflow. It must be released, not leaked.
    expect(registryA?.currentEpoch(workflowId)).toBeNull();

    // Proves the release was DURABLE: a legitimate `start-new` must not lose
    // its own claim CAS to a stranded holder record.
    const restarted = await engineA.start('claim-race-recovery', null, {
      id: workflowId,
      onTerminalConflict: 'start-new',
    });
    await engineA.signal(workflowId, 'go');
    expect(await restarted.result()).toBe('ran');
  });

  it('resume(): a cleanup release must not drop a REPLACEMENT claim installed while the failed resume was still in flight (standalone-claim-acquire.ts, issue B)', async () => {
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    const workflowId = 'release-wrong-generation';

    await seedParkedWorkflow(storage, workflowId);

    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);
    await using engineB = await createClaimEngine(storage, 'engine-b', workflows);
    const registryA = getInternals(engineA).workflowClaimRegistry;
    expect(registryA).not.toBeNull();

    // Gate engineA's checkpoint read inside `performResumeAfterClaimAcquired`
    // — AFTER the fresh claim acquire commits, but BEFORE the serialized
    // status/generation re-check that will eventually reject this resume.
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const checkpointKey = KEYS.checkpoint(workflowId);
    const internalsA = getInternals(engineA);
    const realStorageA = internalsA.storage;
    internalsA.storage = new Proxy(realStorageA, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string) => {
            const value = await target.get(key);
            if (key === checkpointKey) {
              reached.resolve();
              await release.promise;
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
    const staleEpoch = registryA?.currentEpoch(workflowId) ?? null;
    expect(staleEpoch).not.toBeNull();

    // While the stale resume is paused: engineB terminalizes the workflow,
    // then a DIFFERENT path on engineA (a concurrent resume, or the
    // replacement run's own fold-acquire — simulated directly against the
    // registry here, mirroring how `recordFoldedAcquire` installs a fresh
    // entry, without dragging in `start-commit.ts`'s own separate fencing
    // behavior around an already-tracked-but-stale registry entry, which is
    // out of this finding's scope) legitimately re-acquires the claim,
    // REPLACING engineA's registry entry for `workflowId` with a new epoch —
    // superseding the stale resume's entry the paused call captured above.
    await engineB.cancel(workflowId);
    const replacementAcquire = await registryA?.acquire(workflowId);
    expect(replacementAcquire?.status).toBe('acquired');
    const replacementEpoch = registryA?.currentEpoch(workflowId) ?? null;
    expect(replacementEpoch).not.toBeNull();
    expect(replacementEpoch).not.toBe(staleEpoch);

    release.resolve();

    // The stale resume rejects — its own state, read before the cancel,
    // no longer matches what the serialized section observes.
    expect(await throwingRejectionOf(resumePromise)).toThrow(/status is "cancelled"/);

    // The regression: cleaning up the STALE resume's claim must not release
    // whatever is CURRENTLY tracked (the replacement's live claim) — it must
    // be conditioned on the exact generation the stale resume itself
    // acquired. The replacement's claim must survive untouched.
    expect(registryA?.currentEpoch(workflowId)).toBe(replacementEpoch);
    const holderBytes = await storage.get(KEYS.workflowOwnerHolder(workflowId));
    expect(holderBytes).not.toBeNull();
    expect(decodeWorkflowClaimHolder(holderBytes!)?.engineId).toBe('engine-a');

    // Proves the replacement's fenced writes still work: its exact epoch
    // bytes are still intact and renewable, not dropped by the stale
    // resume's cleanup.
    const renewResult = await registryA?.renew(workflowId);
    expect(renewResult?.status).toBe('renewed');
  });

  it('resume(): a thrown durable release still forgets the LOCAL entry so the renewal task does not renew a claim forever (workflow-claim-registry.ts, issue C)', async () => {
    const realStorage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    const workflowId = 'release-throws-forgets-local';

    await seedParkedWorkflow(realStorage, workflowId);
    // Corrupt the checkpoint so `performResumeAfterClaimAcquired` rejects
    // deterministically, AFTER the fresh claim acquire above it commits —
    // no interleaving needed, unlike issues A/B/D.
    await realStorage.delete(KEYS.checkpoint(workflowId));

    // Arm a transient storage failure on EXACTLY the release's own durable
    // delete of the holder key — the acquire above it is a PUT, so this
    // cannot fire early and mask the intended acquisition. Wrapped BEFORE
    // constructing the engine/registry (not swapped in after, like the
    // other tests in this file do): `WorkflowClaimRegistry` captures its own
    // `storage` reference at construction time, separate from
    // `EngineInternals.storage` — a proxy installed only on
    // `getInternals(engine).storage` afterward would never be seen by the
    // registry's own `storageConditionalBatch` calls.
    const holderKey = KEYS.workflowOwnerHolder(workflowId);
    const storage = new Proxy(realStorage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            if (operations.some((op) => op.type === 'delete' && op.key === holderKey)) {
              throw new Error('simulated transient storage failure during release');
            }
            return target.conditionalBatch(conditions, operations);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);
    const registryA = getInternals(engineA).workflowClaimRegistry;
    expect(registryA).not.toBeNull();

    expect(await throwingRejectionOf(engineA.resume(workflowId))).toThrow(/Checkpoint not found/);

    // The regression: `release()`'s durable CAS threw (simulated transient
    // failure, not a lost CAS), so the durable holder record is still
    // there — but the LOCAL entry must be forgotten anyway, or the renewal
    // task keeps renewing a claim nothing is driving, forever.
    expect(registryA?.currentEpoch(workflowId)).toBeNull();
    expect(registryA?.listHeldWorkflowIds()).not.toContain(workflowId);
    const holderBytes = await storage.get(holderKey);
    expect(holderBytes).not.toBeNull();
    expect(decodeWorkflowClaimHolder(holderBytes!)?.engineId).toBe('engine-a');
  });

  it("recoverAll(): the isolated checkpoint-decode failure's fenced failWorkflow commit still sees the freshly-acquired claim, and the claim is released only afterward (resume.ts, issue D)", async () => {
    const workflowId = 'recover-all-defers-claim-release';
    const workflows = {
      'checkpoint-decode-waiter': workflow({ name: 'checkpoint-decode-waiter' }).execute(
        async function* (ctx: WorkflowContext) {
          yield* ctx.waitForSignal('continue');
          return 'resumed';
        },
      ),
    };
    const storage = new MemoryStorage();

    {
      await using seedEngine = await Engine.create({ storage, workflows, recover: false });
      await seedEngine.start('checkpoint-decode-waiter', null, { id: workflowId });
      await waitForCondition(
        async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null,
        { label: `checkpoint for seeded workflow "${workflowId}"` },
      );
    }

    // Corrupt the checkpoint with an undecodable RegExp extension — the same
    // fixture `checkpoint-decode-recovery.test.ts` uses — so
    // `performResumeAfterClaimAcquired` throws `RegExpExtensionDecodeError`
    // AFTER `recoverAll()`'s per-entry resume freshly acquires this
    // workflow's claim.
    await storage.put(
      KEYS.checkpoint(workflowId),
      msgpackEncode({
        workflowId,
        step: 1,
        locals: {
          pattern: new ExtData(2, msgpackEncode({ source: 'hello', flags: 'z' })),
        },
        accumulatedResults: [],
        searchAttributes: {},
        version: '1.0.0',
        schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
        createdAt: 1_778_716_800_000,
      }),
    );

    // `createClaimEngine`'s `ClaimWorkflows` param type is scoped to this
    // file's two shared fixtures, so this one-off workflow is wired up the
    // same way `createClaimEngine` does internally instead of reusing it.
    await using engine = await Engine.create({
      storage,
      workflows,
      ownership: 'workflow-lease',
      workflowClaimTtl: '1m',
      workflowClaimRenewInterval: '5s',
      recover: false,
      backgroundTasks: 'manual',
    });
    installClaimRegistry(engine, 'engine-a', storage);
    const registry = getInternals(engine).workflowClaimRegistry;
    expect(registry).not.toBeNull();

    // Pre-fix regression: releasing the freshly-acquired claim BEFORE
    // `failWorkflowForCheckpointDecodeError`'s own fenced `failWorkflow()`
    // commit left `commitFencedEngineWrite` with no local epoch, so it threw
    // `EngineDeposedError` instead of committing the isolated failure —
    // aborting `recoverAll()` entirely rather than isolating just this run.
    const handles = await engine.recoverAll();

    // The isolation worked: no handle for the failed workflow, and
    // `recoverAll()` itself did not throw.
    expect(handles.map((handle) => handle.id)).toEqual([]);

    // The fenced `failWorkflowForCheckpointDecodeError` commit actually
    // landed — proving the claim was still installed when it ran.
    const summary = await engine.get(workflowId);
    expect(summary?.status).toBe('failed');
    expect(summary?.error).toContain('RegExp extension type 2');

    // The claim was released once the isolated-failure handling was done —
    // either by `failWorkflow()`'s own terminal-settlement release, or by
    // `recoverEntryOrIsolateFailure`'s deferred `finally` release as a
    // backstop; either way nothing is left stranded.
    expect(registry?.currentEpoch(workflowId)).toBeNull();
    expect(registry?.listHeldWorkflowIds()).not.toContain(workflowId);
  });
});

let staleEpochInvocation = 0;

/** A per-invocation suffix so `--rerun-each` repeats never reuse a workflow id. */
function nextInvocation(): number {
  staleEpochInvocation += 1;
  return staleEpochInvocation;
}

/** The durable `wf-owner-epoch` for `id`, decoded, or `null` when absent or undecodable. */
async function durableEpoch(storage: MemoryStorage, id: string): Promise<number | null> {
  const raw = await storage.get(KEYS.workflowOwnerEpoch(id));
  return raw === null ? null : decodeEpoch(raw);
}

/** The durable `wf-owner-holder` for `id`, decoded, or `null` when absent or undecodable. */
async function durableHolder(storage: MemoryStorage, id: string) {
  const raw = await storage.get(KEYS.workflowOwnerHolder(id));
  return raw === null ? null : decodeWorkflowClaimHolder(raw);
}

/** The durable `wf-gen` generation for `id`; an absent key is generation 0 (nothing purged yet). */
async function durableGeneration(storage: MemoryStorage, id: string): Promise<number | null> {
  const raw = await storage.get(GENERATION_KEYS.workflowGeneration(id));
  return raw === null ? 0 : decodeGeneration(raw);
}

/** The durable workflow record status for `id` as engine `engine` reports it. */
async function statusOf(
  engine: Awaited<ReturnType<typeof createClaimEngine>>,
  id: string,
): Promise<string | undefined> {
  const summary = await engine.get(id);
  return summary?.status;
}

/** The `status` of a registry `acquire` for `id`. */
async function acquireStatus(registry: WorkflowClaimRegistry, id: string): Promise<string> {
  const result = await registry.acquire(id);
  return result.status;
}

describe('start-new over a stale cached workflow claim epoch', () => {
  async function seedCancelledUnderStaleCache(id: string) {
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await seedParkedWorkflow(storage, id);
    const engineA = await createClaimEngine(storage, 'engine-a', workflows);
    const engineB = await createClaimEngine(storage, 'engine-b', workflows);
    const registryA = getInternals(engineA).workflowClaimRegistry!;
    const registryB = getInternals(engineB).workflowClaimRegistry!;
    expect(await acquireStatus(registryA, id)).toBe('acquired');
    await engineB.cancel(id);
    return { storage, engineA, engineB, registryA, registryB };
  }

  it('rotation false-positive: start-new re-acquires instead of throwing EngineDeposedError', async () => {
    const id = `stale-epoch-rotation-${nextInvocation()}`;
    const { storage, engineA, engineB, registryA } = await seedCancelledUnderStaleCache(id);
    await using _a = engineA;
    await using _b = engineB;

    expect(await statusOf(engineA, id)).toBe('cancelled');
    expect(registryA.currentEpoch(id)).toBe(1);
    expect(await durableEpoch(storage, id)).toBe(2);
    expect(await storage.get(KEYS.workflowOwnerEpoch(id))).not.toEqual(
      registryA.currentEpochBytes(id),
    );
    expect(await storage.get(KEYS.workflowOwnerHolder(id))).toBeNull();
    expect(await registryA.holderStatus(id)).toBeUndefined();

    const handle = await engineA.start('claim-race-recovery', null, {
      id,
      onTerminalConflict: 'start-new',
    });

    expect(registryA.currentEpoch(id)).toBe(3);
    expect(await durableEpoch(storage, id)).toBe(3);
    expect(await storage.get(KEYS.workflowOwnerEpoch(id))).toEqual(registryA.currentEpochBytes(id));
    const holder = await durableHolder(storage, id);
    expect(holder?.engineId).toBe('engine-a');
    expect(holder?.epoch).toBe(3);

    await engineA.signal(id, 'go');
    expect(await handle.result()).toBe('ran');
    expect(registryA.currentEpoch(id)).toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder(id))).toBeNull();
  });

  it('real deposition control: a live foreign holder still deposes the start-new', async () => {
    const id = `stale-epoch-foreign-${nextInvocation()}`;
    const { storage, engineA, engineB, registryA, registryB } =
      await seedCancelledUnderStaleCache(id);
    await using _a = engineA;
    await using _b = engineB;
    expect(await acquireStatus(registryB, id)).toBe('acquired');

    expect(registryA.currentEpoch(id)).toBe(1);
    expect(await durableEpoch(storage, id)).toBe(3);
    const status = await registryA.holderStatus(id);
    expect(status?.heldByAnyProcess).toBe(true);
    expect(status?.heldByThisProcess).toBe(false);

    const error = await rejectionOf(
      engineA.start('claim-race-recovery', null, { id, onTerminalConflict: 'start-new' }),
    );
    expect(error).toBeInstanceOf(EngineDeposedError);
    expect((error as EngineDeposedError).workflowId).toBe(id);

    const foreignHolder = await durableHolder(storage, id);
    expect(foreignHolder?.engineId).toBe('engine-b');
    expect(await statusOf(engineA, id)).toBe('cancelled');
  });

  it('release-inheritance: the old run’s delayed release must not strip the start-new replacement’s claim', async () => {
    const id = `stale-epoch-release-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);

    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = true;
    const holderKey = KEYS.workflowOwnerHolder(id);
    const gatedRegistryStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            if (armed && operations.some((op) => op.type === 'delete' && op.key === holderKey)) {
              armed = false;
              reached.resolve();
              await release.promise;
            }
            return target.conditionalBatch(conditions, operations);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const registryA = installClaimRegistry(engineA, 'engine-a', gatedRegistryStorage);

    await engineA.start('claim-race-recovery', null, { id });
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    expect(registryA.currentEpoch(id)).toBe(1);

    const oldRunSettled = Promise.withResolvers<void>();
    engineA.addEventListener('workflow:completed', (event) => {
      if ((event as Event & { workflowId?: string }).workflowId === id) oldRunSettled.resolve();
    });

    try {
      await engineA.signal(id, 'go');
      await reached.promise;

      expect(await statusOf(engineA, id)).toBe('completed');
      expect(registryA.currentEpoch(id)).toBe(1);
      const holderBefore = await durableHolder(storage, id);
      expect(holderBefore?.engineId).toBe('engine-a');
      expect(holderBefore?.epoch).toBe(1);
      expect(await storage.get(KEYS.workflowOwnerEpoch(id))).toEqual(
        registryA.currentEpochBytes(id),
      );
      expect(getInternals(engineA).parkedInlineWorkflows.has(id)).toBe(false);
      const generationBefore = await durableGeneration(storage, id);

      await engineA.start('claim-race-recovery', null, { id, onTerminalConflict: 'start-new' });
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

      expect(await statusOf(engineA, id)).toBe('running');
      expect(await durableGeneration(storage, id)).toBe((generationBefore ?? 0) + 1);
      // The fix may re-mint the epoch inside the create batch, so only the
      // presence of a claim (not its number) is pinned while the gate is shut.
      expect(registryA.currentEpoch(id)).not.toBeNull();
      expect(await storage.get(holderKey)).not.toBeNull();
      expect(getInternals(engineA).parkedInlineWorkflows.has(id)).toBe(true);
    } finally {
      release.resolve();
    }

    await oldRunSettled.promise;

    const epoch = registryA.currentEpoch(id);
    expect(epoch).not.toBeNull();
    const holderAfter = await durableHolder(storage, id);
    expect(holderAfter?.engineId).toBe('engine-a');
    expect(holderAfter?.epoch).toBe(epoch ?? -1);
    expect(await durableEpoch(storage, id)).toBe(epoch);
    expect(await statusOf(engineA, id)).toBe('running');
  });

  it('renewal in flight: a renewal that committed durably but has not updated the cache must not strip the start-new replacement’s claim', async () => {
    const id = `stale-epoch-renewal-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);

    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = false;
    const holderKey = KEYS.workflowOwnerHolder(id);
    const gatedRegistryStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            const isHolderPut = operations.some((op) => op.type === 'put' && op.key === holderKey);
            if (armed && isHolderPut) {
              armed = false;
              const committed = await target.conditionalBatch(conditions, operations);
              reached.resolve();
              await release.promise;
              return committed;
            }
            return target.conditionalBatch(conditions, operations);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let clock = 1_000_000;
    const registryA = new WorkflowClaimRegistry({
      storage: gatedRegistryStorage,
      engineId: 'engine-a',
      getNow: () => clock,
      claimTtlMs: 60_000,
      claimRenewIntervalMs: 5_000,
    });
    const releaseCalled = Promise.withResolvers<void>();
    const originalRelease = registryA.release.bind(registryA);
    registryA.release = (workflowId, epoch) => {
      if (workflowId === id) releaseCalled.resolve();
      return originalRelease(workflowId, epoch);
    };
    getInternals(engineA).workflowClaimRegistry = registryA;

    await engineA.start('claim-race-recovery', null, { id });
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    expect(registryA.currentEpoch(id)).toBe(1);
    const cachedHolderBefore = registryA.currentHolderBytes(id);

    const oldRunSettled = Promise.withResolvers<void>();
    engineA.addEventListener('workflow:completed', (event) => {
      if ((event as Event & { workflowId?: string }).workflowId === id) oldRunSettled.resolve();
    });

    armed = true;
    clock += 1_000;
    const renewal = registryA.renew(id);
    try {
      await reached.promise;
      // The renewal committed durably, but the cache still holds the old bytes.
      expect(registryA.currentHolderBytes(id)).toEqual(cachedHolderBefore);
      expect(await storage.get(holderKey)).not.toEqual(cachedHolderBefore);

      await engineA.signal(id, 'go');
      // release() runs only after the self-complete terminal commit, and then blocks on the gated
      // renewal, so this is a race-free point at which the old run is terminal.
      await releaseCalled.promise;
      expect(await statusOf(engineA, id)).toBe('completed');
      const generationBefore = await durableGeneration(storage, id);

      await engineA.start('claim-race-recovery', null, { id, onTerminalConflict: 'start-new' });
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

      expect(await durableGeneration(storage, id)).toBe((generationBefore ?? 0) + 1);
      expect(await statusOf(engineA, id)).toBe('running');
      expect(registryA.currentEpoch(id)).not.toBeNull();
    } finally {
      release.resolve();
    }

    await renewal;
    await oldRunSettled.promise;

    const epoch = registryA.currentEpoch(id);
    expect(epoch).not.toBeNull();
    const holderAfter = await durableHolder(storage, id);
    expect(holderAfter?.engineId).toBe('engine-a');
    expect(holderAfter?.epoch).toBe(epoch ?? -1);
    expect(await durableEpoch(storage, id)).toBe(epoch);
    expect(await statusOf(engineA, id)).toBe('running');
  });
});

describe('COR-1383: an old run terminal in-memory teardown must not wipe a same-id start-new replacement', () => {
  it('gated release: the replacement parked before the old run settles is still woken live by signal', async () => {
    const id = `terminal-teardown-gated-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);

    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = true;
    const holderKey = KEYS.workflowOwnerHolder(id);
    const gatedRegistryStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            if (armed && operations.some((op) => op.type === 'delete' && op.key === holderKey)) {
              armed = false;
              reached.resolve();
              await release.promise;
            }
            return target.conditionalBatch(conditions, operations);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    installClaimRegistry(engineA, 'engine-a', gatedRegistryStorage);

    await engineA.start('claim-race-recovery', null, { id });
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

    const oldRunSettled = Promise.withResolvers<void>();
    engineA.addEventListener('workflow:completed', (event) => {
      if ((event as Event & { workflowId?: string }).workflowId === id) oldRunSettled.resolve();
    });

    let replacement: Awaited<ReturnType<typeof engineA.start>>;
    try {
      await engineA.signal(id, 'go');
      await reached.promise;
      expect(await statusOf(engineA, id)).toBe('completed');

      replacement = await engineA.start('claim-race-recovery', null, {
        id,
        onTerminalConflict: 'start-new',
        executionTimeout: '1h',
      });
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      expect(getInternals(engineA).parkedInlineWorkflows.has(id)).toBe(true);
      expect(await storage.get(`timer-idx:deadline:${id}`)).not.toBeNull();
    } finally {
      release.resolve();
    }

    await oldRunSettled.promise;
    // The old run's teardown must not cancel the replacement's execution deadline.
    expect(await storage.get(`timer-idx:deadline:${id}`)).not.toBeNull();

    // The old run's teardown has now run; the replacement's park state must survive it.
    expect(getInternals(engineA).parkedInlineWorkflows.has(id)).toBe(true);
    expect(getInternals(engineA).checkpoints.has(id)).toBe(true);
    await engineA.signal(id, 'go');
    expect(await replacement.result()).toBe('ran');
  });

  it('ungated: a start-new issued the instant the old run reads as terminal keeps its parked state', async () => {
    const id = `terminal-teardown-ungated-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const workflows: ClaimWorkflows = { 'claim-race-recovery': claimRaceRecoveryWorkflow };
    await using engineA = await createClaimEngine(storage, 'engine-a', workflows);
    installClaimRegistry(engineA, 'engine-a', storage);

    await engineA.start('claim-race-recovery', null, { id });
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

    const oldRunSettled = Promise.withResolvers<void>();
    engineA.addEventListener('workflow:completed', (event) => {
      if ((event as Event & { workflowId?: string }).workflowId === id) oldRunSettled.resolve();
    });

    await engineA.signal(id, 'go');
    while ((await statusOf(engineA, id)) !== 'completed') await Bun.sleep(0);
    const replacement = await engineA.start('claim-race-recovery', null, {
      id,
      onTerminalConflict: 'start-new',
    });
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    await oldRunSettled.promise;

    await engineA.signal(id, 'go');
    expect(await replacement.result()).toBe('ran');
  });

  it('gated release on both runs: a replacement that already completed keeps its own result and handle', async () => {
    const id = `terminal-teardown-both-gated-${nextInvocation()}`;
    const storage = new MemoryStorage();
    await using engineA = await Engine.create({
      storage,
      workflows: { 'claim-race-echo': claimRaceEchoWorkflow },
      ownership: 'workflow-lease',
      workflowClaimTtl: '1m',
      workflowClaimRenewInterval: '5s',
      recover: false,
      backgroundTasks: 'manual',
    });

    const holderKey = KEYS.workflowOwnerHolder(id);
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const reached = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let releasesSeen = 0;
    const gatedRegistryStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            if (operations.some((op) => op.type === 'delete' && op.key === holderKey)) {
              const index = releasesSeen++;
              const gate = gates[index];
              if (gate) {
                reached[index]?.resolve();
                await gate.promise;
              }
            }
            return target.conditionalBatch(conditions, operations);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    installClaimRegistry(engineA, 'engine-a', gatedRegistryStorage);

    await engineA.start('claim-race-echo', 'OLD', { id });
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

    let replacementTerminalEvents = 0;
    let replacement: Awaited<ReturnType<typeof engineA.start>>;
    await engineA.signal(id, 'go');
    await reached[0]!.promise;

    replacement = await engineA.start('claim-race-echo', 'NEW', {
      id,
      onTerminalConflict: 'start-new',
    });
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    replacement.addEventListener('workflow:completed', () => {
      replacementTerminalEvents++;
    });
    const replacementResult = replacement.result();

    // The replacement commits `completed` while its own claim release is still gated.
    await engineA.signal(id, 'go');
    await reached[1]!.promise;
    const committed = await engineA.get(id);
    expect(committed?.status).toBe('completed');
    expect(replacementTerminalEvents).toBe(0);

    // Open the old run's gate: it must recognize the replacement by run identity, not status.
    const oldRunSettled = Promise.withResolvers<void>();
    engineA.addEventListener('workflow:completed', (event) => {
      if ((event as Event & { workflowId?: string }).workflowId === id) oldRunSettled.resolve();
    });
    gates[0]!.resolve();
    await oldRunSettled.promise;

    // Neither the old run's result nor its terminal event may reach the replacement.
    expect(replacementTerminalEvents).toBe(0);
    gates[1]!.resolve();
    expect(await replacementResult).toBe('NEW');
    await waitForCondition(async () => replacementTerminalEvents === 1, {
      label: 'replacement own completion event',
    });
  });

  /** Gate engine A's claim release, which runs after the terminal commit and before teardown. */
  async function createGatedCrossEngine(id: string) {
    const storage = new MemoryStorage();
    const workflows = { 'claim-race-echo': claimRaceEchoWorkflow };
    const engineA = await Engine.create({
      storage,
      workflows,
      ownership: 'workflow-lease',
      workflowClaimTtl: '1m',
      workflowClaimRenewInterval: '5s',
      recover: false,
      backgroundTasks: 'manual',
    });
    const engineB = await Engine.create({ storage, workflows, recover: false });
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holderKey = KEYS.workflowOwnerHolder(id);
    let armed = true;
    const gated = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            if (armed && operations.some((op) => op.type === 'delete' && op.key === holderKey)) {
              armed = false;
              reached.resolve();
              await release.promise;
            }
            return target.conditionalBatch(conditions, operations);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    installClaimRegistry(engineA, 'engine-a', gated);
    return { storage, engineA, engineB, reached, release };
  }

  it('cross-engine: a start-new on another engine does not stop the old run engine cleaning up and settling its waiter', async () => {
    const id = `terminal-teardown-cross-${nextInvocation()}`;
    const { engineA, engineB, reached, release } = await createGatedCrossEngine(id);
    try {
      const handleA = await engineA.start('claim-race-echo', 'OLD', { id });
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      const oldResult = handleA.result();
      await engineA.signal(id, 'go');
      await reached.promise;

      await engineB.start('claim-race-echo', 'NEW', { id, onTerminalConflict: 'start-new' });
      release.resolve();

      expect(await Promise.race([oldResult, Bun.sleep(1000).then(() => 'TIMEOUT')])).toBe('OLD');
      const internals = getInternals(engineA);
      expect(internals.checkpoints.has(id)).toBe(false);
      expect(internals.resultResolvers.has(id)).toBe(false);
      expect(internals.workflowTypeByWorkflowId.has(id)).toBe(false);
    } finally {
      release.resolve();
      await engineB[Symbol.asyncDispose]();
      await engineA[Symbol.asyncDispose]();
    }
  });

  /** Parks on a signal, then throws for the `fail` input and returns `ran` for any other, so an old run can fail while its same-id replacement completes. */
  const failOrRunWorkflow = workflow({ name: 'claim-race-fail-or-run' }).execute(async function* (
    ctx: WorkflowContext,
    input: string,
  ) {
    yield* ctx.waitForSignal('go');
    if (input === 'fail') throw new Error('old run failed');
    return 'ran';
  });

  /** Gate the first claim release on engine A; returns the gate handles. */
  async function createGatedSingleEngine(id: string) {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { 'claim-race-fail-or-run': failOrRunWorkflow },
      ownership: 'workflow-lease',
      workflowClaimTtl: '1m',
      workflowClaimRenewInterval: '5s',
      recover: false,
      backgroundTasks: 'manual',
    });
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holderKey = KEYS.workflowOwnerHolder(id);
    let armed = true;
    const gated = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            if (armed && operations.some((op) => op.type === 'delete' && op.key === holderKey)) {
              armed = false;
              reached.resolve();
              await release.promise;
            }
            return target.conditionalBatch(conditions, operations);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    installClaimRegistry(engine, 'engine-a', gated);
    return { storage, engine, reached, release };
  }

  it('failed old run: a start-new replacement parked during the gated release survives the fail teardown', async () => {
    const id = `terminal-teardown-failed-${nextInvocation()}`;
    const { engine, reached, release } = await createGatedSingleEngine(id);
    try {
      const oldHandle = await engine.start('claim-race-fail-or-run', 'fail', { id });
      void oldHandle.result().catch(() => undefined);
      await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      const oldRunSettled = Promise.withResolvers<void>();
      engine.addEventListener('workflow:failed', (event) => {
        if ((event as Event & { workflowId?: string }).workflowId === id) oldRunSettled.resolve();
      });

      await engine.signal(id, 'go');
      await reached.promise;
      const committed = await engine.get(id);
      expect(committed?.status).toBe('failed');

      const replacement = await engine.start('claim-race-fail-or-run', 'ok', {
        id,
        onTerminalConflict: 'start-new',
      });
      await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      expect(getInternals(engine).parkedInlineWorkflows.has(id)).toBe(true);
      release.resolve();
      await oldRunSettled.promise;

      expect(getInternals(engine).parkedInlineWorkflows.has(id)).toBe(true);
      await engine.signal(id, 'go');
      expect(
        await Promise.race([replacement.result(), Bun.sleep(1000).then(() => 'TIMEOUT')]),
      ).toBe('ran');
    } finally {
      release.resolve();
      await engine[Symbol.asyncDispose]();
    }
  });

  it('cancelled old run: a start-new replacement parked during the gated release survives the cancel teardown', async () => {
    const id = `terminal-teardown-cancelled-${nextInvocation()}`;
    const { engine, reached, release } = await createGatedSingleEngine(id);
    try {
      const oldHandle = await engine.start('claim-race-fail-or-run', 'ok', { id });
      void oldHandle.result().catch(() => undefined);
      await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      const oldRunSettled = Promise.withResolvers<void>();
      engine.addEventListener('workflow:cancelled', (event) => {
        if ((event as Event & { workflowId?: string }).workflowId === id) oldRunSettled.resolve();
      });

      const cancelled = engine.cancel(id);
      await reached.promise;
      const committed = await engine.get(id);
      expect(committed?.status).toBe('cancelled');

      const replacement = await engine.start('claim-race-fail-or-run', 'ok', {
        id,
        onTerminalConflict: 'start-new',
      });
      await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      expect(getInternals(engine).parkedInlineWorkflows.has(id)).toBe(true);
      release.resolve();
      await cancelled;
      await oldRunSettled.promise;

      expect(getInternals(engine).parkedInlineWorkflows.has(id)).toBe(true);
      await engine.signal(id, 'go');
      expect(
        await Promise.race([replacement.result(), Bun.sleep(1000).then(() => 'TIMEOUT')]),
      ).toBe('ran');
    } finally {
      release.resolve();
      await engine[Symbol.asyncDispose]();
    }
  });

  it('a transient storage read failure after the terminal commit does not drop terminal delivery', async () => {
    const id = `terminal-teardown-readfail-${nextInvocation()}`;
    const { storage, engineA, engineB, reached, release } = await createGatedCrossEngine(id);
    try {
      const handleA = await engineA.start('claim-race-echo', 'OLD', { id });
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      const oldResult = handleA.result();
      await engineA.signal(id, 'go');
      await reached.promise;

      const originalGet = storage.get.bind(storage);
      storage.get = async (key: string) => {
        if (key === KEYS.workflow(id)) throw new Error('transient storage failure');
        return originalGet(key);
      };
      release.resolve();
      try {
        expect(await Promise.race([oldResult, Bun.sleep(1000).then(() => 'TIMEOUT')])).toBe('OLD');
      } finally {
        storage.get = originalGet;
      }
      expect(getInternals(engineA).checkpoints.has(id)).toBe(false);
    } finally {
      await engineB[Symbol.asyncDispose]();
      await engineA[Symbol.asyncDispose]();
    }
  });
});

describe('COR-1384: an old run durable terminal teardown must not touch a same-id start-new replacement', () => {
  const TYPE = 'teardown-durable';
  /** Input is `partition:behavior`; the partition names the concurrency slot, the behavior is `fail` or anything else. */
  const teardownWorkflow = workflow({
    name: TYPE,
    concurrency: { max: 1, key: (input) => (input as string).split(':')[0]! },
  })
    .searchAttributes({ tag: { type: 'string' } })
    .execute(async function* (ctx: WorkflowContext, input: string) {
      yield* ctx.waitForSignal('go');
      if (input.endsWith(':fail')) throw new Error('old run failed');
      return input;
    });

  const expectedStatus = { fail: 'failed', cancel: 'cancelled', complete: 'completed' } as const;

  type Gate = { reached: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> };
  const newGate = (): Gate => ({
    reached: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  });

  /**
   * Wrap `storage` so the first `conditionalBatch`/`batch` that satisfies `matches` parks on `gate`
   * before it runs: the old run is then frozen between its terminal commit and one durable teardown write.
   */
  function gateFirstWrite(
    storage: MemoryStorage,
    gate: Gate,
    matches: (operations: BatchOperation[]) => boolean,
  ): MemoryStorage {
    let armed = true;
    const park = async (operations: BatchOperation[]) => {
      if (armed && matches(operations)) {
        armed = false;
        gate.reached.resolve();
        await gate.release.promise;
      }
    };
    return new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            await park(operations);
            return target.conditionalBatch(conditions, operations);
          };
        }
        if (property === 'batch') {
          return async (operations: BatchOperation[]) => {
            await park(operations);
            return target.batch(operations);
          };
        }
        if (property === 'deletePrefix' && target.deletePrefix) {
          return async (prefix: string) => {
            await park([{ type: 'delete', key: prefix }]);
            return target.deletePrefix(prefix);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  const deletes = (key: string) => (operations: BatchOperation[]) =>
    operations.some((operation) => operation.type === 'delete' && operation.key === key);

  const slotHolders = async (storage: MemoryStorage, partition: string): Promise<string[]> => {
    const bytes = await storage.get(KEYS.workflowConcurrency(TYPE, partition));
    if (bytes === null) return [];
    return (decode(bytes) as { holders: { holderId: string }[] }).holders.map((h) => h.holderId);
  };

  async function createEngine(storage: MemoryStorage) {
    return Engine.create({ storage, workflows: { [TYPE]: teardownWorkflow }, recover: false });
  }

  /** Park the old run, then commit its terminal state and freeze it at `gate`. */
  async function terminateOldRun(
    engine: Awaited<ReturnType<typeof createEngine>>,
    id: string,
    mode: 'fail' | 'cancel' | 'complete',
    gate: Gate,
  ) {
    const old = await engine.start(TYPE, mode === 'fail' ? 'P1:fail' : 'P1:OLD', {
      id,
      searchAttributes: { tag: 'old' },
    });
    void old.result().catch(() => undefined);
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    let oldDone: Promise<unknown>;
    if (mode === 'cancel') {
      oldDone = engine.cancel(id);
    } else {
      const event = mode === 'fail' ? 'workflow:failed' : 'workflow:completed';
      oldDone = new Promise<void>((resolve) =>
        engine.addEventListener(event, () => resolve(), { once: true }),
      );
      await engine.signal(id, 'go');
    }
    await gate.reached.promise;
    const committed = await engine.get(id);
    expect(committed?.status).toBe(expectedStatus[mode]);
    return oldDone;
  }

  async function expectReplacementIntact(
    storage: MemoryStorage,
    engine: Awaited<ReturnType<typeof createEngine>>,
    id: string,
    replacement: Awaited<ReturnType<Awaited<ReturnType<typeof createEngine>>['start']>>,
    partition: string,
  ) {
    expect(await engine.getAttributes(id)).toEqual({ tag: 'new' });
    expect(await slotHolders(storage, partition)).toEqual([id]);
    expect(await storage.get(KEYS.workflowConcurrencyHolder(id))).not.toBeNull();
    await engine.signal(id, 'go');
    expect(await replacement.result()).toBe(`${partition}:NEW`);
    await waitForCondition(
      async () => {
        const holders = await slotHolders(storage, partition);
        return holders.length === 0;
      },
      { label: 'replacement releases its own slot' },
    );
  }

  for (const mode of ['fail', 'cancel', 'complete'] as const) {
    it(`${mode}: a same-engine replacement landed before teardown keeps its attributes, slot and marker`, async () => {
      const id = `teardown-durable-${mode}-${nextInvocation()}`;
      const storage = new MemoryStorage();
      const gate = newGate();
      await using engine = await createEngine(
        gateFirstWrite(storage, gate, deletes(KEYS.workflowConcurrencyHolder(id))),
      );
      try {
        const oldDone = terminateOldRun(engine, id, mode, gate);
        await gate.reached.promise;
        const replacement = await engine.start(TYPE, 'P1:NEW', {
          id,
          onTerminalConflict: 'start-new',
          searchAttributes: { tag: 'new' },
        });
        await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
        gate.release.resolve();
        await oldDone;
        await Bun.sleep(50);
        await expectReplacementIntact(storage, engine, id, replacement, 'P1');
      } finally {
        gate.release.resolve();
      }
    });
  }

  it('cross-engine: a replacement started on another engine survives the old engine teardown', async () => {
    const id = `teardown-durable-cross-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    await using engineA = await createEngine(
      gateFirstWrite(storage, gate, deletes(KEYS.workflowConcurrencyHolder(id))),
    );
    await using engineB = await createEngine(storage);
    try {
      const oldDone = terminateOldRun(engineA, id, 'fail', gate);
      await gate.reached.promise;
      const replacement = await engineB.start(TYPE, 'P1:NEW', {
        id,
        onTerminalConflict: 'start-new',
        searchAttributes: { tag: 'new' },
      });
      await engineB[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      gate.release.resolve();
      await oldDone;
      await Bun.sleep(50);
      await expectReplacementIntact(storage, engineB, id, replacement, 'P1');
    } finally {
      gate.release.resolve();
    }
  });

  it('cross-engine: scratch keys under a swept prefix survive the old engine cleanup', async () => {
    const id = `teardown-durable-prefix-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    // Park the old run at its guarded sweep chunk, after the listing but before the delete.
    await using engineA = await createEngine(
      gateFirstWrite(storage, gate, deletes(KEYS.workflowHeaders(id))),
    );
    await using engineB = await createEngine(storage);
    try {
      const oldDone = terminateOldRun(engineA, id, 'fail', gate);
      await gate.reached.promise;
      const replacement = await engineB.start(TYPE, 'P1:NEW', {
        id,
        onTerminalConflict: 'start-new',
        searchAttributes: { tag: 'new' },
      });
      await engineB[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      // A signal the replacement has not consumed is durable scratch state under `sig:`.
      await engineB.signal(id, 'buffered', 'kept');
      const scratchKeys = async (): Promise<string[]> => {
        const keys: string[] = [];
        for await (const [key] of storage.scan('sig:')) keys.push(key);
        return keys;
      };
      const before = await scratchKeys();
      expect(before.length).toBeGreaterThan(0);

      gate.release.resolve();
      await oldDone;
      await Bun.sleep(50);

      expect(await scratchKeys()).toEqual(before);
      await expectReplacementIntact(storage, engineB, id, replacement, 'P1');
    } finally {
      gate.release.resolve();
    }
  });

  it('cross-engine: review entries of a replacement survive the old engine review cleanup', async () => {
    const id = `teardown-durable-review-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    const reviewKey = (reviewId: string) => KEYS.review(id, reviewId);
    const reviewPrefix = KEYS.review(id, '');
    // Park the old run at its first review delete, listing already done (or unfenced prefix delete).
    await using engineA = await createEngine(
      gateFirstWrite(storage, gate, (operations) =>
        operations.some(
          (operation) => operation.type === 'delete' && operation.key.startsWith(reviewPrefix),
        ),
      ),
    );
    await using engineB = await createEngine(storage);
    try {
      await storage.put(reviewKey('old'), new Uint8Array([1]));
      const oldDone = terminateOldRun(engineA, id, 'fail', gate);
      await gate.reached.promise;
      const replacement = await engineB.start(TYPE, 'P1:NEW', {
        id,
        onTerminalConflict: 'start-new',
        searchAttributes: { tag: 'new' },
      });
      await engineB[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      // The replacement's pending review, written after the old run listed its own.
      await storage.put(reviewKey('new'), new Uint8Array([2]));

      gate.release.resolve();
      await oldDone;
      await Bun.sleep(50);

      expect(await storage.get(reviewKey('new'))).not.toBeNull();
      await expectReplacementIntact(storage, engineB, id, replacement, 'P1');
    } finally {
      gate.release.resolve();
    }
  });

  it('a tag edit by the same run between commit and teardown still releases its slot and marker', async () => {
    const id = `teardown-durable-tagedit-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    await using engine = await createEngine(
      gateFirstWrite(storage, gate, deletes(KEYS.workflowConcurrencyHolder(id))),
    );
    try {
      const oldDone = terminateOldRun(engine, id, 'cancel', gate);
      await gate.reached.promise;
      // Rewrites the terminal workflow record without reusing the id.
      await engine.addTags(id, 'edited');
      gate.release.resolve();
      await oldDone;
      await Bun.sleep(50);

      expect(await slotHolders(storage, 'P1')).toEqual([]);
      expect(await storage.get(KEYS.workflowConcurrencyHolder(id))).toBeNull();
    } finally {
      gate.release.resolve();
    }
  });

  it('a replacement committed on another engine is not mistaken for the run by a late generation read', async () => {
    const id = `teardown-durable-lateread-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    const readRelease = Promise.withResolvers<void>();
    let delayGenerationReads = false;
    const gated = gateFirstWrite(storage, gate, deletes(KEYS.workflowConcurrencyHolder(id)));
    // Any read of the id's generation after the run starts returns only once the test lets it,
    // by which time the other engine's replacement has already bumped it.
    const delayed = new Proxy(gated, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string) => {
            if (delayGenerationReads && key === KEYS.workflowGeneration(id)) {
              await readRelease.promise;
            }
            return target.get(key);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await using engineA = await createEngine(delayed);
    await using engineB = await createEngine(storage);
    try {
      const old = await engineA.start(TYPE, 'P1:OLD', { id, searchAttributes: { tag: 'old' } });
      void old.result().catch(() => undefined);
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      delayGenerationReads = true;
      const oldDone = engineA.cancel(id);
      await waitForCondition(
        async () => {
          const state = await engineB.get(id);
          return state?.status === 'cancelled';
        },
        {
          label: 'old run committed its terminal state',
        },
      );

      const replacement = await engineB.start(TYPE, 'P1:NEW', {
        id,
        onTerminalConflict: 'start-new',
        searchAttributes: { tag: 'new' },
      });
      await engineB[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

      readRelease.resolve();
      await gate.reached.promise;
      gate.release.resolve();
      await oldDone;
      await Bun.sleep(50);

      await expectReplacementIntact(storage, engineB, id, replacement, 'P1');
    } finally {
      readRelease.resolve();
      gate.release.resolve();
    }
  });

  it('a replacement moving the id to another partition while the classification reads are in flight still frees the old partition', async () => {
    const id = `teardown-durable-classify-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    const generationHold = newGate();
    let holdingGenerationReads = false;
    const gated = gateFirstWrite(storage, gate, deletes(KEYS.workflowConcurrencyHolder(id)));
    const held = new Proxy(gated, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string) => {
            if (holdingGenerationReads && key === KEYS.workflowGeneration(id)) {
              generationHold.reached.resolve();
              await generationHold.release.promise;
            }
            return target.get(key);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await using engineA = await createEngine(held);
    await using engineB = await createEngine(storage);
    try {
      const oldDone = terminateOldRun(engineA, id, 'cancel', gate);
      await gate.reached.promise;
      // Move the slot's version so the release batch loses its condition and has to classify.
      const slotKey = KEYS.workflowConcurrency(TYPE, 'P1');
      const versionKey = `${slotKey}:version`;
      const version = decode((await storage.get(versionKey))!) as number;
      await storage.put(versionKey, encode(version + 1));
      holdingGenerationReads = true;
      gate.release.resolve();
      await generationHold.reached.promise;

      // The replacement lands in another partition while the classification read is in flight.
      const replacement = await engineB.start(TYPE, 'P2:NEW', {
        id,
        onTerminalConflict: 'start-new',
        searchAttributes: { tag: 'new' },
      });
      await engineB[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      holdingGenerationReads = false;
      generationHold.release.resolve();
      await oldDone;
      await Bun.sleep(50);

      expect(await slotHolders(storage, 'P1')).toEqual([]);
      await expectReplacementIntact(storage, engineB, id, replacement, 'P2');
    } finally {
      generationHold.release.resolve();
      gate.release.resolve();
    }
  });

  it('cross-engine: the old run teardown does not cancel the deadline timer of a replacement', async () => {
    const id = `teardown-durable-deadline-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    await using engineA = await createEngine(
      gateFirstWrite(storage, gate, deletes(KEYS.workflowConcurrencyHolder(id))),
    );
    await using engineB = await createEngine(storage);
    try {
      const old = await engineA.start(TYPE, 'P1:OLD', { id, executionTimeout: '1h' });
      void old.result().catch(() => undefined);
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      const oldDone = engineA.cancel(id);
      await gate.reached.promise;
      const replacement = await engineB.start(TYPE, 'P1:NEW', {
        id,
        onTerminalConflict: 'start-new',
        executionTimeout: '1h',
        searchAttributes: { tag: 'new' },
      });
      await engineB[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      expect(await storage.get(`timer-idx:deadline:${id}`)).not.toBeNull();

      gate.release.resolve();
      await oldDone;
      await Bun.sleep(50);

      // The old engine's id-keyed cancel must not delete the replacement's execution deadline.
      expect(await storage.get(`timer-idx:deadline:${id}`)).not.toBeNull();
      await expectReplacementIntact(storage, engineB, id, replacement, 'P1');
    } finally {
      gate.release.resolve();
    }
  });

  it('the deferred terminal cleanup of an old run does not sweep the scratch keys of a replacement that lands mid-cleanup', async () => {
    const id = `teardown-durable-deferred-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    await using engineA = await createEngine(
      gateFirstWrite(storage, gate, (operations) =>
        operations.some(
          (operation) =>
            operation.type === 'delete' &&
            (operation.key === KEYS.workflowHeaders(id) ||
              operation.key === `sig:${encodeStorageKeyComponent(id)}:`),
        ),
      ),
    );
    await using engineB = await createEngine(storage);
    try {
      const old = await engineA.start(TYPE, 'P1:OLD', { id });
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      await engineA.signal(id, 'go');
      await old.result();
      await waitForCondition(
        async () => {
          const holders = await slotHolders(storage, 'P1');
          return holders.length === 0;
        },
        {
          label: 'old run teardown finished',
        },
      );

      // Fire the old run's persisted terminal-cleanup timer and freeze it at its first sweep write.
      const ticking = getInternals(engineA).scheduler.tick(
        Date.now() + TERMINAL_CLEANUP_DELAY_MS + 60_000,
      );
      await gate.reached.promise;
      const replacement = await engineB.start(TYPE, 'P1:NEW', {
        id,
        onTerminalConflict: 'start-new',
        searchAttributes: { tag: 'new' },
      });
      await engineB[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      await engineB.signal(id, 'buffered', 'kept');
      const scratchKeys = async (): Promise<string[]> => {
        const keys: string[] = [];
        for await (const [key] of storage.scan('sig:')) keys.push(key);
        return keys;
      };
      const before = await scratchKeys();
      expect(before.length).toBeGreaterThan(0);

      gate.release.resolve();
      await ticking;
      await Bun.sleep(50);

      expect(await scratchKeys()).toEqual(before);
      await expectReplacementIntact(storage, engineB, id, replacement, 'P1');
    } finally {
      gate.release.resolve();
    }
  });

  it('a remote cancel that loaded the running state does not overwrite a run that completed and was replaced before its commit', async () => {
    const id = `teardown-durable-remotecancel-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    const writesWorkflowState = (operations: BatchOperation[]) =>
      operations.some(
        (operation) => operation.type === 'put' && operation.key === KEYS.workflow(id),
      );
    await using engineA = await createEngine(storage);
    await using engineB = await createEngine(gateFirstWrite(storage, gate, writesWorkflowState));
    try {
      const old = await engineA.start(TYPE, 'P1:OLD', { id, searchAttributes: { tag: 'old' } });
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

      // The canceller loads the running state and freezes just before it commits.
      const cancelled = engineB.cancel(id);
      await gate.reached.promise;

      // Meanwhile the run completes and a start-new replaces it.
      await engineA.signal(id, 'go');
      expect(await old.result()).toBe('P1:OLD');
      await waitForCondition(
        async () => {
          const holders = await slotHolders(storage, 'P1');
          return holders.length === 0;
        },
        { label: 'old run teardown finished' },
      );
      const replacement = await engineA.start(TYPE, 'P1:NEW', {
        id,
        onTerminalConflict: 'start-new',
        searchAttributes: { tag: 'new' },
      });
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

      gate.release.resolve();
      await cancelled;
      await Bun.sleep(50);

      // The cancel meant the old run; the replacement is untouched and still running.
      const state = await engineA.get(id);
      expect(state?.status).toBe('running');
      await expectReplacementIntact(storage, engineA, id, replacement, 'P1');
    } finally {
      gate.release.resolve();
    }
  });

  /** B cancels a run A holds; `beforeCancelWrite` runs on each cancel commit attempt, just before it. */
  async function cancelWithInterference(
    id: string,
    beforeCancelWrite: (
      attempt: number,
      engineA: Awaited<ReturnType<typeof createEngine>>,
    ) => Promise<void>,
  ) {
    const storage = new MemoryStorage();
    const engineA = await createEngine(storage);
    let attempts = 0;
    const racing = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            const cancelling = operations.some(
              (operation) =>
                operation.type === 'put' &&
                operation.key === KEYS.workflow(id) &&
                (decode(operation.value) as { status?: string }).status === 'cancelled',
            );
            if (cancelling) {
              attempts += 1;
              await beforeCancelWrite(attempts, engineA);
            }
            return target.conditionalBatch(conditions, operations);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const engineB = await createEngine(racing);
    const old = await engineA.start(TYPE, 'P1:OLD', { id });
    void old.result().catch(() => undefined);
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    return { storage, engineA, engineB, attempts: () => attempts };
  }

  it('a remote cancel still commits when many concurrent tag edits race it', async () => {
    const id = `teardown-durable-tagstorm-${nextInvocation()}`;
    const { storage, engineA, engineB } = await cancelWithInterference(id, async () => {});
    try {
      // Fourteen edits genuinely in flight against the cancel; jittered backoff lets it through.
      const edits = Array.from({ length: 14 }, (_, index) =>
        engineA.addTags(id, `edit-${String(index)}`),
      );
      await Promise.all([engineB.cancel(id), ...edits]);

      const state = await engineA.get(id);
      expect(state?.status).toBe('cancelled');
      expect(await slotHolders(storage, 'P1')).toEqual([]);
      expect(await storage.get(KEYS.workflowConcurrencyHolder(id))).toBeNull();
    } finally {
      await engineB[Symbol.asyncDispose]();
      await engineA[Symbol.asyncDispose]();
    }
  });

  it('a spent retry budget rethrows to the caller, who can cancel again once the interference stops', async () => {
    const id = `teardown-durable-exhausted-${nextInvocation()}`;
    const { storage, engineA, engineB, attempts } = await cancelWithInterference(
      id,
      async (_attempt, engine) => {
        if (attempts() <= 10) await engine.addTags(id, `edit-${String(attempts())}`);
      },
    );
    try {
      // Every attempt of the first cancel is beaten, so it throws after its budget.
      const failure = await rejectionOf(engineB.cancel(id));
      expect(String(failure)).toContain('lost a commit precondition');
      expect(attempts()).toBe(10);
      const stillRunning = await engineA.get(id);
      expect(stillRunning?.status).toBe('running');

      // The error reached the caller, and a second cancel commits.
      await engineB.cancel(id);
      const nowCancelled = await engineA.get(id);
      expect(nowCancelled?.status).toBe('cancelled');
      expect(await slotHolders(storage, 'P1')).toEqual([]);
    } finally {
      await engineB[Symbol.asyncDispose]();
      await engineA[Symbol.asyncDispose]();
    }
  });

  it("a same-run completion that lands before the cancel's final commit survives it", async () => {
    const id = `teardown-durable-lastcommit-${nextInvocation()}`;
    const { storage, engineA, engineB } = await cancelWithInterference(
      id,
      async (attempt, engine) => {
        if (attempt < 10) {
          await engine.addTags(id, `edit-${String(attempt)}`);
          return;
        }
        // The final attempt: the run completes just before the cancel's commit.
        await engine.signal(id, 'go');
        await waitForCondition(
          async () => {
            const state = await engine.get(id);
            return state?.status === 'completed';
          },
          { label: 'completion landed' },
        );
      },
    );
    try {
      await engineB.cancel(id);

      // The cancel found the run finished and did nothing: completed is not overwritten.
      const stillCompleted = await engineA.get(id);
      expect(stillCompleted?.status).toBe('completed');
      expect(await slotHolders(storage, 'P1')).toEqual([]);
    } finally {
      await engineB[Symbol.asyncDispose]();
      await engineA[Symbol.asyncDispose]();
    }
  });

  it('a local cancel of a run another engine already terminated settles the local result waiter', async () => {
    const id = `teardown-durable-localwaiter-${nextInvocation()}`;
    const storage = new MemoryStorage();
    await using engineA = await createEngine(storage);
    await using engineB = await createEngine(storage);
    const old = await engineA.start(TYPE, 'P1:OLD', { id });
    const outcome = old.result().then(
      () => 'resolved',
      () => 'rejected',
    );
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

    // Another engine terminates the run durably; this engine's waiter is not told.
    await engineB.cancel(id);
    // Cancelling again locally finds the record already terminal and must still settle the waiter.
    await engineA.cancel(id);

    const settled = await Promise.race([outcome, Bun.sleep(3_000).then(() => 'hung')]);
    expect(settled).toBe('rejected');
  });

  /** A holds an old run with a result waiter; A's cancel of it parks just before its commit. */
  async function holdCancelOfOldRun(id: string) {
    const storage = new MemoryStorage();
    const gate = newGate();
    let armed = false;
    const engineA = await createEngine(
      gateFirstWrite(
        storage,
        gate,
        (operations) =>
          armed &&
          operations.some(
            (operation) =>
              operation.type === 'put' &&
              operation.key === KEYS.workflow(id) &&
              (decode(operation.value) as { status?: string }).status === 'cancelled',
          ),
      ),
    );
    const engineB = await createEngine(storage);
    const old = await engineA.start(TYPE, 'P1:OLD', { id });
    const oldOutcome = old.result().then(
      (value) => `resolved:${value}`,
      (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
    );
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    armed = true;
    const cancelOld = engineA.cancel(id);
    await gate.reached.promise;
    return { storage, gate, engineA, engineB, oldOutcome, cancelOld };
  }

  it('a cancel refused because a completed replacement took the id rejects the old waiter and never settles it with the replacement outcome', async () => {
    const id = `teardown-durable-refused-replaced-${nextInvocation()}`;
    const { gate, engineA, engineB, oldOutcome, cancelOld } = await holdCancelOfOldRun(id);
    try {
      // Another engine ends the old run, starts a replacement under the same id and finishes it.
      await engineB.cancel(id);
      const replacement = await engineB.start(TYPE, 'P1:NEW', {
        id,
        onTerminalConflict: 'start-new',
      });
      await engineB[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      await engineB.signal(id, 'go');
      expect(await replacement.result()).toBe('P1:NEW');

      gate.release.resolve();
      await cancelOld;

      const settled = await Promise.race([oldOutcome, Bun.sleep(3_000).then(() => 'hung')]);
      expect(settled).toContain('rejected:');
      expect(settled).not.toContain('P1:NEW');
      // The replacement's durable outcome is untouched.
      const state = await engineB.get(id);
      expect(state?.status).toBe('completed');
    } finally {
      gate.release.resolve();
      await engineB[Symbol.asyncDispose]();
      await engineA[Symbol.asyncDispose]();
    }
  });

  it('a cancel refused because a running replacement took the id leaves the replacement checkpoint, state and waiter alone', async () => {
    const id = `teardown-durable-refused-running-${nextInvocation()}`;
    const { gate, engineA, engineB, oldOutcome, cancelOld } = await holdCancelOfOldRun(id);
    try {
      await engineB.cancel(id);
      // The replacement starts on the same engine whose cancel is parked.
      const replacement = await engineA.start(TYPE, 'P1:NEW', {
        id,
        onTerminalConflict: 'start-new',
      });
      const replacementResult = replacement.result();
      await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

      gate.release.resolve();
      await cancelOld;

      // The old waiter settled as the old run's, not the replacement's, and the replacement lives on.
      expect(await oldOutcome).toContain('rejected:');
      expect(getInternals(engineA).parkedInlineWorkflows.has(id)).toBe(true);
      expect(getInternals(engineA).checkpoints.has(id)).toBe(true);
      const state = await engineA.get(id);
      expect(state?.status === 'pending' || state?.status === 'running').toBe(true);
      await engineA.signal(id, 'go');
      expect(await replacementResult).toBe('P1:NEW');
    } finally {
      gate.release.resolve();
      await engineB[Symbol.asyncDispose]();
      await engineA[Symbol.asyncDispose]();
    }
  });

  it('a completion racing a remote cancel of the same run both settle and release the slot once', async () => {
    const id = `teardown-durable-racing-${nextInvocation()}`;
    const storage = new MemoryStorage();
    await using engineA = await createEngine(storage);
    await using engineB = await createEngine(storage);
    const old = await engineA.start(TYPE, 'P1:OLD', { id });
    void old.result().catch(() => undefined);
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);

    const outcomes = await Promise.allSettled([engineA.signal(id, 'go'), engineB.cancel(id)]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    const state = await engineA.get(id);
    expect(state?.status === 'completed' || state?.status === 'cancelled').toBe(true);
    expect(await slotHolders(storage, 'P1')).toEqual([]);
    expect(await storage.get(KEYS.workflowConcurrencyHolder(id))).toBeNull();
  });

  it('a replacement that commits mid-batch makes the fenced attribute write fail its condition', async () => {
    const id = `teardown-durable-midbatch-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    // The in-memory check passes when the batch is issued; only the durable condition sees the replacement.
    await using engine = await createEngine(
      gateFirstWrite(storage, gate, deletes(KEYS.attribute(id))),
    );
    try {
      const oldDone = terminateOldRun(engine, id, 'cancel', gate);
      await gate.reached.promise;
      const replacement = await engine.start(TYPE, 'P1:NEW', {
        id,
        onTerminalConflict: 'start-new',
        searchAttributes: { tag: 'new' },
      });
      await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      gate.release.resolve();
      await oldDone;
      await Bun.sleep(50);
      await expectReplacementIntact(storage, engine, id, replacement, 'P1');
    } finally {
      gate.release.resolve();
    }
  });

  it('a replacement with a different concurrency partition leaves no stranded slot', async () => {
    const id = `teardown-durable-partition-${nextInvocation()}`;
    const storage = new MemoryStorage();
    const gate = newGate();
    await using engine = await createEngine(
      gateFirstWrite(storage, gate, deletes(KEYS.workflowConcurrencyHolder(id))),
    );
    try {
      const oldDone = terminateOldRun(engine, id, 'cancel', gate);
      await gate.reached.promise;
      const replacement = await engine.start(TYPE, 'P2:NEW', {
        id,
        onTerminalConflict: 'start-new',
        searchAttributes: { tag: 'new' },
      });
      await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
      gate.release.resolve();
      await oldDone;
      await Bun.sleep(50);
      expect(await slotHolders(storage, 'P1')).toEqual([]);
      await expectReplacementIntact(storage, engine, id, replacement, 'P2');
    } finally {
      gate.release.resolve();
    }
  });
});

describe('COR-1386: a start-new purge settles the old run result waiter with the old run own outcome', () => {
  /** Fold the settlement of `promise` into a value so a hang is observable without a timeout pass condition. */
  function trackSettlement(promise: Promise<unknown>): { readonly state: () => string } {
    let outcome = 'pending';
    void promise.then(
      (value) => {
        outcome = `resolved:${String(value)}`;
      },
      (error: unknown) => {
        outcome = `rejected:${error instanceof Error ? error.message : String(error)}`;
      },
    );
    return { state: () => outcome };
  }

  /** Let every already-queued microtask and macrotask drain; only bounds a failure, never gates a pass. */
  const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('gated release: result() taken before the signal resolves with the old run result after a start-new', async () => {
    const id = `purge-waiter-gated-${nextInvocation()}`;
    const storage = new MemoryStorage();
    await using engineA = await Engine.create({
      storage,
      workflows: { 'claim-race-echo': claimRaceEchoWorkflow },
      ownership: 'workflow-lease',
      workflowClaimTtl: '1m',
      workflowClaimRenewInterval: '5s',
      recover: false,
      backgroundTasks: 'manual',
    });
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = true;
    const holderKey = KEYS.workflowOwnerHolder(id);
    const gatedRegistryStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'conditionalBatch') {
          return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
            if (armed && operations.some((op) => op.type === 'delete' && op.key === holderKey)) {
              armed = false;
              reached.resolve();
              await release.promise;
            }
            return target.conditionalBatch(conditions, operations);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    installClaimRegistry(engineA, 'engine-a', gatedRegistryStorage);

    const oldHandle = await engineA.start('claim-race-echo', 'OLD', { id });
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    const oldOutcome = trackSettlement(oldHandle.result());

    await engineA.signal(id, 'go');
    await reached.promise;
    const committedSummary = await engineA.get(id);
    expect(committedSummary?.status).toBe('completed');

    const replacement = await engineA.start('claim-race-echo', 'NEW', {
      id,
      onTerminalConflict: 'start-new',
    });
    await engineA[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    // The purge that admitted the replacement has run; the old waiter must already be settled.
    await drain();
    expect(oldOutcome.state()).toBe('resolved:OLD');

    release.resolve();
    await engineA.signal(id, 'go');
    expect(await replacement.result()).toBe('NEW');
    expect(oldOutcome.state()).toBe('resolved:OLD');
  });

  it('same engine, ungated: result() on a completed run followed by start-new settles the old waiter with the old result', async () => {
    const id = `purge-waiter-ungated-${nextInvocation()}`;
    const storage = new MemoryStorage();
    await using engine = await Engine.create({
      storage,
      workflows: { 'claim-race-echo': claimRaceEchoWorkflow },
      recover: false,
    });
    const oldHandle = await engine.start('claim-race-echo', 'OLD', { id });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    const oldOutcome = trackSettlement(oldHandle.result());
    await engine.signal(id, 'go');
    expect(await oldHandle.result()).toBe('OLD');

    const replacement = await engine.start('claim-race-echo', 'NEW', {
      id,
      onTerminalConflict: 'start-new',
    });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    await drain();
    expect(oldOutcome.state()).toBe('resolved:OLD');
    await engine.signal(id, 'go');
    expect(await replacement.result()).toBe('NEW');
  });

  it('stale-snapshot bulk purge never settles the same-id replacement waiter with the old outcome', async () => {
    const id = `purge-waiter-stale-${nextInvocation()}`;
    const storage = new MemoryStorage();
    await using engine = await Engine.create({
      storage,
      workflows: { 'claim-race-echo': claimRaceEchoWorkflow },
      recover: false,
    });
    const oldHandle = await engine.start('claim-race-echo', 'OLD', { id });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    await engine.signal(id, 'go');
    expect(await oldHandle.result()).toBe('OLD');
    const internals = getInternals(engine);
    // What a bulk scan saw before the replacement committed.
    const staleSnapshot = await loadWorkflowState(internals, id);
    expect(staleSnapshot).toBeDefined();

    const replacement = await engine.start('claim-race-echo', 'NEW', {
      id,
      onTerminalConflict: 'start-new',
    });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    const replacementOutcome = trackSettlement(replacement.result());

    await purgeWorkflow(internals, staleSnapshot!, () => {});
    await drain();
    expect(replacementOutcome.state()).not.toBe('resolved:OLD');
    expect(replacementOutcome.state()).toBe('pending');
  });
});
