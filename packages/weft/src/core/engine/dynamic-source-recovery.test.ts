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

describe('recoverAll() — per-(type, revision) preload barrier and exact revision pinning (WFT-17/WFT-18)', () => {
  it('two non-terminal runs of the same dynamic-source type, pinned to two different registered revisions, both recover against their own pinned code', async () => {
    // The core bug this batch fixes: before WFT-17/WFT-18, EVERY non-terminal
    // run of a dynamic-source type resolved against whichever revision was
    // currently ACTIVE, regardless of which one it actually started on. Two
    // sibling runs pinned to two DIFFERENT revisions must each recover
    // against their OWN code — proven here by each definition returning a
    // distinct, revision-specific value. Deliberately activity-free (see
    // module doc caveat): `activityRegistriesByWorkflow`/
    // `lastResolvedRevisionByName` are keyed by TYPE alone (a WFT-19
    // boundary this batch does not touch), so an activity call would be
    // routed through whichever revision resolved last, not necessarily the
    // handler's own.
    const storage = new MemoryStorage();
    // `deriveWorkflowRevision()` hashes the CONTRACT (name, workflowVersion,
    // description, tags) — not the handler body — so distinct `description`
    // values are what actually give A and B distinct revisions here.
    const definitionA = workflow({ name: 'multi-rev', description: 'candidate A' }).execute(
      async function* (ctx: WorkflowContext) {
        const value = yield* ctx.waitForSignal<string>('continue');
        return `A:${value}`;
      },
    );
    const definitionB = workflow({ name: 'multi-rev', description: 'candidate B' }).execute(
      async function* (ctx: WorkflowContext) {
        const value = yield* ctx.waitForSignal<string>('continue');
        return `B:${value}`;
      },
    );

    // `workflowSource()`'s declared `revision` is cross-checked against the
    // loaded module's own content-derived revision at resolve time — so
    // each pin below must be the definition's REAL manifest revision, not
    // an arbitrary string, or resolution fails validation
    // (`artifact-revision-mismatch`) before ever reaching this batch's
    // logic under test.
    const revisionA = await revisionFor(definitionA as WorkflowDefinition);
    const revisionB = await revisionFor(definitionB as WorkflowDefinition);
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
    expect(await handleA.result()).toBe('A:x');
    expect(await handleB.result()).toBe('B:y');
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
    const okRevision = await revisionFor(definition as WorkflowDefinition);
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
    const pinnedRevision = await revisionFor(definition as WorkflowDefinition);
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
});
