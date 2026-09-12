/**
 * Engine-level integration tests for WFT-15/16: every execution entry point
 * that can launch or resume a workflow awaits dynamic-source resolution for
 * a lazy type, and never touches a lazy source it did not ask for. Uses a
 * real `Engine` + `MemoryStorage` throughout — the point of this file is to
 * prove the WIRING, not just the underlying primitive (already covered by
 * `source-resolution.test.ts` / `dynamic-source-execution.test.ts`).
 */
import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { decode } from '../codec.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import type { TimerEntry, WorkflowContext, WorkflowDefinition, WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';

async function revisionFor(definition: WorkflowDefinition): Promise<string> {
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  const manifest = await buildWorkflowManifestFromDefinition(
    registered,
    new ActivityRegistry().listDefinitions(),
  );
  return manifest.revision;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: WorkflowState['status'],
): Promise<WorkflowState> {
  let matched: WorkflowState | null = null;
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      if (state?.status === status) {
        matched = state;
        return true;
      }
      return false;
    },
    { label: `workflow "${workflowId}" to reach ${status}`, intervalMs: 5 },
  );
  if (matched === null) throw new Error(`"${workflowId}" never reached ${status}`);
  return matched;
}

/** Read back the durably persisted delayed-start `TimerEntry` for `workflowId`. */
async function findDelayedStartTimerEntry(
  storage: MemoryStorage,
  workflowId: string,
): Promise<TimerEntry> {
  for await (const [, value] of storage.scan('wf-delayed:')) {
    const entry = decode(value) as TimerEntry;
    if (entry.workflowId === workflowId) return entry;
  }
  throw new Error(`no delayed-start timer entry found for "${workflowId}"`);
}

