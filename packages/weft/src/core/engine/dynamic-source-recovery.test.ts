/**
 * `recoverAll()`'s dynamic-source preload barrier (WFT-15/16): every
 * distinct lazy type referenced by non-terminal state is preloaded ONCE,
 * before any of its runs' generators advance; a type whose load fails is
 * classified `unavailable` and only its own runs fail — sibling types
 * recover normally. Mirrors `version-mismatch-recovery.test.ts`'s
 * two-workflow sibling-isolation pattern.
 */
import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { encode } from '../codec.ts';
import { WorkflowRecoverySkippedEvent } from '../events.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowContext, type WorkflowDefinition } from '../types.ts';
import { DEFAULT_WORKFLOW_VERSION } from '../versioning.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { WorkflowTypeNotRegisteredForRecoveryError } from './errors.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';

async function waitForCheckpoint(storage: MemoryStorage, workflowId: string): Promise<void> {
  await waitForCondition(async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null, {
    label: `checkpoint for ${workflowId}`,
  });
}

/**
 * Directly write a `running` `WorkflowState` for `workflowType` into
 * storage, bypassing `engine.start()` — which would itself reject an
 * unregistered type before ever reaching storage. Mirrors
 * `crash-recovery.test.ts`'s `seedStoredWorkflowState` helper, used to
 * manufacture the "genuinely unregistered type present in storage" case
 * `recoverAll()`'s preflight classifies `missing`.
 */
async function seedRunningWorkflowState(
  storage: MemoryStorage,
  workflowId: string,
  workflowType: string,
): Promise<void> {
  await storage.put(
    KEYS.workflow(workflowId),
    encode({
      id: workflowId,
      type: workflowType,
      status: 'running',
      input: null,
      versionTuple: { workflowVersion: DEFAULT_WORKFLOW_VERSION },
      createdAt: 1,
      updatedAt: 1,
    }),
  );
}

async function revisionFor(definition: WorkflowDefinition): Promise<string> {
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  const manifest = await buildWorkflowManifestFromDefinition(
    registered,
    new ActivityRegistry().listDefinitions(),
  );
  return manifest.revision;
}

