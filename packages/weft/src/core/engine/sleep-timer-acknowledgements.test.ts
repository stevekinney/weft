import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { rejectionOf, throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import {
  workflow,
  type WorkflowContext,
  type WorkflowState,
  type WorkflowStatus,
} from '../types.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import { getInternals } from './internals.ts';
import {
  acknowledgeSupersededSleepTimers,
  createSleepTimerAcknowledgement,
  handleSleepTimerWithAcknowledgement,
  recordDurableInlineOperation,
  rejectAllSleepTimerAcknowledgements,
  rejectSleepTimerAcknowledgements,
  resolveDiscardedTimerDisposition,
  resolveSleepTimer,
  retainDiscardedDurableTimer,
  settleSleepTimerAcknowledgements,
} from './sleep-timer-acknowledgements.ts';

function createInternals(): EngineInternals {
  return {
    durableInlineOperations: new Map(),
    sleepResolvers: new Map(),
    pendingAtomicWorkflowCommitSideEffects: new Map(),
    sleepTimerAcknowledgementWaiters: new Map(),
  } as EngineInternals;
}

function createWorkflowState(workflowId: string, status: WorkflowStatus): WorkflowState {
  return {
    createdAt: 1_000,
    id: workflowId,
    input: undefined,
    status,
    type: 'workflow',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
  };
}

describe('sleep timer durable acknowledgements', () => {
  it('waits through the matching sleep checkpoint and settles on later durable progress', async () => {
    const internals = createInternals();
    const acknowledgement = createSleepTimerAcknowledgement(
      internals,
      'workflow',
      'workflow:0',
      1_000,
    );
    let settled = false;
    void acknowledgement.promise.then(() => {
      settled = true;
    });

    recordDurableInlineOperation(internals, 'workflow', {
      type: 'sleep',
      operationId: 'workflow:0',
      duration: 1_000,
      scheduledFireAt: 1_000,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    recordDurableInlineOperation(internals, 'workflow', {
      type: 'wait-signal',
      operationId: 'workflow:1',
      signalName: 'continue',
    });
    await acknowledgement.promise;

    expect(internals.sleepTimerAcknowledgementWaiters.size).toBe(0);
  });

  it('settles a timer superseded by a later deadline for the same replayed sleep', async () => {
    const internals = createInternals();
    const acknowledgement = createSleepTimerAcknowledgement(
      internals,
      'workflow',
      'workflow:0',
      1_000,
    );

    recordDurableInlineOperation(internals, 'workflow', {
      type: 'sleep',
      operationId: 'workflow:0',
      duration: 1_000,
      scheduledFireAt: 2_000,
    });

    await acknowledgement.promise;
    expect(internals.sleepTimerAcknowledgementWaiters.size).toBe(0);
  });

  it('does not let a stale registration overwrite a successor sleep resolver', async () => {
    const internals = createInternals();
    internals.checkpoints = new Map([
      ['workflow', { workflowExecutionToken: 'successor-run' }],
    ]) as never;
    const successor = mock(() => {});
    const stale = mock(() => {});
    internals.sleepResolvers.set('workflow:workflow:0', {
      resolve: successor,
      fireAt: 2_000,
      workflowExecutionToken: 'successor-run',
    });

    const { registerSleepResolver } = await import('./sleep-resolver-registration.ts');
    registerSleepResolver(internals, 'workflow', 'workflow:0', stale, 1_000, 'old-run');

    expect(internals.sleepResolvers.get('workflow:workflow:0')?.resolve).toBe(successor);
  });

  it('lets a successor replace a stale resolver that registered after replacement', async () => {
    const internals = createInternals();
    internals.sleepResolversByWorkflow = new Map();
    internals.checkpoints = new Map([
      ['workflow', { workflowExecutionToken: 'successor-run' }],
    ]) as never;
    const successor = mock(() => {});
    const stale = mock(() => {});
    const { registerSleepResolver } = await import('./sleep-resolver-registration.ts');

    registerSleepResolver(internals, 'workflow', 'workflow:0', stale, 1_000, 'old-run');
    registerSleepResolver(internals, 'workflow', 'workflow:0', successor, 2_000, 'successor-run');

    expect(internals.sleepResolvers.get('workflow:workflow:0')?.resolve).toBe(successor);
  });

  it('collects a stale-generation timer without waking a live successor', async () => {
    const internals = createInternals();
    internals.workflowClaimRegistry = null;
    internals.checkpoints = new Map([
      ['workflow', { workflowExecutionToken: 'successor-run' }],
    ]) as never;
    const successor = mock(() => {});
    internals.sleepResolvers.set('workflow:workflow:0', {
      resolve: successor,
      fireAt: 1_000,
      workflowExecutionToken: 'successor-run',
    });

    await handleSleepTimerWithAcknowledgement(
      internals,
      {
        id: 'sleep:workflow:0',
        workflowId: 'workflow',
        fireAt: 2_000,
        kind: 'sleep',
        workflowExecutionToken: 'old-run',
      },
      async () => createWorkflowState('workflow', 'running'),
    );

    expect(successor).not.toHaveBeenCalled();
    expect(internals.sleepResolvers.get('workflow:workflow:0')?.resolve).toBe(successor);
  });

  it('cancels acknowledgement when an earlier timer cannot resolve the live sleep', async () => {
    const internals = createInternals();
    internals.workflowClaimRegistry = null;
    internals.inlineStrategy = {} as EngineInternals['inlineStrategy'];
    const liveResolver = mock(() => {});
    internals.sleepResolvers.set('workflow:workflow:0', {
      resolve: liveResolver,
      fireAt: 2_000,
    });

    await handleSleepTimerWithAcknowledgement(
      internals,
      { id: 'sleep:workflow:0', workflowId: 'workflow', fireAt: 1_000, kind: 'sleep' },
      async () => createWorkflowState('workflow', 'running'),
    );

    expect(liveResolver).not.toHaveBeenCalled();
    expect(internals.sleepResolvers.get('workflow:workflow:0')?.resolve).toBe(liveResolver);
    expect(internals.sleepTimerAcknowledgementWaiters.size).toBe(0);
  });

  it('replaces an old early-fire marker when the successor timer has the same deadline', () => {
    const internals = createInternals();
    internals.sleepTimersFiredWithoutResolver = new Map();
    internals.sleepTimerTokensFiredWithoutResolver = new Map();
    internals.checkpoints = new Map([
      ['workflow', { workflowExecutionToken: 'successor-run' }],
    ]) as never;
    const timer = {
      id: 'sleep:workflow:0',
      workflowId: 'workflow',
      fireAt: 2_000,
      kind: 'sleep' as const,
    };

    expect(resolveSleepTimer(internals, { ...timer, workflowExecutionToken: 'old-run' })).toBe(
      true,
    );
    expect(
      resolveSleepTimer(internals, { ...timer, workflowExecutionToken: 'successor-run' }),
    ).toBe(true);
    expect(
      resolveSleepTimer(internals, {
        ...timer,
        fireAt: 3_000,
        workflowExecutionToken: 'old-run',
      }),
    ).toBe(true);

    expect(internals.sleepTimersFiredWithoutResolver.get('workflow')?.get('workflow:0')).toBe(
      2_000,
    );
    expect(internals.sleepTimerTokensFiredWithoutResolver.get('workflow')?.get('workflow:0')).toBe(
      'successor-run',
    );
  });

  it('clears side effects staged by a replaced execution generation', () => {
    const internals = createInternals();
    stageAtomicWorkflowCommitSideEffects(internals, 'workflow', {
      conditions: [],
      operations: [{ type: 'delete', key: 'signal:old' }],
    });
    internals.durableInlineOperations.set('workflow', {
      operationId: 'old-operation',
      type: 'wait-signal',
      workflowExecutionToken: 'old-run',
    });
    internals.checkpoints = new Map([
      ['workflow', { workflowExecutionToken: 'successor-run' }],
    ]) as never;

    recordDurableInlineOperation(internals, 'workflow', {
      type: 'wait-signal',
      operationId: 'successor-operation',
      signalName: 'release',
    });

    expect(internals.pendingAtomicWorkflowCommitSideEffects.has('workflow')).toBe(false);
  });

  it('settles only acknowledgements older than the current sleep deadline', async () => {
    const internals = createInternals();
    const older = createSleepTimerAcknowledgement(internals, 'workflow', 'workflow:0', 1_000);
    const current = createSleepTimerAcknowledgement(internals, 'workflow', 'workflow:0', 2_000);

    acknowledgeSupersededSleepTimers(internals, 'workflow', 2_000);

    await older.promise;
    expect(internals.sleepTimerAcknowledgementWaiters.get('workflow')?.size).toBe(1);
    current.cancel();
  });

  it('resolves all pending acknowledgements after terminal progress', async () => {
    const internals = createInternals();
    const acknowledgement = createSleepTimerAcknowledgement(
      internals,
      'workflow',
      'workflow:0',
      1_000,
    );

    settleSleepTimerAcknowledgements(internals, 'workflow', 'terminal');

    await acknowledgement.promise;
    expect(internals.sleepTimerAcknowledgementWaiters.size).toBe(0);
  });

  it('rejects one workflow or every workflow without stranding waiters', async () => {
    const internals = createInternals();
    const first = createSleepTimerAcknowledgement(internals, 'first', 'first:0', 1_000);
    rejectSleepTimerAcknowledgements(internals, 'first', 'checkpoint failed');
    expect(await throwingRejectionOf(first.promise)).toThrow('checkpoint failed');

    const second = createSleepTimerAcknowledgement(internals, 'second', 'second:0', 2_000);
    const third = createSleepTimerAcknowledgement(internals, 'third', 'third:0', 3_000);
    const disposalError = new Error('engine disposed');
    rejectAllSleepTimerAcknowledgements(internals, disposalError);

    expect(await rejectionOf(second.promise)).toBe(disposalError);
    expect(await rejectionOf(third.promise)).toBe(disposalError);
    expect(internals.sleepTimerAcknowledgementWaiters.size).toBe(0);
  });
});

describe('handleSleepTimerWithAcknowledgement: ADR 0002 "sleep" wake kind ownership check', () => {
  it('retains a fired timer for a still-live workflow this engine holds no tracked claim for', async () => {
    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      ownership: 'workflow-lease',
      workflows: {},
    });
    const internals = getInternals(engine);
    // The workflow-lease bootstrap installs a registry, but this engine never
    // acquired a claim for this particular workflow id.
    expect(internals.workflowClaimRegistry).not.toBeNull();

    const loadWorkflowState = async (): Promise<WorkflowState> =>
      createWorkflowState('wf-unowned', 'running');

    // A non-owner discard for a live workflow must throw the RETAIN error —
    // never `shouldIgnoreUnclaimedSleepTimer`'s unrelated "fired before
    // ready" error, which only guards a same-engine registration race. This
    // proves the ownership check runs, and decides discard-vs-proceed,
    // BEFORE that unclaimed-timer logic ever sees this fire.
    expect(
      await throwingRejectionOf(
        handleSleepTimerWithAcknowledgement(
          internals,
          { id: 'sleep:wf-unowned:0', workflowId: 'wf-unowned', fireAt: 0, kind: 'sleep' },
          loadWorkflowState,
        ),
      ),
    ).toThrow(/retaining it in storage for the true owner/);
  });

  it('collects a fired timer for a workflow this engine holds no tracked claim for and that no longer exists', async () => {
    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      ownership: 'workflow-lease',
      workflows: {},
    });
    const internals = getInternals(engine);

    const loadWorkflowState = async (): Promise<null> => null;

    expect(
      await handleSleepTimerWithAcknowledgement(
        internals,
        { id: 'sleep:wf-gone:0', workflowId: 'wf-gone', fireAt: 0, kind: 'sleep' },
        loadWorkflowState,
      ),
    ).toBeUndefined();
  });

  it('collects a fired timer for a terminal workflow this engine holds no tracked claim for', async () => {
    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      ownership: 'workflow-lease',
      workflows: {},
    });
    const internals = getInternals(engine);

    const loadWorkflowState = async (): Promise<WorkflowState> =>
      createWorkflowState('wf-done', 'completed');

    expect(
      await handleSleepTimerWithAcknowledgement(
        internals,
        { id: 'sleep:wf-done:0', workflowId: 'wf-done', fireAt: 0, kind: 'sleep' },
        loadWorkflowState,
      ),
    ).toBeUndefined();
  });
});

