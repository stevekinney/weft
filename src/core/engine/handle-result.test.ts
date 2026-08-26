import { describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  flushMicrotasks,
  waitForCondition,
  waitForRealTimersForTesting,
} from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import {
  bootstrapWorkflowResultResolver,
  createWorkflowHandleWithResultPromise,
  createWorkflowResultWaiter,
  getGeneratorOwnedWorkflowResultPromise,
  getWorkflowResultPromise,
  pollPendingCrossEngineResultWaiters,
} from './handle-result.ts';
import { getInternals } from './internals.ts';
import { encodeEpoch, encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

class WorkflowStateReadFailureStorage extends MemoryStorage {
  constructor(private readonly failingWorkflowId: string) {
    super();
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === KEYS.workflow(this.failingWorkflowId)) {
      throw new Error(`failed to read ${this.failingWorkflowId}`);
    }
    return super.get(key);
  }
}

/** Fails the `failingWorkflowId` state read exactly `failures` times, then behaves normally. */
class FlakyWorkflowStateStorage extends MemoryStorage {
  #failuresRemaining: number;

  constructor(
    private readonly failingWorkflowId: string,
    failures: number,
  ) {
    super();
    this.#failuresRemaining = failures;
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === KEYS.workflow(this.failingWorkflowId) && this.#failuresRemaining > 0) {
      this.#failuresRemaining -= 1;
      throw new Error(`transient read failure for ${this.failingWorkflowId}`);
    }
    return super.get(key);
  }
}

describe('workflow result resolution', () => {
  it('rejects the waiter when loading workflow state throws', async () => {
    await using engine = new Engine({
      storage: new WorkflowStateReadFailureStorage('wf-state-read-failure'),
    });
    const internals = getInternals(engine);
    const waiter = createWorkflowResultWaiter(internals, 'wf-state-read-failure');

    await bootstrapWorkflowResultResolver(internals, 'wf-state-read-failure', waiter);

    await expect(waiter.promise).rejects.toThrow('failed to read wf-state-read-failure');
    expect(internals.resultResolvers.has('wf-state-read-failure')).toBe(false);
  });

  it('leaves a pending waiter registered — not rejected — after a transient state-read failure under ownership: "workflow-lease"', async () => {
    const storage = new FlakyWorkflowStateStorage('poll-transient-1', 1);
    await using engine = await Engine.create({
      storage,
      ownership: 'workflow-lease',
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    });
    const internals = getInternals(engine);
    const waiter = createWorkflowResultWaiter(internals, 'poll-transient-1');
    void waiter.promise.catch(() => {});

    // First attempt: the storage read throws. Unlike the `ownership: 'none'`
    // case above, a guaranteed periodic retry exists under `workflow-lease`
    // (the poll loop / `runMaintenance()`-driven drain), so a read failure —
    // which says nothing about whether the workflow is still running,
    // possibly on another engine — must NOT reject or remove the waiter.
    await bootstrapWorkflowResultResolver(internals, 'poll-transient-1', waiter);
    expect(internals.resultResolvers.get('poll-transient-1')).toBe(waiter);

    // Second attempt (standing in for the guaranteed retry): storage has
    // recovered, so the SAME waiter — never replaced or leaked — now
    // settles normally (this workflow id was never actually started, so it
    // resolves to the ordinary "not found" terminal outcome).
    await bootstrapWorkflowResultResolver(internals, 'poll-transient-1', waiter);
    await expect(waiter.promise).rejects.toThrow('not found in storage');
    expect(internals.resultResolvers.has('poll-transient-1')).toBe(false);
  });

  it('links a replacement waiter to the current waiter promise', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const currentWaiter = createWorkflowResultWaiter(internals, 'wf-replacement');
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const replacementWaiter = { promise, resolve, reject };

    await bootstrapWorkflowResultResolver(internals, 'wf-replacement', replacementWaiter);
    currentWaiter.resolve('resolved through replacement');

    await expect(replacementWaiter.promise).resolves.toBe('resolved through replacement');
  });

  it('unregisters the previous cached handle token before replacing it', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const unregisterSpy = spyOn(internals.finalizationRegistry, 'unregister');

    const firstHandle = createWorkflowHandleWithResultPromise(internals, 'wf-cache');
    const firstCachedEntry = internals.handleCache.get('wf-cache');
    const secondHandle = createWorkflowHandleWithResultPromise(internals, 'wf-cache');

    expect(firstHandle.id).toBe('wf-cache');
    expect(secondHandle.id).toBe('wf-cache');
    expect(firstCachedEntry).toBeDefined();
    expect(unregisterSpy).toHaveBeenCalledTimes(1);
    expect(unregisterSpy).toHaveBeenCalledWith(firstCachedEntry!.unregisterToken);
  });
});