describe('recoverAll() — dynamic-source preload barrier (WFT-15/16)', () => {
  it('preloads a lazy type ONCE for N non-terminal runs, before any of their generators advance', async () => {
    const storage = new MemoryStorage();
    const started: string[] = [];
    const lazy = workflow({ name: 'lazy-barrier' }).execute(async function* (ctx: WorkflowContext) {
      started.push(ctx.workflowId);
      const value = yield* ctx.waitForSignal<string>('continue');
      return `resumed:${value}`;
    });

    {
      const original = new Engine({ storage });
      original.register(lazy);
      await original.start('lazy-barrier', null, { id: 'barrier-1' });
      await original.start('lazy-barrier', null, { id: 'barrier-2' });
      await original.start('lazy-barrier', null, { id: 'barrier-3' });
      await waitForCheckpoint(storage, 'barrier-1');
      await waitForCheckpoint(storage, 'barrier-2');
      await waitForCheckpoint(storage, 'barrier-3');
      original[Symbol.dispose]();
    }
    started.length = 0;

    const revision = await revisionFor(lazy as WorkflowDefinition);

    await using recovered = new Engine({ storage });
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    const loader = mock(() => deferred.promise);
    recovered.registerSource(
      workflowSource(
        { name: 'lazy-barrier', location: './lazy.ts', exportName: 'lazyBarrier', revision },
        loader,
      ),
    );

    const recoverPromise = recovered.recoverAll();

    // `recoverAll()` has a longer async setup chain (ownership bootstrap,
    // lease acquire, catalog readiness, orphan recovery, THEN the storage
    // scan) than a plain `start()` call — a fixed microtask-spin count is
    // not reliably enough hops; poll with real timer-based waits instead.
    await waitForCondition(async () => loader.mock.calls.length > 0, {
      label: 'lazy-barrier loader to be invoked by the recovery preload barrier',
      intervalMs: 5,
    });
    expect(loader).toHaveBeenCalledTimes(1);
    // None of the three runs' generators have advanced yet — the barrier
    // preloads before ANY entry resumes.
    expect(started).toEqual([]);

    deferred.resolve({ lazyBarrier: lazy });
    const handles = await recoverPromise;

    expect(handles.map((handle) => handle.id).toSorted()).toEqual([
      'barrier-1',
      'barrier-2',
      'barrier-3',
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(started.toSorted()).toEqual(['barrier-1', 'barrier-2', 'barrier-3']);

    for (const handle of handles) {
      await handle.signal('continue', 'go');
    }
    for (const handle of handles) {
      expect(await handle.result()).toBe('resumed:go');
    }
  });

  it('classifies a failed-to-load type "unavailable", failing only its own runs — a sibling type recovers normally', async () => {
    const storage = new MemoryStorage();
    const failing = workflow({ name: 'lazy-unavailable' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('continue');
    });
    const working = workflow({ name: 'lazy-working' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('continue');
    });

    {
      await using original = new Engine({ storage });
      original.register(failing);
      original.register(working);
      await original.start('lazy-unavailable', null, { id: 'unavailable-1' });
      await original.start('lazy-working', null, { id: 'working-1' });
      await waitForCheckpoint(storage, 'unavailable-1');
      await waitForCheckpoint(storage, 'working-1');
    }

    const failingRevision = await revisionFor(failing as WorkflowDefinition);
    const workingRevision = await revisionFor(working as WorkflowDefinition);

    await using recovered = new Engine({ storage });
    const failingLoader = mock(async (): Promise<Record<string, unknown>> => {
      throw new Error('module explode');
    });
    recovered.registerSource(
      workflowSource(
        {
          name: 'lazy-unavailable',
          location: './lazy.ts',
          exportName: 'lazyUnavailable',
          revision: failingRevision,
        },
        failingLoader,
      ),
    );
    recovered.registerSource(
      workflowSource(
        {
          name: 'lazy-working',
          location: './lazy.ts',
          exportName: 'lazyWorking',
          revision: workingRevision,
        },
        async () => ({ lazyWorking: working }),
      ),
    );

    const handles = await recovered.recoverAll();

    expect(handles.map((handle) => handle.id)).toEqual(['working-1']);

    const unavailableState = await recovered.get('unavailable-1');
    expect(unavailableState?.status).toBe('failed');
    expect(unavailableState?.failureCategory).toBe('system');
    expect(unavailableState?.error).toContain('failed to load');

    const workingHandle = handles[0]!;
    await workingHandle.signal('continue', 'ok');
    expect(await workingHandle.result()).toBe('ok');
  });

  it('does not route a registered-but-unresolved dynamic source through the "type-not-registered" missing classification', async () => {
    const storage = new MemoryStorage();
    const lazy = workflow({ name: 'lazy-classified' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('continue');
    });

    {
      await using original = new Engine({ storage });
      original.register(lazy);
      await original.start('lazy-classified', null, { id: 'classified-1' });
      await waitForCheckpoint(storage, 'classified-1');
    }

    const revision = await revisionFor(lazy as WorkflowDefinition);

    await using recovered = new Engine({ storage });
    recovered.registerSource(
      workflowSource(
        { name: 'lazy-classified', location: './lazy.ts', exportName: 'lazyClassified', revision },
        async () => ({ lazyClassified: lazy }),
      ),
    );

    const skippedEvents: WorkflowRecoverySkippedEvent[] = [];
    recovered.addEventListener('workflow:recovery-skipped', (event: Event) => {
      skippedEvents.push(event as WorkflowRecoverySkippedEvent);
    });

    // No `acknowledgeUnknownWorkflowTypes` — a genuine "missing" entry would
    // throw `WorkflowTypeNotRegisteredForRecoveryError` here. A registered
    // (even if not yet resolved) dynamic source must not trip this at all.
    const handles = await recovered.recoverAll().catch((error: unknown) => {
      throw error instanceof WorkflowTypeNotRegisteredForRecoveryError
        ? new Error('recoverAll() incorrectly treated a registered dynamic source as missing')
        : error;
    });

    expect(skippedEvents).toEqual([]);
    expect(handles.map((handle) => handle.id)).toEqual(['classified-1']);
  });

  it('WorkflowTypeNotRegisteredForRecoveryError.registeredTypes includes a registered-but-unresolved dynamic source', async () => {
    const storage = new MemoryStorage();
    const lazy = workflow({ name: 'lazy-listed' }).execute(async function* (ctx: WorkflowContext) {
      return yield* ctx.waitForSignal<string>('continue');
    });

    {
      await using original = new Engine({ storage });
      original.register(lazy);
      await original.start('lazy-listed', null, { id: 'listed-1' });
      await waitForCheckpoint(storage, 'listed-1');
    }
    // A genuinely unregistered type, present in storage but registered on
    // neither engine — forces `recoverAll()` down the
    // `WorkflowTypeNotRegisteredForRecoveryError` throwing path so its
    // `registeredTypes` field is observable. Seeded directly (not via
    // `engine.start()`, which would itself reject an unregistered type).
    await seedRunningWorkflowState(storage, 'unknown-1', 'totally-unknown');

    const revision = await revisionFor(lazy as WorkflowDefinition);

    await using recovered = new Engine({ storage });
    recovered.registerSource(
      workflowSource(
        { name: 'lazy-listed', location: './lazy.ts', exportName: 'lazyListed', revision },
        async () => ({ lazyListed: lazy }),
      ),
    );

    const error = await recovered
      .recoverAll()
      .then(() => {
        throw new Error('expected WorkflowTypeNotRegisteredForRecoveryError');
      })
      .catch((caught: unknown) => {
        if (!(caught instanceof WorkflowTypeNotRegisteredForRecoveryError)) throw caught;
        return caught;
      });

    // The dynamic source is registered (even though not yet resolved) —
    // it must appear in the "what IS registered" list a mixed-batch error
    // reports, not just eagerly `engine.register()`-ed types.
    expect(error.registeredTypes).toContain('lazy-listed');
    expect(error.missingTypes).toEqual(['totally-unknown']);
  });

  it('engine.resume(id) on a single lazy-type workflow triggers resolution', async () => {
    const storage = new MemoryStorage();
    const lazy = workflow({ name: 'lazy-resume-target' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const value = yield* ctx.waitForSignal<string>('continue');
      return `resumed:${value}`;
    });

    {
      await using original = new Engine({ storage });
      original.register(lazy);
      await original.start('lazy-resume-target', null, { id: 'resume-target-1' });
      await waitForCheckpoint(storage, 'resume-target-1');
    }

    const revision = await revisionFor(lazy as WorkflowDefinition);

    await using engine = new Engine({ storage });
    const loader = mock(async () => ({ lazyResumeTarget: lazy }));
    engine.registerSource(
      workflowSource(
        {
          name: 'lazy-resume-target',
          location: './lazy.ts',
          exportName: 'lazyResumeTarget',
          revision,
        },
        loader,
      ),
    );

    const handle = await engine.resume('resume-target-1');
    expect(loader).toHaveBeenCalledTimes(1);

    await handle.signal('continue', 'resumed-value');
    expect(await handle.result()).toBe('resumed:resumed-value');
  });

  it("a concurrent engine.start() for a type mid-recoverAll() batch does not observe the batch's stale classification", async () => {
    // Regression test for a fixed cross-call race: `recoverAll()`'s
    // preload barrier used to publish a failed type's classification into
    // a FIELD on shared `internals.sources`, read by every caller of
    // `resolveExecutableRegistration()` — including a totally unrelated
    // concurrent `engine.start()` for a DIFFERENT run of the same type,
    // not just `recoverAll()`'s own per-entry loop. That let an unrelated
    // `start()` fail immediately on a stale cached error without ever
    // attempting its own fresh resolution, even though the transient
    // failure that produced it may have already cleared. The fix threads
    // the batch's failures through a closure-local wrapper
    // (`createRecoveryScopedCallbacks()`, `transition.ts`) `recoverAll()`
    // passes ONLY to its own per-entry `resume()` calls, so no state is
    // shared with any other caller at all.
    const storage = new MemoryStorage();
    const flaky = workflow({ name: 'lazy-flaky' }).execute(async function* (ctx: WorkflowContext) {
      return yield* ctx.waitForSignal<string>('continue');
    });
    const filler = workflow({ name: 'eager-filler' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('continue');
    });

    {
      await using original = new Engine({ storage });
      original.register(flaky);
      original.register(filler);
      await original.start('lazy-flaky', null, { id: 'flaky-1' });
      await waitForCheckpoint(storage, 'flaky-1');
      // Several eager (no preload needed) recoverable entries give
      // `recoverAll()`'s per-entry loop real async work to do AFTER the
      // barrier settles `lazy-flaky` `unavailable`, so the batch is still
      // in flight when the concurrent `engine.start()` below fires.
      for (let index = 0; index < 20; index += 1) {
        await original.start('eager-filler', null, { id: `filler-${index}` });
        await waitForCheckpoint(storage, `filler-${index}`);
      }
    }

    const flakyRevision = await revisionFor(flaky as WorkflowDefinition);

    await using recovered = new Engine({ storage });
    recovered.register(filler);
    let loaderCalls = 0;
    recovered.registerSource(
      workflowSource(
        {
          name: 'lazy-flaky',
          location: './lazy.ts',
          exportName: 'lazyFlaky',
          revision: flakyRevision,
        },
        async () => {
          loaderCalls += 1;
          // Call 1 is `recoverAll()`'s own barrier preload — fails,
          // classifying `lazy-flaky` `unavailable` for that batch. Every
          // subsequent call (the concurrent `engine.start()` below, and
          // its own retry) succeeds, simulating a transient failure that
          // has already cleared.
          if (loaderCalls === 1) throw new Error('transient loader failure');
          return { lazyFlaky: flaky };
        },
      ),
    );

    const internals = getInternals(recovered);
    const recoverAllPromise = recovered.recoverAll();
    // Fire the concurrent `start()` only once the barrier's OWN load for
    // this exact `(name, revision)` has fully settled and single-flight
    // has cleared it from `resolutionsInFlight` — otherwise both calls
    // would legitimately share the SAME in-flight load (correct
    // single-flight behavior, not the bug this test targets) instead of
    // the concurrent call reaching a fresh `resolveExecutableRegistration()`
    // while `recoverAll()`'s per-entry loop (busy with the 20 filler
    // entries) is still in progress.
    await waitForCondition(
      () =>
        loaderCalls >= 1 &&
        internals.sources.resolutionsInFlight.get('lazy-flaky')?.get(flakyRevision) === undefined,
      { label: 'barrier load for lazy-flaky settled and single-flight cleared' },
    );
    const concurrentStartPromise = recovered.start('lazy-flaky', null, {
      id: 'flaky-concurrent',
    });

    const handles = await recoverAllPromise;
    const concurrentHandle = await concurrentStartPromise;

    // `recoverAll()`'s own batch still correctly fails its own `flaky-1` run.
    expect(handles.some((handle) => handle.id === 'flaky-1')).toBe(false);
    const recoveredFlakyState = await recovered.get('flaky-1');
    expect(recoveredFlakyState?.status).toBe('failed');

    // The concurrent, unrelated `start()` call must NOT have observed the
    // batch's stale cached failure — it gets its own fresh resolution
    // attempt (a second, independent loader invocation), which succeeds.
    expect(loaderCalls).toBeGreaterThanOrEqual(2);
    await concurrentHandle.signal('continue', 'ok');
    expect(await concurrentHandle.result()).toBe('ok');
  });
});
