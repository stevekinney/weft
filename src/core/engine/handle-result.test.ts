import { describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { flushMicrotasks, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import {
  bootstrapWorkflowResultResolver,
  createWorkflowHandleWithResultPromise,
  createWorkflowResultWaiter,
  getWorkflowResultPromise,
  pollPendingCrossEngineResultWaiters,
} from './handle-result.ts';
import { getInternals } from './internals.ts';

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

  it('skips a workflow this engine already holds a claim for', async () => {
    using storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, workflows, ...manualOptions });
    const internals = getInternals(engine);

    await engine.start('wft-79-poll-fallback', null, { id: 'drain-owned-1' });
    expect(internals.workflowClaimRegistry?.currentEpoch('drain-owned-1')).not.toBeNull();

    // A locally-held claim settles through this engine's own terminal path, so
    // the drain must not spend a state read on it.
    const loadSpy = spyOn(storage, 'get');
    const before = loadSpy.mock.calls.length;
    await pollPendingCrossEngineResultWaiters(internals);
    expect(loadSpy.mock.calls.length).toBe(before);
    loadSpy.mockRestore();
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