describe('WFT-79: cross-engine result-poll fallback (ownership: "workflow-lease")', () => {
  const pollableWorkflow = workflow({ name: 'wft-79-poll-fallback' }).execute(async function* (
    ctx: WorkflowContext,
  ) {
    yield* ctx.waitForSignal('go');
    return 'poll-fallback-done';
  });
  const workflows = { 'wft-79-poll-fallback': pollableWorkflow };

  it('does not schedule a poll under ownership: "none" (inert, registry is null)', async () => {
    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      workflows,
      recover: false,
    });
    await engine.start('wft-79-poll-fallback', null, { id: 'poll-none-1' });

    const resultPromise = engine.getHandle('poll-none-1').result();
    await flushMicrotasks();
    await engine.getHandle('poll-none-1').signal('go');

    // Resolves through the ordinary same-engine `termination/complete.ts`
    // path alone — the registry-null branch never schedules a competing
    // `setTimeout`, so this settles without any fake/advanced timers.
    await expect(resultPromise).resolves.toBe('poll-fallback-done');
  });

  it('does not schedule a further poll once the workflow is already terminal', async () => {
    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      workflows,
      ownership: 'workflow-lease',
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    });
    const handle = await engine.start('wft-79-poll-fallback', null, { id: 'poll-terminal-1' });
    await handle.signal('go');
    await expect(handle.result()).resolves.toBe('poll-fallback-done');

    // A FRESH waiter (the cached handle's promise already settled, so this
    // exercises `getWorkflowResultPromise`'s `!existingWaiter` branch again)
    // for an ALREADY-terminal workflow resolves synchronously from storage —
    // `resultResolvers` no longer holds this waiter by the time the
    // scheduling check runs, so no poll is scheduled.
    const internals = getInternals(engine);
    const waiter = createWorkflowResultWaiter(internals, 'poll-terminal-1');
    await bootstrapWorkflowResultResolver(internals, 'poll-terminal-1', waiter);
    await expect(waiter.promise).resolves.toBe('poll-fallback-done');
    expect(internals.resultResolvers.has('poll-terminal-1')).toBe(false);
  });

  it('resolves a pending waiter once the awaited workflow terminates on a DIFFERENT engine', async () => {
    const storage = new MemoryStorage();

    // Seed a durably running, signal-parked workflow with a plain
    // `ownership: 'none'` engine — no claim exists yet either way.
    await using seedEngine = await Engine.create({ storage, workflows, recover: false });
    await seedEngine.start('wft-79-poll-fallback', null, { id: 'poll-cross-1' });
    await waitForCondition(
      async () => (await storage.get(KEYS.checkpoint('poll-cross-1'))) !== null,
      { label: 'checkpoint for parked workflow' },
    );

    const ownershipOptions = {
      ownership: 'workflow-lease' as const,
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    };
    await using engineOwner = await Engine.create({ storage, workflows, ...ownershipOptions });
    await engineOwner.resume('poll-cross-1');

    await using engineOutsider = await Engine.create({ storage, workflows, ...ownershipOptions });
    const outsiderInternals = getInternals(engineOutsider);

    let settled = false;
    void getWorkflowResultPromise(outsiderInternals, 'poll-cross-1').then((value) => {
      settled = value === 'poll-fallback-done';
    });

    // The workflow is still parked — the outsider's waiter must not resolve
    // just from being created.
    await flushMicrotasks();
    expect(settled).toBe(false);

    // Complete the workflow on its OWNING engine, never on the outsider —
    // the outsider's `resultResolvers` map is never touched by that
    // termination. Only this file's new poll can observe it.
    await engineOwner.getHandle('poll-cross-1').signal('go');
    await expect(engineOwner.getHandle('poll-cross-1').result()).resolves.toBe(
      'poll-fallback-done',
    );

    await waitForCondition(() => settled, {
      label: 'outsider engine observing cross-engine completion via poll',
    });
  });
});