describe('resolveDiscardedTimerDisposition', () => {
  it('collects when the workflow record is gone', async () => {
    const disposition = await resolveDiscardedTimerDisposition('wf-gone', async () => null);
    expect(disposition).toBe('collect');
  });

  it.each(['completed', 'failed', 'cancelled', 'timed-out'] as const)(
    'collects when the workflow is terminal (%s)',
    async (status) => {
      const disposition = await resolveDiscardedTimerDisposition('wf-terminal', async () =>
        createWorkflowState('wf-terminal', status),
      );
      expect(disposition).toBe('collect');
    },
  );

  it('collects when the workflow is suspended', async () => {
    const disposition = await resolveDiscardedTimerDisposition('wf-suspended', async () =>
      createWorkflowState('wf-suspended', 'suspended'),
    );
    expect(disposition).toBe('collect');
  });

  it.each(['pending', 'running'] as const)(
    'retains when the workflow is still live (%s)',
    async (status) => {
      const disposition = await resolveDiscardedTimerDisposition('wf-live', async () =>
        createWorkflowState('wf-live', status),
      );
      expect(disposition).toBe('retain');
    },
  );
});

describe('retainDiscardedDurableTimer', () => {
  it('resolves without throwing when the disposition is collect', async () => {
    expect(
      await retainDiscardedDurableTimer('sleep:wf-gone:0', 'wf-gone', async () => null),
    ).toBeUndefined();
  });

  it('throws a descriptive error naming the timer and workflow when the disposition is retain', async () => {
    expect(
      await throwingRejectionOf(
        retainDiscardedDurableTimer('sleep:wf-live:0', 'wf-live', async () =>
          createWorkflowState('wf-live', 'running'),
        ),
      ),
    ).toThrow(/sleep:wf-live:0.*wf-live/s);
  });
});

