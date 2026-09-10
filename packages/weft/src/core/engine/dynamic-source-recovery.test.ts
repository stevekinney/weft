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
import { createCheckpoint, serializeCheckpoint } from '../checkpoint.ts';
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
import {
  buildPerWorkflowActivityRegistry,
  buildRegistrationEntry,
  isBuilderWorkflowDefinition,
} from './registration.ts';
import { WorkflowRevisionUnavailableError } from './revision-errors.ts';

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
  revision?: string,
): Promise<void> {
  await storage.put(
    KEYS.workflow(workflowId),
    encode({
      id: workflowId,
      type: workflowType,
      status: 'running',
      input: null,
      versionTuple: { workflowVersion: DEFAULT_WORKFLOW_VERSION },
      ...(revision !== undefined && { revision }),
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  // `resume()` (the non-'missing' path every 'recoverable' preflight entry
  // reaches) always loads a checkpoint — required for every seed except the
  // "genuinely unregistered type" `missing`-classification callers, which
  // never reach that far.
  await storage.put(
    KEYS.checkpoint(workflowId),
    serializeCheckpoint(createCheckpoint(workflowId, DEFAULT_WORKFLOW_VERSION, 1)),
  );
}

async function revisionFor(definition: WorkflowDefinition): Promise<string> {
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  // A builder workflow's `.activities({...})` map is part of its contract —
  // `buildWorkflowManifestFromDefinition` hashes the workflow-scoped activity
  // set alongside the handler contract, so a caller here must feed it the
  // SAME per-workflow activity definitions `registerWorkflowDefinition()`
  // would build (`buildPerWorkflowActivityRegistry`), not an empty registry,
  // or the manifest computed here will not match the one the engine derives
  // when it actually resolves and installs this definition.
  const activityDefinitions = isBuilderWorkflowDefinition(definition)
    ? buildPerWorkflowActivityRegistry(definition.activities).listDefinitions()
    : new ActivityRegistry().listDefinitions();
  const manifest = await buildWorkflowManifestFromDefinition(registered, activityDefinitions);
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

    const revision = await revisionFor(lazy);

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

    const failingRevision = await revisionFor(failing);
    const workingRevision = await revisionFor(working);

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

    const revision = await revisionFor(lazy);

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

    const revision = await revisionFor(lazy);

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

    const revision = await revisionFor(lazy);

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

    const flakyRevision = await revisionFor(flaky);

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

describe('recoverAll() — per-(type, revision) preload barrier and exact revision pinning (WFT-17/WFT-18)', () => {
  it('two non-terminal runs of the same dynamic-source type, pinned to two different registered revisions, both recover against their own pinned code', async () => {
    // The core bug this batch fixes: before WFT-17/WFT-18, EVERY non-terminal
    // run of a dynamic-source type resolved against whichever revision was
    // currently ACTIVE, regardless of which one it actually started on. Two
    // sibling runs pinned to two DIFFERENT revisions must each recover
    // against their OWN code — proven here by each definition returning a
    // distinct, revision-specific value AND by each recovered instance's
    // `ctx.run('whoami')` call resolving its OWN per-workflow `.activities()`
    // implementation, not whichever revision this process resolved last
    // (WFT-19: `activityRegistriesByWorkflow`/`lastResolvedRevisionByName`
    // are keyed by type alone, so this also exercises the resume-time
    // `workflowTypeByWorkflowId` identity population fix — without it, a
    // recovered run's string-named `ctx.run('whoami')` cannot resolve at
    // all, since neither run was ever started in this process via
    // `startWorkflowExecution()`).
    const storage = new MemoryStorage();
    // `deriveWorkflowRevision()` hashes the CONTRACT (name, workflowVersion,
    // description, tags) — not the handler body — so distinct `description`
    // values are what actually give A and B distinct revisions here.
    const definitionA = workflow({ name: 'multi-rev', description: 'candidate A' })
      .activities({ whoami: async () => 'activity-A' })
      .execute(async function* (ctx: WorkflowContext) {
        const value = yield* ctx.waitForSignal<string>('continue');
        const who = yield* ctx.run('whoami');
        return `A:${value}:${String(who)}`;
      });
    const definitionB = workflow({ name: 'multi-rev', description: 'candidate B' })
      .activities({ whoami: async () => 'activity-B' })
      .execute(async function* (ctx: WorkflowContext) {
        const value = yield* ctx.waitForSignal<string>('continue');
        const who = yield* ctx.run('whoami');
        return `B:${value}:${String(who)}`;
      });

    // `workflowSource()`'s declared `revision` is cross-checked against the
    // loaded module's own content-derived revision at resolve time — so
    // each pin below must be the definition's REAL manifest revision, not
    // an arbitrary string, or resolution fails validation
    // (`artifact-revision-mismatch`) before ever reaching this batch's
    // logic under test.
    const revisionA = await revisionFor(definitionA);
    const revisionB = await revisionFor(definitionB);
    await seedRunningWorkflowState(storage, 'multi-rev-a', 'multi-rev', revisionA);
    await seedRunningWorkflowState(storage, 'multi-rev-b', 'multi-rev', revisionB);

    await using recovered = new Engine({ storage });
    recovered.registerSource(
      workflowSource(
        { name: 'multi-rev', location: './a.ts', exportName: 'a', revision: revisionA },
        async () => ({ a: definitionA }),
      ),
    );
    recovered.registerSource(
      workflowSource(
        { name: 'multi-rev', location: './b.ts', exportName: 'b', revision: revisionB },
        async () => ({ b: definitionB }),
      ),
    );

    const handles = await recovered.recoverAll();
    expect(handles.map((handle) => handle.id).toSorted()).toEqual(['multi-rev-a', 'multi-rev-b']);

    const handleA = handles.find((handle) => handle.id === 'multi-rev-a')!;
    const handleB = handles.find((handle) => handle.id === 'multi-rev-b')!;
    await handleA.signal('continue', 'x');
    await handleB.signal('continue', 'y');
    expect(await handleA.result()).toBe('A:x:activity-A');
    expect(await handleB.result()).toBe('B:y:activity-B');
  });

  it('a fork of a dynamic-source run inherits the source run\'s pinned revision, and recovers under it — not "legacy-ambiguous" — even with a second registered candidate present', async () => {
    // Regression test for the fork-revision gap: `createForkedWorkflowState`
    // used to omit `revision` entirely, so a forked child of a
    // dynamic-source type with 2+ registered candidates would recover
    // `legacy-ambiguous` (this describe block's own earlier test) even
    // though the fork continues execution against the exact code its
    // source run resolved. `fork-helpers.ts` now inherits
    // `sourceState.revision` — proven here end to end: start under
    // revision A (with only A registered), fork while running, then boot a
    // FRESH engine with BOTH A and B registered and confirm the forked
    // child recovers under A rather than failing ambiguous.
    const storage = new MemoryStorage();
    const definitionA = workflow({ name: 'fork-multi-rev', description: 'candidate A' }).execute(
      async function* (ctx: WorkflowContext) {
        const value = yield* ctx.waitForSignal<string>('continue');
        return `A:${value}`;
      },
    );
    const definitionB = workflow({ name: 'fork-multi-rev', description: 'candidate B' }).execute(
      async function* () {
        return 'unused';
      },
    );
    const revisionA = await revisionFor(definitionA);
    const revisionB = await revisionFor(definitionB);

    let forkedId: string;
    {
      await using started = new Engine({ storage });
      started.registerSource(
        workflowSource(
          { name: 'fork-multi-rev', location: './a.ts', exportName: 'a', revision: revisionA },
          async () => ({ a: definitionA }),
        ),
      );
      const original = await started.start('fork-multi-rev', null, {
        id: 'fork-multi-rev-source',
      });
      const forked = await started.fork(original.id);
      forkedId = forked.id;

      const sourceState = await started.get(original.id);
      const forkedState = await started.get(forked.id);
      expect(sourceState?.revision).toBe(revisionA);
      expect(forkedState?.revision).toBe(revisionA);
    }

    await using recovered = new Engine({ storage });
    recovered.registerSource(
      workflowSource(
        { name: 'fork-multi-rev', location: './a.ts', exportName: 'a', revision: revisionA },
        async () => ({ a: definitionA }),
      ),
    );
    recovered.registerSource(
      workflowSource(
        { name: 'fork-multi-rev', location: './b.ts', exportName: 'b', revision: revisionB },
        async () => ({ b: definitionB }),
      ),
    );

    const handles = await recovered.recoverAll();
    expect(handles.map((handle) => handle.id).toSorted()).toEqual(
      ['fork-multi-rev-source', forkedId].toSorted(),
    );

    const forkedHandle = handles.find((handle) => handle.id === forkedId)!;
    await forkedHandle.signal('continue', 'z');
    expect(await forkedHandle.result()).toBe('A:z');
  });

  it("a direct engine.fork() of a legacy (revision-undefined) source run on a single-candidate dynamic-source type resolves the candidate's own per-workflow activity on its first live turn (WFT-19 review round 5)", async () => {
    // Companion to the resume-path regression above: `fork()` never started
    // the source run in this process either (it was seeded straight into
    // storage), so `launchWorkflowFromCheckpoint()`'s identity-cache write
    // is the ONLY place the forked child's `(type, revision)` pin gets
    // populated. Before the fix it recorded `forkState.revision`
    // (inherited verbatim from the source's own `undefined` legacy pin)
    // instead of the resolver's actual resolved revision, so the forked
    // child's `ctx.run('whoami')` on its first live turn could not resolve
    // through the per-workflow registry.
    const storage = new MemoryStorage();
    const definition = workflow({ name: 'legacy-sole-candidate-fork' })
      .activities({ whoami: async () => 'activity-sole' })
      .execute(async function* (ctx: WorkflowContext) {
        const value = yield* ctx.waitForSignal<string>('continue');
        const who = yield* ctx.run('whoami');
        return `${value}:${String(who)}`;
      });
    const soleRevision = await revisionFor(definition);

    // Seeded WITHOUT a `revision` — simulating a pre-revision-pinning
    // (WFT-17) legacy record that was never started in this process, so
    // `workflowTypeByWorkflowId` has no pre-existing entry for it.
    await seedRunningWorkflowState(
      storage,
      'legacy-sole-fork-source',
      'legacy-sole-candidate-fork',
    );

    await using engine = new Engine({ storage });
    engine.registerSource(
      workflowSource(
        {
          name: 'legacy-sole-candidate-fork',
          location: './only.ts',
          exportName: 'only',
          revision: soleRevision,
        },
        async () => ({ only: definition }),
      ),
    );

    const forked = await engine.fork('legacy-sole-fork-source');
    await forked.signal('continue', 'go');
    expect(await forked.result()).toBe('go:activity-sole');
  });

  it("a fork of a legacy (revision-undefined) source run persists its OWN resolved revision durably, not the source's unpinned legacy revision — so a LATER-registered sibling candidate does not make it unresumable after a restart (WFT-19 review round 6)", async () => {
    // Codex P1 (round 6), fresh evidence beyond the round-5 identity-cache
    // finding above: `fork()` resolves the source's sole candidate and
    // passes that resolved revision to the process-local identity cache
    // (round 5's fix), but `createForkedWorkflowState()` still stamped the
    // FORK's own persisted `revision` field with `sourceState.revision` —
    // the source's raw, still-`undefined` legacy pin — not the resolver's
    // answer. The fork runs correctly until the process restarts; but if a
    // SECOND candidate is registered before that restart, `recoverAll()`
    // on the fresh process reads the fork's durably-unpinned `revision`
    // straight off storage, sees 2 registered candidates, and classifies
    // it `legacy-ambiguous` — refusing to resume a fork whose own resolver
    // knew exactly which revision it belonged to at creation time.
    const storage = new MemoryStorage();
    const definition = workflow({ name: 'legacy-sole-candidate-fork-persist' }).execute(
      async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal<string>('continue');
      },
    );
    const sibling = workflow({
      name: 'legacy-sole-candidate-fork-persist',
      description: 'a later-registered sibling candidate',
    }).execute(async function* () {
      return 'unused';
    });
    const soleRevision = await revisionFor(definition);
    const siblingRevision = await revisionFor(sibling);

    await seedRunningWorkflowState(
      storage,
      'legacy-fork-persist-source',
      'legacy-sole-candidate-fork-persist',
    );

    let forkedId: string;
    {
      await using engine = new Engine({ storage });
      engine.registerSource(
        workflowSource(
          {
            name: 'legacy-sole-candidate-fork-persist',
            location: './only.ts',
            exportName: 'only',
            revision: soleRevision,
          },
          async () => ({ only: definition }),
        ),
      );

      const forked = await engine.fork('legacy-fork-persist-source');
      forkedId = forked.id;

      // Direct assertion of the round-6 fix: the fork's own PERSISTED
      // `revision` (not just its in-memory identity cache) must be the
      // resolver's resolved value, never `undefined`.
      const forkedState = await engine.get(forkedId);
      expect(forkedState?.revision).toBe(soleRevision);
    }

    // A second candidate registers AFTER the fork was created — exactly
    // the ordering that exposes the pre-fix bug: `type` now has 2
    // registered candidates, so a `revision: undefined` record would
    // recover `legacy-ambiguous`.
    await using recovered = new Engine({ storage });
    recovered.registerSource(
      workflowSource(
        {
          name: 'legacy-sole-candidate-fork-persist',
          location: './only.ts',
          exportName: 'only',
          revision: soleRevision,
        },
        async () => ({ only: definition }),
      ),
    );
    recovered.registerSource(
      workflowSource(
        {
          name: 'legacy-sole-candidate-fork-persist',
          location: './sibling.ts',
          exportName: 'sibling',
          revision: siblingRevision,
        },
        async () => ({ sibling }),
      ),
    );

    const handles = await recovered.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual([forkedId]);

    const recoveredState = await recovered.get(forkedId);
    expect(recoveredState?.status).toBe('running');
    expect(recoveredState?.revision).toBe(soleRevision);

    await handles[0]!.signal('continue', 'go');
    expect(await handles[0]!.result()).toBe('go');
  });

  it("a run pinned to a revision this process never registered recovers unavailable — including when it is the type's sole registered candidate under a DIFFERENT revision (today's stale-sole-candidate bug) — without blocking a sibling pinned to a registered revision", async () => {
    const storage = new MemoryStorage();
    const definition = workflow({ name: 'partial-avail' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('continue');
    });
    // Pinned to a revision that is NOT among this process's registered
    // candidates at all — and it also happens to be the ONLY candidate this
    // process registers, simulating "the sole candidate changed since this
    // run started": before this batch, `resolveExecutableRegistration`'s
    // `byRevision.size === 1` fast path would silently resolve this run
    // against the mismatched sole candidate. Now it must not. The ghost
    // pin is never loaded (rejected before the loader runs), so it can stay
    // an arbitrary string; the sibling's pin must be the real revision.
    const okRevision = await revisionFor(definition);
    await seedRunningWorkflowState(storage, 'partial-avail-ghost', 'partial-avail', 'rev-ghost');
    await seedRunningWorkflowState(storage, 'partial-avail-ok', 'partial-avail', okRevision);

    await using recovered = new Engine({ storage });
    recovered.registerSource(
      workflowSource(
        { name: 'partial-avail', location: './x.ts', exportName: 'x', revision: okRevision },
        async () => ({ x: definition }),
      ),
    );

    const handles = await recovered.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual(['partial-avail-ok']);

    const ghostState = await recovered.get('partial-avail-ghost');
    expect(ghostState?.status).toBe('failed');
    expect(ghostState?.failureCategory).toBe('system');
    expect(ghostState?.error).toContain('rev-ghost');

    const okHandle = handles[0]!;
    await okHandle.signal('continue', 'ok');
    expect(await okHandle.result()).toBe('ok');
  });

  it('a legacy (revision-undefined) run on a dynamic-source type with 2+ registered candidates recovers unavailable ("legacy-ambiguous"), without blocking a sibling pinned run', async () => {
    const storage = new MemoryStorage();
    const definition = workflow({ name: 'legacy-ambiguous' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('continue');
    });
    // The legacy entry's own sibling candidate ('rev-1') is never resolved
    // (the legacy-ambiguous classification short-circuits before any load),
    // so it can stay an arbitrary string; the PINNED entry's candidate must
    // be the real revision the loaded definition validates against.
    const pinnedRevision = await revisionFor(definition);
    await seedRunningWorkflowState(storage, 'legacy-ambiguous-old', 'legacy-ambiguous');
    await seedRunningWorkflowState(
      storage,
      'legacy-ambiguous-pinned',
      'legacy-ambiguous',
      pinnedRevision,
    );

    await using recovered = new Engine({ storage });
    recovered.registerSource(
      workflowSource(
        { name: 'legacy-ambiguous', location: './1.ts', exportName: 'a', revision: 'rev-1' },
        async () => ({ a: definition }),
      ),
    );
    recovered.registerSource(
      workflowSource(
        {
          name: 'legacy-ambiguous',
          location: './2.ts',
          exportName: 'b',
          revision: pinnedRevision,
        },
        async () => ({ b: definition }),
      ),
    );

    const handles = await recovered.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual(['legacy-ambiguous-pinned']);

    const legacyState = await recovered.get('legacy-ambiguous-old');
    expect(legacyState?.status).toBe('failed');
    expect(legacyState?.failureCategory).toBe('system');
    expect(legacyState?.error).toContain('predates revision pinning');

    const pinnedHandle = handles[0]!;
    await pinnedHandle.signal('continue', 'go');
    expect(await pinnedHandle.result()).toBe('go');
  });

  it("a legacy (revision-undefined) run on a dynamic-source type with exactly one registered candidate resolves that candidate's own per-workflow activity on resume, not the eager/global registry (WFT-19 review round 5)", async () => {
    // Codex P1 (round 5): `resolveExecutableRegistrationForRevision()`
    // resolves the sole candidate for a legacy record even though
    // `state.revision` is `undefined` (the "legacy, unambiguous" fast
    // path) — but the resume-time identity-cache write must record THAT
    // resolved revision, not the raw `undefined` pin. Before the fix,
    // `relaunchInlineWorkflowAfterResume()` cached `revision: undefined`
    // here, so `resolveActivityViaRegistries()`'s `identity.revision !==
    // undefined` branch never fired and the per-workflow `whoami` activity
    // fell through to the eager/global-only registry — empty for a
    // dynamic-source type since WFT-19 removed the clobbering mirror-write
    // — and threw `ActivityResolutionError` instead of resolving.
    const storage = new MemoryStorage();
    const definition = workflow({ name: 'legacy-sole-candidate' })
      .activities({ whoami: async () => 'activity-sole' })
      .execute(async function* (ctx: WorkflowContext) {
        const value = yield* ctx.waitForSignal<string>('continue');
        const who = yield* ctx.run('whoami');
        return `${value}:${String(who)}`;
      });
    const soleRevision = await revisionFor(definition);

    // Seeded WITHOUT a `revision` — simulating a pre-revision-pinning
    // (WFT-17) legacy record.
    await seedRunningWorkflowState(storage, 'legacy-sole-1', 'legacy-sole-candidate');

    await using engine = new Engine({ storage });
    engine.registerSource(
      workflowSource(
        {
          name: 'legacy-sole-candidate',
          location: './only.ts',
          exportName: 'only',
          revision: soleRevision,
        },
        async () => ({ only: definition }),
      ),
    );

    const handles = await engine.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual(['legacy-sole-1']);

    await handles[0]!.signal('continue', 'go');
    expect(await handles[0]!.result()).toBe('go:activity-sole');
  });

  it("a standalone engine.resume(id) on a run pinned to an unregistered revision throws WorkflowRevisionUnavailableError directly to its caller, unlike recoverAll()'s per-group isolation", async () => {
    // `recoverAll()` above isolates this failure per-`(type, revision)`
    // group — only the affected runs fail, via `failWorkflowForRevisionUnavailable`,
    // and the error itself never reaches `recoverAll()`'s own caller. A
    // standalone `engine.resume(workflowId)` has no group of siblings to
    // isolate around — there is only the one run — so
    // `resumeWorkflowFromStorage()` lets the same error propagate straight
    // to its caller instead of catching and isolating it. This is the
    // scenario `WorkflowRevisionUnavailableError`'s own `@example` JSDoc
    // documents.
    const storage = new MemoryStorage();
    const definition = workflow({ name: 'standalone-resume-ghost' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('continue');
    });
    const registeredRevision = await revisionFor(definition);
    await seedRunningWorkflowState(
      storage,
      'standalone-resume-ghost-1',
      'standalone-resume-ghost',
      'rev-ghost',
    );

    await using engine = new Engine({ storage });
    engine.registerSource(
      workflowSource(
        {
          name: 'standalone-resume-ghost',
          location: './x.ts',
          exportName: 'x',
          revision: registeredRevision,
        },
        async () => ({ x: definition }),
      ),
    );

    await expect(engine.resume('standalone-resume-ghost-1')).rejects.toThrow(
      WorkflowRevisionUnavailableError,
    );

    // Unlike `recoverAll()`'s isolation path, a rejected standalone
    // `resume()` never reaches `failWorkflowForRevisionUnavailable` — the
    // workflow state is left exactly as it was, not transitioned to
    // `failed`, so the caller can retry once the pinned revision is
    // registered.
    const state = await engine.get('standalone-resume-ghost-1');
    expect(state?.status).toBe('running');
  });

  it('a corrupted (present but malformed) persisted revision on a single-candidate dynamic-source type is rejected as unavailable, never silently executed against the sole candidate', async () => {
    // `decodeWorkflowState()`'s `sanitizeDecodedRevision()` never drops a
    // present-but-malformed `revision` to `undefined` — doing so would make
    // THIS exact scenario (a single registered candidate) fall through to
    // the "legacy, unambiguous" fast path and silently execute the sole
    // candidate against a checkpoint whose true originating revision is
    // actually unknown, rather than rejecting the damaged identity. Instead
    // it substitutes a deterministic corruption marker that cannot match
    // any real registered candidate, so recovery classifies this group
    // `unavailable` explicitly.
    const storage = new MemoryStorage();
    const definition = workflow({ name: 'corrupted-pin-single-candidate' }).execute(
      async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal<string>('continue');
      },
    );
    const soleCandidateRevision = await revisionFor(definition);

    // Written with a raw, non-string `revision` — bypassing `seedRunningWorkflowState`'s
    // `string | undefined` parameter type, which cannot express storage-level
    // corruption directly.
    await storage.put(
      KEYS.workflow('corrupted-pin-1'),
      encode({
        id: 'corrupted-pin-1',
        type: 'corrupted-pin-single-candidate',
        status: 'running',
        input: null,
        versionTuple: { workflowVersion: DEFAULT_WORKFLOW_VERSION },
        revision: 42,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await storage.put(
      KEYS.checkpoint('corrupted-pin-1'),
      serializeCheckpoint(createCheckpoint('corrupted-pin-1', DEFAULT_WORKFLOW_VERSION, 1)),
    );

    await using recovered = new Engine({ storage });
    recovered.registerSource(
      workflowSource(
        {
          name: 'corrupted-pin-single-candidate',
          location: './only.ts',
          exportName: 'only',
          revision: soleCandidateRevision,
        },
        async () => ({ only: definition }),
      ),
    );

    const handles = await recovered.recoverAll();
    expect(handles).toEqual([]);

    const state = await recovered.get('corrupted-pin-1');
    expect(state?.status).toBe('failed');
    expect(state?.failureCategory).toBe('system');
    expect(state?.error).toContain('not registered in this process');
  });
});