describe('pollPendingCrossEngineResultWaiters (backgroundTasks: "manual" drain)', () => {
  const drainWorkflow = workflow({ name: 'wft-79-poll-fallback' }).execute(async function* (
    ctx: WorkflowContext,
  ) {
    yield* ctx.waitForSignal('go');
    return 'poll-fallback-done';
  });
  const workflows = { 'wft-79-poll-fallback': drainWorkflow };
  const manualOptions = {
    ownership: 'workflow-lease' as const,
    backgroundTasks: 'manual' as const,
    workflowClaimTtl: 200,
    workflowClaimRenewInterval: 20,
    recover: false,
  };

  it('is inert when no claim registry exists (ownership: "none")', async () => {
    using storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, workflows, recover: false });
    const internals = getInternals(engine);
    expect(internals.workflowClaimRegistry).toBeNull();

    // Must not throw and must not touch any waiter.
    await expect(pollPendingCrossEngineResultWaiters(internals)).resolves.toBeUndefined();
  });

  it('defers to local terminal delivery for a claim this engine holds, without settling early', async () => {
    using storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, workflows, ...manualOptions });
    const internals = getInternals(engine);

    await engine.start('wft-79-poll-fallback', null, { id: 'drain-owned-1' });
    expect(internals.workflowClaimRegistry?.currentEpoch('drain-owned-1')).not.toBeNull();

    // Registering the waiter is what makes this test exercise the drain's
    // locally-owned branch at all. Without it `resultResolvers` is empty, the
    // loop body never runs, and the assertion below holds no matter what the
    // branch does — which is how the previous version of this test passed
    // vacuously while claiming to pin the behavior.
    let settled = false;
    // The catch is required, not decorative: this waiter is still pending when
    // the enclosing `await using` disposes the engine, and `disposeEngine`
    // rejects every pending waiter. Without it that rejection is unhandled.
    void getWorkflowResultPromise(internals, 'drain-owned-1').then(
      () => {
        settled = true;
      },
      () => {},
    );
    await flushMicrotasks();
    expect(internals.resultResolvers.has('drain-owned-1')).toBe(true);

    await pollPendingCrossEngineResultWaiters(internals);

    // The workflow is parked on its signal, so the drain must leave the waiter
    // pending for this engine's own terminal path to settle.
    //
    // This deliberately no longer asserts zero storage reads. The drain now
    // yields a macrotask and re-checks instead of skipping outright, because a
    // held claim does NOT guarantee this engine's `notifyCompletionWaiters()`
    // ever runs for the workflow — an unconditional skip orphans the waiter for
    // as long as the claim is held. The automatic poll made the same trade for
    // the same reason; one read per pending waiter per drain is the cost of not
    // hanging.
    expect(settled).toBe(false);
    expect(internals.resultResolvers.has('drain-owned-1')).toBe(true);
  });

  it('settles a waiter for a claim this engine holds when the workflow terminated elsewhere', async () => {
    // The orphaning scenario an unconditional locally-owned skip creates.
    // Holding the claim does NOT imply this engine's own
    // `notifyCompletionWaiters()` ever runs: `seedEngine` keeps a live
    // in-memory generator and drives the workflow to completion itself, so the
    // claim-holding engine's terminal path never fires for it. The waiter must
    // be created while the workflow is still running — otherwise the initial
    // `bootstrapWorkflowResultResolver` settles it immediately and the drain is
    // never the deciding path.
    using storage = new MemoryStorage();
    await using seedEngine = await Engine.create({ storage, workflows, recover: false });
    const seeded = await seedEngine.start('wft-79-poll-fallback', null, { id: 'drain-orphan-1' });

    await using owner = await Engine.create({ storage, workflows, ...manualOptions });
    const internals = getInternals(owner);
    const acquired = await internals.workflowClaimRegistry?.acquire('drain-orphan-1');
    expect(acquired?.status).toBe('acquired');

    // Created while running, so it stays pending rather than self-settling.
    let settled: unknown = null;
    void getWorkflowResultPromise(internals, 'drain-orphan-1').then(
      (value) => {
        settled = value;
      },
      () => {},
    );
    await flushMicrotasks();
    expect(settled).toBeNull();

    // Terminates on the OTHER engine, so nothing local will ever deliver it.
    await seedEngine.getHandle('drain-orphan-1').signal('go');
    await expect(seeded.result()).resolves.toBe('poll-fallback-done');

    await pollPendingCrossEngineResultWaiters(internals);
    await waitForCondition(() => settled === 'poll-fallback-done', {
      label: 'manual-mode drain settling a locally-claimed waiter terminated elsewhere',
    });
  });

  it('settles a waiter for a workflow this engine does not own', async () => {
    using storage = new MemoryStorage();
    await using seedEngine = await Engine.create({ storage, workflows, recover: false });
    const seeded = await seedEngine.start('wft-79-poll-fallback', null, { id: 'drain-remote-1' });
    await seedEngine.getHandle('drain-remote-1').signal('go');
    await expect(seeded.result()).resolves.toBe('poll-fallback-done');

    await using outsider = await Engine.create({ storage, workflows, ...manualOptions });
    const internals = getInternals(outsider);
    expect(internals.workflowClaimRegistry?.currentEpoch('drain-remote-1')).toBeNull();

    let settled: unknown = null;
    void getWorkflowResultPromise(internals, 'drain-remote-1').then((value) => {
      settled = value;
    });
    await flushMicrotasks();

    await pollPendingCrossEngineResultWaiters(internals);
    await waitForCondition(() => settled === 'poll-fallback-done', {
      label: 'manual-mode drain settling a non-owned waiter',
    });
  });

  it('keeps draining the remaining waiters when one workflow read throws', async () => {
    using storage = new WorkflowStateReadFailureStorage('drain-broken-1');
    await using outsider = await Engine.create({ storage, workflows, ...manualOptions });
    const internals = getInternals(outsider);

    const brokenWaiter = createWorkflowResultWaiter(internals, 'drain-broken-1');
    void brokenWaiter.promise.catch(() => {});
    const healthyWaiter = createWorkflowResultWaiter(internals, 'drain-healthy-1');
    void healthyWaiter.promise.catch(() => {});

    // One unreadable workflow must not stop the pass; both entries are visited
    // and the call resolves rather than rejecting.
    await expect(pollPendingCrossEngineResultWaiters(internals)).resolves.toBeUndefined();
  });
});

