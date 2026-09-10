import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { Engine } from '../engine.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { activity, workflow, type WorkflowContext } from '../types.ts';
import { DEFAULT_WORKFLOW_VERSION } from '../versioning.ts';
import { activateCatalogRevisionCandidate } from './catalog-activation.ts';
import { ensureWorkflowCatalogReady } from './catalog-readiness.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { getInternals, getWorkflowCatalog } from './internals.ts';
import {
  buildPerWorkflowActivityRegistry,
  buildRegistrationEntry,
  isBuilderWorkflowDefinition,
  resolveWorkflowTypeTarget,
  type RegistrationCallbacks,
} from './registration.ts';

const callbacks: RegistrationCallbacks = {
  ensureRetentionSweepInterval: () => undefined,
  dispatchEvent: () => undefined,
};

describe('resolveWorkflowTypeTarget', () => {
  it('returns string workflow targets directly', () => {
    const engine = new Engine();

    expect(resolveWorkflowTypeTarget(getInternals(engine), 'registered-workflow', callbacks)).toBe(
      'registered-workflow',
    );

    engine[Symbol.dispose]();
  });

  it('resolves a registered workflow function back to its workflow type', () => {
    const engine = new Engine();
    const registeredWorkflow = workflow({ name: 'registered-workflow' }).execute(
      async function* registeredWorkflowHandler() {
        return 'done';
      },
    );
    engine.register(registeredWorkflow);

    expect(
      resolveWorkflowTypeTarget(getInternals(engine), registeredWorkflow.handler, callbacks),
    ).toBe('registered-workflow');

    engine[Symbol.dispose]();
  });

  it('rejects non-workflow registration inputs with a clear error', () => {
    const engine = new Engine();

    expect(() => engine.register(undefined as never)).toThrow(
      'engine.register() expects a WorkflowDefinition',
    );

    engine[Symbol.dispose]();
  });

  it('rejects a { name, handler } shape whose handler is not callable, rather than treating key-presence alone as sufficient', () => {
    const engine = new Engine();

    expect(() => engine.register({ name: 'checkout', handler: null } as never)).toThrow(
      'engine.register() expects a WorkflowDefinition',
    );

    engine[Symbol.dispose]();
  });
});