describe('dynamic workflow sources — engine integration (WFT-15/16)', () => {
  it('runs a lazy-registered workflow end to end via engine.start()', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const lazy = workflow({ name: 'lazy-echo' }).execute(async function* (
      _ctx: WorkflowContext,
      input: { value: string },
    ) {
      return input.value;
    });
    const revision = await revisionFor(lazy as WorkflowDefinition);
    engine.registerSource(
      workflowSource(
        { name: 'lazy-echo', location: './lazy-echo.ts', exportName: 'lazyEcho', revision },
        async () => ({ lazyEcho: lazy }),
      ),
    );

    const handle = await engine.start('lazy-echo', { value: 'hi' }, { id: 'lazy-echo-1' });
    const result = await handle.result();

    expect(result).toBe('hi');
  });

  it('starting an eager workflow never imports a differently-named lazy source (headline acceptance criterion)', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const eager = workflow({ name: 'eager-echo' }).execute(async function* (
      _ctx: WorkflowContext,
      input: { value: string },
    ) {
      return input.value;
    });
    engine.register(eager);

    const lazy = workflow({ name: 'lazy-untouched' }).execute(async function* () {
      return 'should never run';
    });
    const revision = await revisionFor(lazy);
    const lazyLoader = mock(async () => ({ lazyUntouched: lazy }));
    engine.registerSource(
      workflowSource(
        { name: 'lazy-untouched', location: './lazy.ts', exportName: 'lazyUntouched', revision },
        lazyLoader,
      ),
    );

    const handle = await engine.start('eager-echo', { value: 'ok' }, { id: 'eager-echo-1' });
    await handle.result();

    expect(lazyLoader).not.toHaveBeenCalled();
  });

  it('two concurrent engine.start() calls for the same lazy type/revision invoke the loader exactly once', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const lazy = workflow({ name: 'lazy-concurrent' }).execute(async function* () {
      return 'done';
    });
    const revision = await revisionFor(lazy);
    const loader = mock(async () => ({ lazyConcurrent: lazy }));
    engine.registerSource(
      workflowSource(
        { name: 'lazy-concurrent', location: './lazy.ts', exportName: 'lazyConcurrent', revision },
        loader,
      ),
    );

    const [handleA, handleB] = await Promise.all([
      engine.start('lazy-concurrent', null, { id: 'concurrent-a' }),
      engine.start('lazy-concurrent', null, { id: 'concurrent-b' }),
    ]);
    await Promise.all([handleA.result(), handleB.result()]);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a cancelled resolveWorkflowSource() waiter racing a concurrent start() does not abort the load start() still needs', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const lazy = workflow({ name: 'lazy-race' }).execute(async function* () {
      return 'survived';
    });
    const revision = await revisionFor(lazy);
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    const loader = mock(() => deferred.promise);
    engine.registerSource(
      workflowSource(
        { name: 'lazy-race', location: './lazy.ts', exportName: 'lazyRace', revision },
        loader,
      ),
    );

    const controller = new AbortController();
    const abortingWaiter = engine.resolveWorkflowSource('lazy-race', revision, {
      signal: controller.signal,
    });
    const startPromise = engine.start('lazy-race', null, { id: 'lazy-race-1' });

    for (let iteration = 0; iteration < 50 && loader.mock.calls.length === 0; iteration += 1) {
      await Promise.resolve();
    }
    expect(loader).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(abortingWaiter).rejects.toBeTruthy();

    // The shared load must still be alive for `start()`.
    deferred.resolve({ lazyRace: lazy });
    const handle = await startPromise;
    const result = await handle.result();

    expect(result).toBe('survived');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('runs a lazy-registered workflow via engine.startOrSignal()', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const lazy = workflow({ name: 'lazy-signal-target' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const signalPayload = yield* ctx.waitForSignal('continue');
      return signalPayload;
    });
    const revision = await revisionFor(lazy);
    engine.registerSource(
      workflowSource(
        {
          name: 'lazy-signal-target',
          location: './lazy.ts',
          exportName: 'lazySignalTarget',
          revision,
        },
        async () => ({ lazySignalTarget: lazy }),
      ),
    );

    const { handle } = await engine.startOrSignal(
      'lazy-signal-target',
      null,
      { name: 'continue', payload: 'signalled-in', signalId: 'sig-lazy-signal-1' },
      { id: 'lazy-signal-1' },
    );
    const result = await handle.result();

    expect(result).toBe('signalled-in');
  });

  it('engine.schedule() on a lazy type invokes the loader once at create time, not deferred to first fire', async () => {
    const storage = new MemoryStorage();
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    await using engine = new Engine({ storage, getNow: () => clock.now });
    const lazy = workflow({ name: 'lazy-scheduled' }).execute(async function* () {
      return 'fired';
    });
    const revision = await revisionFor(lazy);
    const loader = mock(async () => ({ lazyScheduled: lazy }));
    engine.registerSource(
      workflowSource(
        { name: 'lazy-scheduled', location: './lazy.ts', exportName: 'lazyScheduled', revision },
        loader,
      ),
    );

    const scheduleHandle = await engine.schedule(
      'lazy-scheduled',
      null,
      { every: '5m' },
      {
        id: 'lazy-schedule-1',
      },
    );
    expect(loader).toHaveBeenCalledTimes(1);

    const summary = await scheduleHandle.describe();
    if (summary?.nextFireAt == null) throw new Error('schedule has no next fire time');
    clock.now = summary.nextFireAt;
    await engine.scheduler.tick(clock.now);

    await waitForCondition(
      async () => {
        const runs = await engine.list({ status: 'completed' });
        return runs.items.some((item) => item.type === 'lazy-scheduled');
      },
      { label: 'scheduled lazy run to complete', intervalMs: 5 },
    );

    // Cached — the schedule fire must not re-invoke the loader.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('engine.fork() of a completed lazy-type run re-resolves from a fresh engine instance', async () => {
    const storage = new MemoryStorage();
    const lazy = workflow({ name: 'lazy-forkable' }).execute(async function* (
      _ctx: WorkflowContext,
      input: { n: number },
    ) {
      return input.n * 2;
    });
    const revision = await revisionFor(lazy as WorkflowDefinition);

    const engineA = new Engine({ storage });
    engineA.registerSource(
      workflowSource(
        { name: 'lazy-forkable', location: './lazy.ts', exportName: 'lazyForkable', revision },
        async () => ({ lazyForkable: lazy }),
      ),
    );
    const originalHandle = await engineA.start(
      'lazy-forkable',
      { n: 5 },
      { id: 'lazy-forkable-1' },
    );
    await originalHandle.result();
    engineA[Symbol.dispose]();

    // Fresh process: only `registerSource()` was called, nothing resolved locally yet.
    await using engineB = new Engine({ storage });
    const loaderB = mock(async () => ({ lazyForkable: lazy }));
    engineB.registerSource(
      workflowSource(
        { name: 'lazy-forkable', location: './lazy.ts', exportName: 'lazyForkable', revision },
        loaderB,
      ),
    );

    const forkedHandle = await engineB.fork('lazy-forkable-1');
    const result = await forkedHandle.result();

    expect(result).toBe(10);
    expect(loaderB).toHaveBeenCalledTimes(1);
  });

  it("engine.start({ startAt }) on a lazy type resolves once immediately, matching schedule()'s eager-resolve-at-creation contract", async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const lazy = workflow({ name: 'lazy-delayed' }).execute(async function* () {
      return 'delayed-done';
    });
    const revision = await revisionFor(lazy);
    const loader = mock(async () => ({ lazyDelayed: lazy }));
    engine.registerSource(
      workflowSource(
        { name: 'lazy-delayed', location: './lazy.ts', exportName: 'lazyDelayed', revision },
        loader,
      ),
    );

    const workflowId = 'lazy-delayed-1';
    await engine.start('lazy-delayed', null, { id: workflowId, startAt: Date.now() + 60_000 });
    expect(loader).toHaveBeenCalledTimes(1);

    const timerEntry = await findDelayedStartTimerEntry(storage, workflowId);
    await engine.fireTimer(timerEntry);
    await waitForStatus(engine, workflowId, 'completed');

    // Cached at creation time — firing the timer does not re-invoke it.
    expect(loader).toHaveBeenCalledTimes(1);
    const handle = engine.getHandle(workflowId);
    expect(await handle.result()).toBe('delayed-done');
  });

  it("a delayed-start timer that fires in a FRESH process resolves via operations-time.ts's own startDelayedWorkflow wiring", async () => {
    const storage = new MemoryStorage();
    const lazy = workflow({ name: 'lazy-delayed-cross-process' }).execute(async function* () {
      return 'delayed-done';
    });
    const revision = await revisionFor(lazy);
    const workflowId = 'lazy-delayed-cross-process-1';

    // engineA durably creates the delayed-start timer. Its own creation-time
    // resolve installs the revision durably, but that says nothing about
    // whether a DIFFERENT, fresh process can independently resolve it again
    // at fire time — which is exactly what this test pins.
    const engineA = new Engine({ storage, backgroundTasks: 'manual' });
    engineA.registerSource(
      workflowSource(
        {
          name: 'lazy-delayed-cross-process',
          location: './lazy.ts',
          exportName: 'lazyDelayedCrossProcess',
          revision,
        },
        async () => ({ lazyDelayedCrossProcess: lazy }),
      ),
    );
    await engineA.start('lazy-delayed-cross-process', null, {
      id: workflowId,
      startAt: Date.now() + 60_000,
    });
    const timerEntry = await findDelayedStartTimerEntry(storage, workflowId);
    engineA[Symbol.dispose]();

    await using engineB = new Engine({ storage, backgroundTasks: 'manual' });
    const loaderB = mock(async () => ({ lazyDelayedCrossProcess: lazy }));
    engineB.registerSource(
      workflowSource(
        {
          name: 'lazy-delayed-cross-process',
          location: './lazy.ts',
          exportName: 'lazyDelayedCrossProcess',
          revision,
        },
        loaderB,
      ),
    );

    await engineB.fireTimer(timerEntry);
    await waitForStatus(engineB, workflowId, 'completed');

    expect(loaderB).toHaveBeenCalledTimes(1);
    const handle = engineB.getHandle(workflowId);
    expect(await handle.result()).toBe('delayed-done');
  });

  it('bulk-retry-failed on a lazy-type failed run re-resolves from a fresh engine instance before relaunching', async () => {
    const storage = new MemoryStorage();
    // Fails its first attempt, succeeds on retry — driven by a closure flag
    // (shared by BOTH engines below, since it's the same `lazy` reference,
    // mirroring `bulk-retry-failed.test.ts`'s own `shouldFailAfterCheckpoint`
    // precedent) rather than input, so checkpoint-replay determinism holds.
    let shouldFail = true;
    const lazy = workflow({ name: 'lazy-retry' }).execute(async function* () {
      if (shouldFail) throw new Error('first attempt fails');
      return 'retried-ok';
    });
    const revision = await revisionFor(lazy);

    const engineA = new Engine({ storage });
    engineA.registerSource(
      workflowSource(
        { name: 'lazy-retry', location: './lazy.ts', exportName: 'lazyRetry', revision },
        async () => ({ lazyRetry: lazy }),
      ),
    );
    const workflowId = 'lazy-retry-1';
    const originalHandle = await engineA.start('lazy-retry', null, {
      id: workflowId,
      tags: ['lazy-retry-batch'],
    });
    await expect(originalHandle.result()).rejects.toBeTruthy();
    engineA[Symbol.dispose]();

    await using engineB = new Engine({ storage });
    const loaderB = mock(async () => ({ lazyRetry: lazy }));
    engineB.registerSource(
      workflowSource(
        { name: 'lazy-retry', location: './lazy.ts', exportName: 'lazyRetry', revision },
        loaderB,
      ),
    );

    shouldFail = false;
    const result = await engineB.retryFailedAll({ tags: ['lazy-retry-batch'] });
    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
    expect(loaderB).toHaveBeenCalledTimes(1);
    await waitForStatus(engineB, workflowId, 'completed');
  });

  it('two concurrent ctx.startChild() calls of a lazy type in the same tick each get correct, non-swapped parentWorkflowId', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const lazyChild = workflow({ name: 'lazy-child' }).execute(async function* () {
      return 'child-done';
    });
    const revision = await revisionFor(lazyChild);
    engine.registerSource(
      workflowSource(
        { name: 'lazy-child', location: './lazy.ts', exportName: 'lazyChild', revision },
        async () => ({ lazyChild }),
      ),
    );

    // Warm the catalog first (a real `ctx.startChild()` call only ever
    // happens from within an already-running workflow, i.e. strictly after
    // the engine's own catalog-readiness gate has already resolved once —
    // `engine.start()`'s own leading `await ensureWorkflowCatalogReady()`
    // check is a pre-existing, unrelated await this test must not trip, or
    // it stops isolating the ONE await this test targets).
    engine.register(
      workflow({ name: 'catalog-warmup' }).execute(async function* () {
        return 'warm';
      }),
    );
    const warmupHandle = await engine.start('catalog-warmup', null);
    await warmupHandle.result();

    // Directly drives the exact mechanism `start.ts`'s reordering fix
    // protects: `internals.pendingParentWorkflowId` is set synchronously by
    // `ctx.startChild()` immediately before its own `startWorkflow()` call.
    // Two back-to-back synchronous `engine.start()` calls, each preceded by
    // setting a different pending parent id, must each capture their OWN
    // value — this only holds if `prepareStartWorkflow()`'s synchronous
    // capture runs before `startWorkflow()`'s new dynamic-source-resolution
    // `await`, not after it.
    const internals = getInternals(engine);
    internals.pendingParentWorkflowId = 'parent-a';
    const startA = engine.start('lazy-child', null, { id: 'lazy-child-a' });
    internals.pendingParentWorkflowId = 'parent-b';
    const startB = engine.start('lazy-child', null, { id: 'lazy-child-b' });

    await Promise.all([startA, startB]);

    const stateA = await engine.get('lazy-child-a');
    const stateB = await engine.get('lazy-child-b');

    expect(stateA?.parentWorkflowId).toBe('parent-a');
    expect(stateB?.parentWorkflowId).toBe('parent-b');
  });
});