describe('WFT-79 F1: generator-owned child-result fencing', () => {
  const childWorkflow = workflow({ name: 'wft-79-f1-child' }).execute(async function* () {
    return 'child-done';
  });
  const failingChildWorkflow = workflow({ name: 'wft-79-f1-failing-child' }).execute(
    async function* () {
      throw new Error('child-failed');
    },
  );
  const workflows = {
    'wft-79-f1-child': childWorkflow,
    'wft-79-f1-failing-child': failingChildWorkflow,
  };
  const ownershipOptions = {
    ownership: 'workflow-lease' as const,
    workflowClaimTtl: 200,
    workflowClaimRenewInterval: 20,
    recover: false,
  };

  it('delivers a failed child result through the fence when the parent still holds its claim', async () => {
    const storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, workflows, ...ownershipOptions });
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;

    const acquired = await registry.acquire('parent-failing');
    expect(acquired.status).toBe('acquired');

    const childHandle = await engine.start('wft-79-f1-failing-child', null, {
      id: 'child-failing',
    });
    await expect(childHandle.result()).rejects.toThrow('child-failed');

    await expect(
      getGeneratorOwnedWorkflowResultPromise(internals, 'child-failing', 'parent-failing'),
    ).rejects.toThrow('child-failed');
  });

  it('never settles a generator-owned waiter once the parent generation is confirmed lost', async () => {
    const storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, workflows, ...ownershipOptions });
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;

    // Stand in for a parent parked on `ctx.startChild()`: this engine holds a
    // claim for the parent id, without needing an actual running generator.
    const acquired = await registry.acquire('parent-1');
    expect(acquired.status).toBe('acquired');

    // The child completes normally and durably.
    const childHandle = await engine.start('wft-79-f1-child', null, { id: 'child-1' });
    await expect(childHandle.result()).resolves.toBe('child-done');

    // A generator-owned waiter created AFTER the child is already terminal —
    // same as a fresh `getGeneratorOwnedWorkflowResultPromise` call racing a
    // recovered-successor takeover of the parent.
    let settled = false;
    let rejected = false;
    void getGeneratorOwnedWorkflowResultPromise(internals, 'child-1', 'parent-1').then(
      () => {
        settled = true;
      },
      () => {
        rejected = true;
      },
    );

    // Simulate a successor engine taking over the PARENT (not the child)
    // before this waiter's bootstrap resolves.
    await storage.batch([
      { type: 'put', key: KEYS.workflowOwnerEpoch('parent-1'), value: encodeEpoch(2) },
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('parent-1'),
        value: encodeWorkflowClaimHolder({
          engineId: 'successor-engine',
          epoch: 2,
          expiresAt: internals.options.getNow() + 60_000,
          claimedAt: internals.options.getNow(),
        }),
      },
    ]);

    // Give the generator-owned waiter's ownership confirmation every chance
    // to run and (wrongly, if unfenced) settle.
    await flushMicrotasks();
    // fixed delay: negative assertion — proving the waiter never settles has no observable event to await instead
    await waitForRealTimersForTesting(50);

    // The parent's view never settles: the successor replays that parent, and
    // this engine's copy must not advance.
    expect(settled).toBe(false);
    expect(rejected).toBe(false);
    // The SHARED waiter is not held hostage by the parent's fence. The child's
    // result is durable and an observational caller is entitled to it, so the
    // waiter settles and is removed; only the parent's derived promise is
    // withheld. (This assertion previously required the opposite — the shared
    // waiter pinned forever — which is what starved unrelated observers.)
    expect(internals.resultResolvers.has('child-1')).toBe(false);
  });

  it('still delivers the child result to an observational caller sharing the waiter', async () => {
    // `resultResolvers` dedupes to one waiter per workflow id, so a parked
    // parent and an external `handle.result()` observer can share it. Applying
    // the parent's fence to that shared entry starved the observer of a result
    // that was already durable.
    const storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, workflows, ...ownershipOptions });
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const parentClaim = await registry.acquire('parent-2');
    expect(parentClaim.status).toBe('acquired');

    const childHandle = await engine.start('wft-79-f1-child', null, { id: 'child-2' });
    await expect(childHandle.result()).resolves.toBe('child-done');

    // Parent attaches first, observer second — both land on one waiter.
    let parentSettled = false;
    void getGeneratorOwnedWorkflowResultPromise(internals, 'child-2', 'parent-2').then(
      () => {
        parentSettled = true;
      },
      () => {
        parentSettled = true;
      },
    );
    const observed = getWorkflowResultPromise(internals, 'child-2');

    // The successor takes over the PARENT only; the child is untouched.
    await storage.batch([
      { type: 'put', key: KEYS.workflowOwnerEpoch('parent-2'), value: encodeEpoch(2) },
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('parent-2'),
        value: encodeWorkflowClaimHolder({
          engineId: 'successor-engine',
          epoch: 2,
          expiresAt: internals.options.getNow() + 60_000,
          claimedAt: internals.options.getNow(),
        }),
      },
    ]);

    // The observer gets the durable result even though the parent is deposed.
    await expect(observed).resolves.toBe('child-done');
    expect(parentSettled).toBe(false);
  });

  it('settles a generator-owned waiter normally when the parent still holds its claim', async () => {
    const storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, workflows, ...ownershipOptions });
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;

    const acquired = await registry.acquire('parent-2');
    expect(acquired.status).toBe('acquired');

    const childHandle = await engine.start('wft-79-f1-child', null, { id: 'child-2' });
    await expect(childHandle.result()).resolves.toBe('child-done');

    await expect(
      getGeneratorOwnedWorkflowResultPromise(internals, 'child-2', 'parent-2'),
    ).resolves.toBe('child-done');
  });

  it("proceeds (matching confirmWakeOwnership's own thrown-read policy) when the ownership pre-check itself throws", async () => {
    const storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, workflows, ...ownershipOptions });
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;

    const acquired = await registry.acquire('parent-3');
    expect(acquired.status).toBe('acquired');

    const childHandle = await engine.start('wft-79-f1-child', null, { id: 'child-3' });
    await expect(childHandle.result()).resolves.toBe('child-done');

    // Simulate a thrown pre-check read (e.g. a transient failure reading the
    // registry's own cached epoch) rather than a confirmed loss of ownership.
    // Scoped to the PARENT id only — `getWorkflowResultPromise`'s own
    // unrelated `currentEpoch` check for the CHILD id must keep behaving
    // normally, or this stubs out more than the scenario intends.
    const originalCurrentEpoch = registry.currentEpoch.bind(registry);
    const currentEpochSpy = spyOn(registry, 'currentEpoch').mockImplementation(
      (workflowId: string) => {
        if (workflowId === 'parent-3') throw new Error('transient pre-check failure');
        return originalCurrentEpoch(workflowId);
      },
    );
    try {
      await expect(
        getGeneratorOwnedWorkflowResultPromise(internals, 'child-3', 'parent-3'),
      ).resolves.toBe('child-done');
    } finally {
      currentEpochSpy.mockRestore();
    }
  });
});