describe('finalizer registration (#446)', () => {
  const destroySandbox = activity({
    name: 'destroySandbox',
    execute: async () => undefined,
  });

  it('stores the finalizer on the engine-lifetime registry by workflow type', () => {
    const engine = new Engine();
    const provision = workflow({ name: 'provision', finalizer: destroySandbox }).execute(
      async function* () {
        return 'done';
      },
    );

    engine.register(provision);

    const entry = getInternals(engine).registrations.get('provision');
    expect(entry?.finalizer).toBeDefined();
    expect(entry?.finalizer?.name).toBe('destroySandbox');

    engine[Symbol.dispose]();
  });

  it('stores the declared finalizer reference as-is (no Phase 1 dispatch hardening)', () => {
    const engine = new Engine();
    const provision = workflow({ name: 'provision-stored', finalizer: destroySandbox }).execute(
      async function* () {
        return 'done';
      },
    );

    engine.register(provision);

    // Phase 1 only records the finalizer metadata; nothing dispatches it yet, so
    // it is kept as-declared rather than rebuilt. Dispatch hardening is deferred to
    // the phase that actually invokes finalizers.
    expect(getInternals(engine).registrations.get('provision-stored')?.finalizer).toBe(
      destroySandbox,
    );

    engine[Symbol.dispose]();
  });

  it('survives the activities-builder registration path (isBuilderWorkflowDefinition branch)', () => {
    // The `.activities({...})` builder path goes through a different `register`
    // branch than the plain `workflow().execute()` path; both call
    // `commitWorkflowDefinition`, so the finalizer must survive either.
    const engine = new Engine();
    const provision = workflow({ name: 'provision-with-activities', finalizer: destroySandbox })
      .activities({ doWork: async () => 'worked' })
      .execute(async function* () {
        return 'done';
      });

    engine.register(provision);

    expect(
      getInternals(engine).registrations.get('provision-with-activities')?.finalizer?.name,
    ).toBe('destroySandbox');

    engine[Symbol.dispose]();
  });

  it('leaves the finalizer undefined when none is declared', () => {
    const engine = new Engine();
    const plain = workflow({ name: 'plain' }).execute(async function* () {
      return 'done';
    });

    engine.register(plain);

    expect(getInternals(engine).registrations.get('plain')?.finalizer).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('succeeds when registering a finalizer on a worker-mode engine (#564)', () => {
    // Finalizers are host-side trusted activity code. workflowExecutionMode:'worker'
    // isolates only the workflow generator; the finalizer always runs on the engine
    // host via runFinalizerActivity, so the registration guard is not needed.
    const engine = new Engine({
      workflowExecutionMode: 'worker',
      workerExecution: {
        workerUrl: new URL('https://example.invalid/worker.js'),
        poolSize: 1,
      },
    });

    const workerModeFinalized = workflow({
      name: 'worker-mode-finalized',
      finalizer: destroySandbox,
    }).execute(async function* () {
      return 'done';
    });

    expect(() => engine.register(workerModeFinalized)).not.toThrow();

    const entry = getInternals(engine).registrations.get('worker-mode-finalized');
    expect(entry?.finalizer).toBeDefined();
    expect(entry?.finalizer?.name).toBe('destroySandbox');

    engine[Symbol.dispose]();
  });
});

describe('unversioned workflow default (WFT-5 registration.ts fix)', () => {
  it('defaults an unversioned workflow registration to DEFAULT_WORKFLOW_VERSION, not the literal "1"', () => {
    const engine = new Engine();
    engine.register(workflow({ name: 'no-explicit-version' }).execute(async function* () {}));

    const [definition] = engine.listWorkflowDefinitions();
    expect(definition?.version).toBe(DEFAULT_WORKFLOW_VERSION);
    expect(definition?.version).toBe('0.0.0');
    expect(definition?.version).not.toBe('1');

    engine[Symbol.dispose]();
  });

  it('agrees with the fresh worker-manifest placeholder default (worker/options.ts, worker/manifest/internal-realm.ts)', () => {
    // Both worker/options.ts and worker/manifest/internal-realm.ts already
    // fall back to DEFAULT_WORKFLOW_VERSION for an artifact that declares no
    // real workflowVersion. This registration must agree with the same
    // constant so a registered-but-unversioned workflow and a
    // registered-but-unversioned worker artifact never disagree about what
    // "unversioned" means.
    const engine = new Engine();
    engine.register(
      workflow({ name: 'agrees-with-worker-default' }).execute(async function* () {}),
    );

    const [definition] = engine.listWorkflowDefinitions();
    expect(definition?.version).toBe(DEFAULT_WORKFLOW_VERSION);

    engine[Symbol.dispose]();
  });

  it('still honors an explicitly supplied version', () => {
    const engine = new Engine();
    engine.register(
      workflow({ name: 'explicit-version', version: '1' }).execute(async function* () {}),
    );

    const [definition] = engine.listWorkflowDefinitions();
    expect(definition?.version).toBe('1');

    engine[Symbol.dispose]();
  });
});

describe('register() and the deferred workflow catalog', () => {
  it('returns synchronously and does not itself touch storage', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    let putCalls = 0;
    const originalPut = internals.storage.put.bind(internals.storage);
    internals.storage.put = (key: string, value: Uint8Array) => {
      putCalls += 1;
      return originalPut(key, value);
    };

    engine.register(workflow({ name: 'deferred-install' }).execute(async function* () {}));

    expect(putCalls).toBe(0);
    expect(internals.pendingCatalogInstalls).toContain('deferred-install');
    expect(internals.catalogRestored).toBe(false);

    engine[Symbol.dispose]();
  });

  it('queues the workflow name in pendingCatalogInstalls exactly once per registration', () => {
    const engine = new Engine();
    engine.register(workflow({ name: 'once' }).execute(async function* () {}));

    const internals = getInternals(engine);
    expect(internals.pendingCatalogInstalls.filter((name) => name === 'once')).toHaveLength(1);

    engine[Symbol.dispose]();
  });
});

describe('register() and dynamic workflow sources (WFT-13/14)', () => {
  it('throws when the name is already registered as a dynamic workflow source', () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    // Simulate a prior `registerSource()` call without depending on
    // `core/engine/source-registration.ts` here — this test's only
    // responsibility is the symmetric guard inside `commitWorkflowDefinition`.
    internals.sources.byName.set(
      'lazyCheckout',
      new Map([
        [
          'r1',
          {
            descriptor: {
              kind: 'module',
              name: 'lazyCheckout',
              location: 'x',
              exportName: 'x',
              revision: 'r1',
            },
            load: async () => ({}),
          },
        ],
      ]),
    );

    expect(() =>
      engine.register(workflow({ name: 'lazyCheckout' }).execute(async function* () {})),
    ).toThrow(/already registered as a dynamic workflow source/);

    engine[Symbol.dispose]();
  });
});