describe('handleSleepTimerWithAcknowledgement + Scheduler: WFT-79 finding 2 regression (two real engines, one durable store)', () => {
  const sharedSleepWorkflow = workflow({ name: 'wft-79-shared-sleep' }).execute(async function* (
    ctx: WorkflowContext,
  ) {
    yield* ctx.sleep('5m');
    return 'woke';
  });
  type SharedSleepWorkflows = { 'wft-79-shared-sleep': typeof sharedSleepWorkflow };
  const sharedSleepWorkflows: SharedSleepWorkflows = {
    'wft-79-shared-sleep': sharedSleepWorkflow,
  };

  async function createSharedStoreEngine(storage: MemoryStorage, getNow: () => number) {
    // `backgroundTasks: 'manual'` + `startScheduler: false`: this test drives
    // the Scheduler by hand (`.scheduler.tick(now)`) so it can observe the
    // durable timer key between a non-owner's discard and the true owner's
    // real wake, deterministically, with no background interval racing it.
    return Engine.create({
      storage,
      workflows: sharedSleepWorkflows,
      ownership: 'workflow-lease',
      getNow,
      backgroundTasks: 'manual',
      startScheduler: false,
    });
  }

  async function countSleepTimerIndexKeys(storage: MemoryStorage): Promise<number> {
    let count = 0;
    for await (const [_key] of storage.scan('timer-idx:sleep:')) count += 1;
    return count;
  }

  it('a non-owner engine scanning the same expired sleep timer retains the durable key; the true owner still wakes and deletes it', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;

    await using owner = await createSharedStoreEngine(storage, () => now);
    await using nonOwner = await createSharedStoreEngine(storage, () => now);

    const handle = await owner.start('wft-79-shared-sleep', null);
    await sleepForTesting(10);
    expect(await owner.get(handle.id).then((state) => state?.status)).toBe('running');
    expect(await countSleepTimerIndexKeys(storage)).toBe(1);

    now += 5 * 60 * 1000 + 1;

    // `nonOwner` never acquired a claim for this workflow id, but its OWN
    // Scheduler independently discovers the same durable timer — durable
    // timers fire globally, scanned by every engine sharing the store, not
    // only the workflow's owner (see the module doc comment above). Its
    // discard must NOT delete the timer `owner` still needs to wake.
    await nonOwner.scheduler.tick(now);

    expect(await owner.get(handle.id).then((state) => state?.status)).toBe('running');
    expect(await countSleepTimerIndexKeys(storage)).toBe(1);

    // The true owner's own copy of this same fire performs the real wake —
    // and, this time, actually deletes the durable timer key.
    await owner.scheduler.tick(now);
    expect(await handle.result()).toBe('woke');
    expect(await countSleepTimerIndexKeys(storage)).toBe(0);
  });

  it('collects (never retries forever) a leftover sleep timer once its workflow has gone terminal', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;

    await using owner = await createSharedStoreEngine(storage, () => now);

    const handle = await owner.start('wft-79-shared-sleep', null);
    await sleepForTesting(10);
    expect(await countSleepTimerIndexKeys(storage)).toBe(1);

    // Cancel BEFORE the sleep deadline: an intentionally external terminal
    // transition (ADR 0002) that rotates the claim epoch and deletes the
    // holder record, but leaves the still-unfired durable sleep timer key
    // behind — resolveSleepTimer's own module doc documents that a durable
    // sleep timer OUTLIVES terminal cleanup.
    await owner.cancel(handle.id);
    expect(await owner.get(handle.id).then((state) => state?.status)).toBe('cancelled');
    expect(await countSleepTimerIndexKeys(storage)).toBe(1);

    now += 5 * 60 * 1000 + 1;

    // No claim exists for this now-terminal workflow (the cancel rotated the
    // epoch this engine's own registry cached), so the fire discards. It must
    // still be COLLECTED here — never retried forever — or this regresses
    // into the exact immortal-timer hazard the retain fix must not reintroduce.
    await owner.scheduler.tick(now);
    expect(await countSleepTimerIndexKeys(storage)).toBe(0);
  });
});