describe('WFT-79 F2: local-claim settling never races notifyCompletionWaiters ordering', () => {
  const raceWorkflow = workflow({ name: 'wft-79-f2-race' }).execute(async function* (
    ctx: WorkflowContext,
  ) {
    yield* ctx.waitForSignal('go');
    return 'race-done';
  });
  const workflows = { 'wft-79-f2-race': raceWorkflow };

  /**
   * Reproduces the scenario that hangs forever under a "skip settling
   * outright whenever the local claim is held" implementation of F2: a
   * SEPARATE engine (`seedEngine`) keeps a stale in-memory generator for the
   * SAME workflow id that `engineOwner` later resumes and claims. When
   * `seedEngine`'s own copy independently drives the workflow to
   * completion first, `engineOwner`'s own `completeWorkflow()` finds the
   * state already non-`'running'` and returns WITHOUT ever calling
   * `notifyCompletionWaiters()` — so a poll that always deferred to "local
   * claim implies terminal delivery" would leave `engineOwner`'s own
   * `handle.result()` waiter unsettled forever, even though the workflow is
   * durably terminal.
   */
  it('settles a locally-claimed waiter from durable state when this engine never calls notifyCompletionWaiters for it', async () => {
    const storage = new MemoryStorage();

    // seedEngine starts the workflow and keeps a live in-memory generator for
    // it — deliberately never disposed for the duration of this test.
    await using seedEngine = await Engine.create({ storage, workflows, recover: false });
    await seedEngine.start('wft-79-f2-race', null, { id: 'race-1' });
    await waitForCondition(async () => (await storage.get(KEYS.checkpoint('race-1'))) !== null, {
      label: 'checkpoint for parked workflow',
    });

    await using engineOwner = await Engine.create({
      storage,
      workflows,
      ownership: 'workflow-lease',
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    });
    await engineOwner.resume('race-1');

    const ownerHandle = engineOwner.getHandle('race-1');
    const resultPromise = ownerHandle.result();

    // seedEngine's stale in-memory generator observes the signal and
    // completes the workflow FIRST, racing engineOwner's own claim-holding
    // generator. Either engine may win the durable write; the assertion below
    // only requires that engineOwner's own waiter still settles correctly.
    await seedEngine.getHandle('race-1').signal('go');

    await expect(resultPromise).resolves.toBe('race-done');
  });
});