describe('WFT-17: persisted WorkflowState.revision at start admission', () => {
  it("a fresh start persists this process's own registeredCatalogRevisions entry, not the catalog's active pointer — proven where they differ", async () => {
    await using engine = new Engine({ backgroundTasks: 'manual' });
    engine.register(
      workflow({ name: 'checkout', version: '1.0.0' }).execute(async function* () {
        return 'done';
      }),
    );
    await engine.start('checkout', null, { id: 'priming' }).then((h) => h.result());
    const ownRevision = getInternals(engine).registeredCatalogRevisions.get('checkout')!;

    // Move the durable ACTIVE pointer to a DIFFERENT revision without this
    // process ever loading that code — `activateCatalogRevisionCandidate`
    // is the guarded primitive `engine.workflows.activate()` uses, distinct
    // from `register()`'s own install+activate path, so
    // `registeredCatalogRevisions` is untouched by it. This engine's
    // `resolveActive('checkout')` now names a revision it has never run.
    const laterContract = buildWorkflowContract({
      name: 'checkout',
      version: '1.0.0',
      description: 'a later revision this process never loaded',
    });
    const laterManifest: WorkflowRevisionManifest =
      await buildWorkflowRevisionManifest(laterContract);
    await activateCatalogRevisionCandidate(engine, 'checkout', laterManifest, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    const activePointerRevision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;
    expect(activePointerRevision).not.toBe(ownRevision);
    expect(activePointerRevision).toBe(laterManifest.revision);

    // A fresh start now: if it followed the active pointer (the pre-WFT-17
    // bug — `resolveAndReserveExecutableRegistration()`'s `inFlightRevision`
    // falls back to `catalog.resolveActive()` for an eager type), it would
    // persist `activePointerRevision` — a revision this process cannot
    // actually execute. It must persist `ownRevision` instead: the exact
    // code this process is actually about to run.
    const handle = await engine.start('checkout', null, { id: 'after-activation' });
    await handle.result();

    const state = await engine.get('after-activation');
    expect(state?.revision).toBe(ownRevision);
    expect(state?.revision).not.toBe(activePointerRevision);

    // WorkflowSummary (engine.list()) carries the same distinction: name,
    // revision, and semantic version all present and distinct.
    const listed = await engine.list({ type: 'checkout' });
    const summary = listed.items.find((item) => item.id === 'after-activation')!;
    expect(summary.type).toBe('checkout');
    expect(summary.version).toBe('1.0.0');
    expect(summary.revision).toBe(ownRevision);
  });

  it('omits WorkflowSummary.revision (not null) for a legacy record with no persisted revision', async () => {
    await using engine = new Engine({ backgroundTasks: 'manual' });
    engine.register(
      workflow({ name: 'legacy-summary' }).execute(async function* () {
        return 'done';
      }),
    );
    await engine.start('legacy-summary', null, { id: 'legacy-summary-1' }).then((h) => h.result());

    // Strip the persisted revision directly in storage, simulating a
    // pre-this-release record, then read it back through the summary path.
    const key = KEYS.workflow('legacy-summary-1');
    const bytes = await engine.storage.get(key);
    const decoded = decode(bytes!) as Record<string, unknown>;
    delete decoded['revision'];
    await engine.storage.put(key, encode(decoded));

    const listed = await engine.list({ type: 'legacy-summary' });
    const summary = listed.items[0]!;
    expect('revision' in summary).toBe(false);
    expect(summary.revision).toBeUndefined();
  });

  it('invalidates a stale registeredCatalogRevisions entry immediately on re-registration, before the next catalog drain', async () => {
    // `registeredCatalogRevisions` is populated only by the ASYNC catalog
    // drain, once per pending install — it can lag `internals.registrations`
    // between a synchronous `register()` commit and the next drain
    // completing. `resolveCachedStartRevision()` (`lifecycle/start.ts`)
    // reads this map SYNCHRONOUSLY for an internal start that bypasses the
    // top-level `ensureWorkflowCatalogReady()` gate every top-level
    // `engine.*` method awaits first (`ctx.startChild()`, a scheduled
    // occurrence firing mid-drain) — without invalidating the stale entry,
    // such a start could read the PREVIOUS manifest's revision for code
    // `internals.registrations` has already replaced.
    //
    // The ordinary `workflow().execute()` builder path throws on re-registering
    // a name with different content (`checkWorkflowCollision`), so this
    // exercises the one path that CAN legitimately change an eager
    // registration's content under an unchanged name: a hand-rolled plain
    // `WorkflowDefinition` object (not builder-produced), which
    // `commitWorkflowDefinition` accepts without a collision check.
    await using engine = new Engine({ backgroundTasks: 'manual' });
    const internals = getInternals(engine);
    const name = 'reg-cache-invalidation';

    engine.register({
      name,
      handler: async function* () {
        return 'v1';
      },
      description: 'first candidate',
    } as never);
    await ensureWorkflowCatalogReady(engine);
    const revisionV1 = internals.registeredCatalogRevisions.get(name);
    expect(revisionV1).toBeDefined();

    engine.register({
      name,
      handler: async function* () {
        return 'v2';
      },
      description: 'second candidate',
    } as never);

    // Immediately, BEFORE the next drain runs: the stale v1 entry must
    // already be gone, not silently served to a synchronous reader.
    expect(internals.registeredCatalogRevisions.has(name)).toBe(false);

    await ensureWorkflowCatalogReady(engine);
    const revisionV2 = internals.registeredCatalogRevisions.get(name);
    expect(revisionV2).toBeDefined();
    expect(revisionV2).not.toBe(revisionV1);
  });
});

describe('getWorkflowActivityDefinition() / listWorkflowActivityDefinitions() — eager-only scope (WFT-19)', () => {
  it('returns undefined/[] for a resolved registerSource()-registered type, never a stale or mismatched dynamic-source revision', async () => {
    // Regression: before this fix, `loadAndInstallSourceRevision()` mirrored
    // a resolved dynamic source's activity registry into the TYPE-keyed
    // `internals.activityRegistriesByWorkflow` — the exact map these two
    // accessors read. That mirror-write is removed (WFT-19: it is what
    // clobbered across revisions), so a `registerSource()`-registered type
    // — resolved or not — now correctly returns "nothing here", not a
    // possibly-stale-or-wrong-revision reflection of it.
    const type = 'dynamic-activity-scope';
    const definition = workflow({ name: type })
      .activities({ ping: async () => 'pong' })
      .execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('never');
      });
    const entry = buildRegistrationEntry(type, definition);
    const registered = copyWorkflowDefinition(type, entry);
    // The workflow's own `.activities({...})` contract is part of the
    // manifest hash — feed the SAME per-workflow activity definitions
    // registration would build, not an empty registry.
    const activityDefinitions = isBuilderWorkflowDefinition(definition)
      ? buildPerWorkflowActivityRegistry(definition.activities).listDefinitions()
      : [];
    const manifest = await buildWorkflowManifestFromDefinition(registered, activityDefinitions);

    const engine = new Engine();
    engine.registerSource(
      workflowSource(
        {
          name: type,
          location: './dynamic-activity-scope.ts',
          exportName: 'dyn',
          revision: manifest.revision,
        },
        async () => ({ dyn: definition }),
      ),
    );

    // Not yet resolved: both accessors already read empty/undefined.
    expect(engine.getWorkflowActivityDefinition(type, 'ping')).toBeUndefined();
    expect(engine.listWorkflowActivityDefinitions(type)).toEqual([]);

    // Resolve it (via a real start) — the pre-fix mirror-write would have
    // populated `activityRegistriesByWorkflow` here.
    const handle = await engine.start(type, null, { id: 'dynamic-activity-scope-run' });
    expect(engine.getWorkflowActivityDefinition(type, 'ping')).toBeUndefined();
    expect(engine.listWorkflowActivityDefinitions(type)).toEqual([]);

    await handle.cancel();
    engine[Symbol.dispose]();
  });

  it('returns the eager registration for a same-named eager type unaffected by a resolved dynamic-source sibling', async () => {
    const eagerDefinition = workflow({ name: 'eager-activity-scope' })
      .activities({ pong: async () => 'ping' })
      .execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('never');
      });
    const engine = new Engine();
    engine.register(eagerDefinition);

    expect(engine.getWorkflowActivityDefinition('eager-activity-scope', 'pong')).toBeDefined();
    expect(engine.listWorkflowActivityDefinitions('eager-activity-scope')).toHaveLength(1);

    engine[Symbol.dispose]();
  });
});