describe('WFT-79 F3: transient loadWorkflowResult failure retries under "workflow-lease"', () => {
  it('leaves a pending waiter registered — not rejected — after a transient failure on the SECOND (result) read', async () => {
    // `loadWorkflowResult` re-reads the SAME `KEYS.workflow(...)` key that
    // `bootstrapWorkflowResultResolver`'s own `loadWorkflowState` already
    // read. Complete a real workflow first so the durable record is
    // authentic, THEN swap this engine's own `storage.get` for a wrapper that
    // fails only on the SECOND read of that key — `loadWorkflowResult`'s
    // internal re-read — mirroring `wake-ownership-guard.test.ts`'s
    // storage-swap pattern.
    const storage = new MemoryStorage();
    const completedWorkflow = workflow({ name: 'wft-79-f3-instant' }).execute(async function* () {
      return 'f3-result';
    });
    await using engine = await Engine.create({
      storage,
      workflows: { 'wft-79-f3-instant': completedWorkflow },
      ownership: 'workflow-lease',
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    });
    const handle = await engine.start('wft-79-f3-instant', null, { id: 'f3-transient-1' });
    await expect(handle.result()).resolves.toBe('f3-result');

    const internals = getInternals(engine);
    const recordKey = KEYS.workflow('f3-transient-1');
    let reads = 0;
    internals.storage = {
      capabilities: () => storage.capabilities(),
      get: (key) => {
        if (key === recordKey) {
          reads += 1;
          if (reads === 2) {
            return Promise.reject(new Error('transient read failure for f3-transient-1 (read #2)'));
          }
        }
        return storage.get(key);
      },
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
      scan: (prefix, options) => storage.scan(prefix, options),
      batch: (operations) => storage.batch(operations),
      conditionalBatch: (conditions, operations) =>
        storage.conditionalBatch(conditions, operations),
      [Symbol.dispose]: () => storage[Symbol.dispose](),
    };

    const waiter = createWorkflowResultWaiter(internals, 'f3-transient-1');
    void waiter.promise.catch(() => {});

    // Read #1 (bootstrap's own loadWorkflowState) succeeds, sees `completed`;
    // Read #2 (loadWorkflowResult's internal re-read) throws. Without the
    // F3 fix this rejects and removes the waiter; with the fix it must stay
    // pending for the guaranteed periodic retry.
    await bootstrapWorkflowResultResolver(internals, 'f3-transient-1', waiter);
    expect(internals.resultResolvers.get('f3-transient-1')).toBe(waiter);

    // Retry: storage has recovered, the SAME waiter now settles normally.
    await bootstrapWorkflowResultResolver(internals, 'f3-transient-1', waiter);
    await expect(waiter.promise).resolves.toBe('f3-result');
    expect(internals.resultResolvers.has('f3-transient-1')).toBe(false);
  });
});
