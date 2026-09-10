import { beforeAll, describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowContext, type WorkflowDefinition } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import {
  DynamicWorkflowSourceUnavailableError,
  WorkflowSourceNotRegisteredError,
} from './dynamic-source-errors.ts';
import {
  canResolveRevisionLocally,
  getResolvedDynamicRegistration,
  resolveExecutableRegistration,
  resolveExecutableRegistrationForRevision,
  resolveExecutableRegistrationOrRenamedNotFound,
} from './dynamic-source-execution.ts';
import { WorkflowNotRegisteredError } from './errors.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import {
  buildPerWorkflowActivityRegistry,
  buildRegistrationEntry,
  isBuilderWorkflowDefinition,
} from './registration.ts';
import { WorkflowRevisionUnavailableError } from './revision-errors.ts';

const eagerDefinition = workflow({ name: 'eager' }).execute(async function* () {
  return 'eager-done';
});

const lazyDefinition = workflow({ name: 'lazy' }).execute(async function* () {
  return 'lazy-done';
});

async function revisionFor(definition: WorkflowDefinition): Promise<string> {
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  // A builder workflow's `.activities({...})` map is part of its contract —
  // feed the SAME per-workflow activity definitions registration would
  // build, or the manifest computed here disagrees with the one the engine
  // derives when it actually resolves and installs this definition.
  const activityDefinitions = isBuilderWorkflowDefinition(definition)
    ? buildPerWorkflowActivityRegistry(definition.activities).listDefinitions()
    : new ActivityRegistry().listDefinitions();
  const manifest = await buildWorkflowManifestFromDefinition(registered, activityDefinitions);
  return manifest.revision;
}

let lazyRevision: string;
let lazyRevisionB: string;
// A second, distinct definition for the same name — differ by description so
// the derived revision hash differs from `lazyDefinition`'s. Exposed at
// module scope (not just inside beforeAll) so a loader that resolves
// `lazyRevisionB` can return THIS exact definition — a loader returning
// `{ ...lazyDefinition, name: 'lazy' }` instead validates against the wrong
// contract and throws `artifact-revision-mismatch` the moment it actually
// loads (as opposed to merely being registered and never invoked).
const lazyVariantDefinition = workflow({ name: 'lazy', description: 'variant-b' }).execute(
  async function* () {
    return 'lazy-b-done';
  },
);

beforeAll(async () => {
  lazyRevision = await revisionFor(lazyDefinition);
  lazyRevisionB = await revisionFor(lazyVariantDefinition);
});

function registerLazy(
  engine: Engine,
  revision: string,
  loadResult: () => Promise<Record<string, unknown>>,
) {
  const loader = mock(loadResult);
  engine.registerSource(
    workflowSource({ name: 'lazy', location: './lazy.ts', exportName: 'lazy', revision }, loader),
  );
  return loader;
}

async function newEngine() {
  const storage = new MemoryStorage();
  return new Engine({ storage, backgroundTasks: 'manual' });
}

/**
 * Move `type`'s catalog active pointer to `revision`, tolerating a
 * revision-only content difference (`policy: { requireExactRevision: false }`)
 * and supplying the required `expectedGeneration` once a prior active
 * pointer exists — an omitted `expectedGeneration` on a second activation
 * silently refuses with `expected-generation-required` rather than
 * throwing, which would otherwise leave a test's SECOND revision
 * unactivated with no visible error (the active pointer staying on the
 * first) and every subsequent `engine.start()` call for `type` resolving
 * the WRONG revision — hanging, not failing, when that wrong revision's
 * handler parks on a signal nothing will ever send it. Throws loudly
 * instead when activation is refused for any reason.
 */
async function activateDynamicSourceRevision(
  engine: Engine,
  type: string,
  revision: string,
): Promise<void> {
  const active = await engine.workflows.getActive(type);
  const result = await engine.workflows.activate(type, revision, {
    ...(active !== null && { expectedGeneration: active.generation }),
    policy: { requireExactRevision: false },
  });
  if (!result.applied) {
    throw new Error(
      `activateDynamicSourceRevision(${type}, ${revision}) was not applied: ${JSON.stringify(result)}`,
    );
  }
}

describe('resolveExecutableRegistration()', () => {
  it('resolves an eager registration synchronously without ever touching internals.sources', async () => {
    const engine = await newEngine();
    engine.register(eagerDefinition);
    const internals = getInternals(engine);

    const { entry, revision } = await resolveExecutableRegistration(engine, internals, 'eager');

    expect(entry.handler).toBe(eagerDefinition.handler);
    expect(revision).toBeUndefined();
    expect(internals.sources.byName.size).toBe(0);

    engine[Symbol.dispose]();
  });

  it('imports only the sole registered revision for a lazy type with no active catalog pointer', async () => {
    const engine = await newEngine();
    const loader = registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const internals = getInternals(engine);

    const { entry, revision } = await resolveExecutableRegistration(engine, internals, 'lazy');

    expect(entry.handler).toBe(lazyDefinition.handler);
    expect(revision).toBe(lazyRevision);
    expect(loader).toHaveBeenCalledTimes(1);

    engine[Symbol.dispose]();
  });

  it('imports only the catalog active revision when two revisions are registered', async () => {
    const engine = await newEngine();
    const loaderA = registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const loaderB = registerLazy(engine, lazyRevisionB, async () => ({
      lazy: { ...lazyDefinition, name: 'lazy' },
    }));
    const internals = getInternals(engine);

    // Resolve + activate revision A first so the catalog has an active pointer.
    await engine.resolveWorkflowSource('lazy', lazyRevision);
    await engine.workflows.activate('lazy', lazyRevision);
    loaderA.mockClear();

    const { revision } = await resolveExecutableRegistration(engine, internals, 'lazy');

    expect(revision).toBe(lazyRevision);
    expect(loaderB).not.toHaveBeenCalled();
    // Already locally resolved — the cache-hit path does not re-invoke it.
    expect(loaderA).not.toHaveBeenCalled();

    engine[Symbol.dispose]();
  });

  it('throws DynamicWorkflowSourceUnavailableError(reason: "ambiguous-revision") for two revisions with no active pointer, without invoking either loader', async () => {
    const engine = await newEngine();
    const loaderA = registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const loaderB = registerLazy(engine, lazyRevisionB, async () => ({
      lazy: { ...lazyDefinition, name: 'lazy' },
    }));
    const internals = getInternals(engine);

    const rejection = await resolveExecutableRegistration(engine, internals, 'lazy').catch(
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(DynamicWorkflowSourceUnavailableError);
    expect((rejection as DynamicWorkflowSourceUnavailableError).reason).toBe('ambiguous-revision');
    expect(loaderA).not.toHaveBeenCalled();
    expect(loaderB).not.toHaveBeenCalled();

    engine[Symbol.dispose]();
  });

  it('throws the pre-existing WorkflowNotRegisteredError for a type with no registration of any kind', async () => {
    const engine = await newEngine();
    const internals = getInternals(engine);

    const rejection = await resolveExecutableRegistration(engine, internals, 'nobody-home').catch(
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(WorkflowNotRegisteredError);

    engine[Symbol.dispose]();
  });

  it('wraps a loader failure as DynamicWorkflowSourceUnavailableError(reason: "load-failed") with cause set', async () => {
    const engine = await newEngine();
    const boom = new Error('module explode');
    registerLazy(engine, lazyRevision, async () => {
      throw boom;
    });
    const internals = getInternals(engine);

    const rejection = await resolveExecutableRegistration(engine, internals, 'lazy').catch(
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(DynamicWorkflowSourceUnavailableError);
    expect((rejection as DynamicWorkflowSourceUnavailableError).reason).toBe('load-failed');
    expect((rejection as DynamicWorkflowSourceUnavailableError).cause).toBe(boom);

    engine[Symbol.dispose]();
  });

  it('never runs the handler before the loader promise resolves — no execution against a candidate definition', async () => {
    const engine = await newEngine();
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    registerLazy(engine, lazyRevision, () => deferred.promise);
    const internals = getInternals(engine);

    let resolved = false;
    const promise = resolveExecutableRegistration(engine, internals, 'lazy').then((result) => {
      resolved = true;
      return result;
    });

    // Give the microtask queue every opportunity to settle prematurely.
    for (let iteration = 0; iteration < 20; iteration += 1) await Promise.resolve();
    expect(resolved).toBe(false);
    expect(getResolvedDynamicRegistration(internals, 'lazy', undefined)).toBeUndefined();

    deferred.resolve({ lazy: lazyDefinition });
    await promise;
    expect(resolved).toBe(true);

    engine[Symbol.dispose]();
  });
});

describe('resolveExecutableRegistrationForRevision() (WFT-17/WFT-18)', () => {
  it('resolves an eager registration regardless of the pinned revision argument', async () => {
    const engine = await newEngine();
    engine.register(eagerDefinition);
    const internals = getInternals(engine);

    const { entry, revision } = await resolveExecutableRegistrationForRevision(
      engine,
      internals,
      'eager',
      'some-pin-eager-ignores',
    );

    expect(entry.handler).toBe(eagerDefinition.handler);
    expect(revision).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('throws the pre-existing WorkflowNotRegisteredError for a type with no registration of any kind', async () => {
    const engine = await newEngine();
    const internals = getInternals(engine);

    const rejection = await resolveExecutableRegistrationForRevision(
      engine,
      internals,
      'nobody-home',
      undefined,
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(WorkflowNotRegisteredError);

    engine[Symbol.dispose]();
  });

  it('a legacy (revision-undefined) pin on a single-candidate dynamic source falls through to the ordinary active-pointer resolve', async () => {
    const engine = await newEngine();
    const loader = registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const internals = getInternals(engine);

    const { entry, revision } = await resolveExecutableRegistrationForRevision(
      engine,
      internals,
      'lazy',
      undefined,
    );

    expect(entry.handler).toBe(lazyDefinition.handler);
    expect(revision).toBe(lazyRevision);
    expect(loader).toHaveBeenCalledTimes(1);

    engine[Symbol.dispose]();
  });

  it('a legacy (revision-undefined) pin on a multi-candidate dynamic source throws WorkflowRevisionUnavailableError(reason: "legacy-ambiguous"), invoking neither loader', async () => {
    const engine = await newEngine();
    const loaderA = registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const loaderB = registerLazy(engine, lazyRevisionB, async () => ({
      lazy: { ...lazyDefinition, name: 'lazy' },
    }));
    const internals = getInternals(engine);

    const rejection = await resolveExecutableRegistrationForRevision(
      engine,
      internals,
      'lazy',
      undefined,
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect((rejection as WorkflowRevisionUnavailableError).reason).toBe('legacy-ambiguous');
    expect((rejection as WorkflowRevisionUnavailableError).revision).toBeUndefined();
    expect(loaderA).not.toHaveBeenCalled();
    expect(loaderB).not.toHaveBeenCalled();

    engine[Symbol.dispose]();
  });

  it('a defined pin naming a revision this process never registered throws WorkflowRevisionUnavailableError(reason: "not-registered") without invoking the loader', async () => {
    const engine = await newEngine();
    const loader = registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const internals = getInternals(engine);

    const rejection = await resolveExecutableRegistrationForRevision(
      engine,
      internals,
      'lazy',
      'sha256:never-registered',
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect((rejection as WorkflowRevisionUnavailableError).reason).toBe('not-registered');
    expect((rejection as WorkflowRevisionUnavailableError).revision).toBe(
      'sha256:never-registered',
    );
    expect(loader).not.toHaveBeenCalled();

    engine[Symbol.dispose]();
  });

  it('a defined pin naming a registered revision loads and installs it exactly like resolveExecutableRegistration()', async () => {
    const engine = await newEngine();
    const loaderA = registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const loaderB = registerLazy(engine, lazyRevisionB, async () => ({
      lazy: lazyVariantDefinition,
    }));

    const internals = getInternals(engine);
    const { entry, revision } = await resolveExecutableRegistrationForRevision(
      engine,
      internals,
      'lazy',
      lazyRevisionB,
    );

    expect(revision).toBe(lazyRevisionB);
    expect(loaderB).toHaveBeenCalledTimes(1);
    expect(loaderA).not.toHaveBeenCalled();
    expect(entry.handler).toBe(lazyVariantDefinition.handler);

    engine[Symbol.dispose]();
  });
});

describe('resolveExecutableRegistrationOrRenamedNotFound()', () => {
  it('remaps a WorkflowNotRegisteredError to the caller-supplied notFoundError', async () => {
    const engine = await newEngine();
    const internals = getInternals(engine);

    const rejection = await resolveExecutableRegistrationOrRenamedNotFound(
      (type) => resolveExecutableRegistration(engine, internals, type),
      'nobody-home',
      () => new Error('custom not-found message'),
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('custom not-found message');

    engine[Symbol.dispose]();
  });

  it('propagates a source-found-but-unresolvable error unwrapped', async () => {
    const engine = await newEngine();
    const loaderA = registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const loaderB = registerLazy(engine, lazyRevisionB, async () => ({
      lazy: { ...lazyDefinition, name: 'lazy' },
    }));
    void loaderA;
    void loaderB;
    const internals = getInternals(engine);

    const rejection = await resolveExecutableRegistrationOrRenamedNotFound(
      (type) => resolveExecutableRegistration(engine, internals, type),
      'lazy',
      () => new Error('should not be used'),
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(DynamicWorkflowSourceUnavailableError);

    engine[Symbol.dispose]();
  });
});

describe('getResolvedDynamicRegistration()', () => {
  it('returns undefined for a type never resolved, without triggering a resolve', () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));

    expect(getResolvedDynamicRegistration(internals, 'lazy', undefined)).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('returns the eager registration first when both an eager and a resolved dynamic entry exist under different names', async () => {
    const engine = await newEngine();
    engine.register(eagerDefinition);
    const internals = getInternals(engine);

    expect(getResolvedDynamicRegistration(internals, 'eager', undefined)?.handler).toBe(
      eagerDefinition.handler,
    );

    engine[Symbol.dispose]();
  });

  it('falls back to the most recently resolved dynamic-source definition', async () => {
    const engine = await newEngine();
    registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const internals = getInternals(engine);
    await resolveExecutableRegistration(engine, internals, 'lazy');

    const registration = getResolvedDynamicRegistration(internals, 'lazy', undefined);

    expect(registration).toBeDefined();
    expect(registration?.handler).toBe(lazyDefinition.handler);

    engine[Symbol.dispose]();
  });
});

// Guards against a regression where `WorkflowSourceNotRegisteredError` (the
// direct `engine.resolveWorkflowSource()` misuse error, always carrying a
// defined `revision`) is confused with the generic
// `WorkflowNotRegisteredError` the execution entry points above rely on.
describe('WorkflowSourceNotRegisteredError vs. WorkflowNotRegisteredError', () => {
  it('resolveWorkflowSource() against an unregistered (name, revision) throws WorkflowSourceNotRegisteredError with a defined revision', async () => {
    const engine = await newEngine();

    const rejection = await engine
      .resolveWorkflowSource('never-registered', 'r1')
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(WorkflowSourceNotRegisteredError);
    expect((rejection as WorkflowSourceNotRegisteredError).revision).toBe('r1');

    engine[Symbol.dispose]();
  });
});

// `canResolveRevisionLocally()` (WFT-19) is the shared predicate
// `resolveExecutableRegistrationForRevision()`'s classification and the
// ADR-0002 workflow-lease reclaim-eligibility gate both delegate to, so the
// two decisions cannot drift. These tests pin its behavior directly,
// independent of either caller.
describe('canResolveRevisionLocally()', () => {
  it('is true for an eager registration regardless of the revision argument', async () => {
    const engine = await newEngine();
    engine.register(eagerDefinition);
    const internals = getInternals(engine);

    expect(canResolveRevisionLocally(internals, 'eager', undefined)).toBe(true);
    expect(canResolveRevisionLocally(internals, 'eager', 'some-pin')).toBe(true);

    engine[Symbol.dispose]();
  });

  it('is false for a type with no eager registration and no registered source at all', async () => {
    const engine = await newEngine();
    const internals = getInternals(engine);

    expect(canResolveRevisionLocally(internals, 'nobody-home', undefined)).toBe(false);
    expect(canResolveRevisionLocally(internals, 'nobody-home', 'some-pin')).toBe(false);

    engine[Symbol.dispose]();
  });

  it('is true for an undefined (legacy) revision on a single-candidate dynamic source', async () => {
    const engine = await newEngine();
    registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const internals = getInternals(engine);

    expect(canResolveRevisionLocally(internals, 'lazy', undefined)).toBe(true);

    engine[Symbol.dispose]();
  });

  it('is false for an undefined (legacy) revision on a multi-candidate dynamic source — ambiguous, matching resolveExecutableRegistrationForRevision()\'s "legacy-ambiguous" classification', async () => {
    const engine = await newEngine();
    registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    registerLazy(engine, lazyRevisionB, async () => ({
      lazy: { ...lazyDefinition, name: 'lazy' },
    }));
    const internals = getInternals(engine);

    expect(canResolveRevisionLocally(internals, 'lazy', undefined)).toBe(false);

    engine[Symbol.dispose]();
  });

  it('is true for a defined revision this process has registered as a candidate, even before it has been loaded', async () => {
    const engine = await newEngine();
    registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const internals = getInternals(engine);

    expect(canResolveRevisionLocally(internals, 'lazy', lazyRevision)).toBe(true);

    engine[Symbol.dispose]();
  });

  it('is false for a defined revision this process has never registered as a candidate', async () => {
    const engine = await newEngine();
    registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const internals = getInternals(engine);

    expect(canResolveRevisionLocally(internals, 'lazy', 'sha256:never-registered')).toBe(false);

    engine[Symbol.dispose]();
  });

  it('is false for a defined revision that WAS the sole registered candidate but a different one is registered now', async () => {
    const engine = await newEngine();
    registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const internals = getInternals(engine);

    // `lazyRevisionB` was never registered on THIS engine instance at all —
    // stands in for "the candidate set moved on since this pin was taken".
    expect(canResolveRevisionLocally(internals, 'lazy', lazyRevisionB)).toBe(false);

    engine[Symbol.dispose]();
  });
});

/**
 * The core bug this batch fixes (WFT-19): `loadAndInstallSourceRevision()`
 * used to mirror a freshly-loaded dynamic-source revision's `ActivityRegistry`
 * into the TYPE-keyed `internals.activityRegistriesByWorkflow` map. When two
 * revisions of the same dynamic-source type are loaded in one process, the
 * second load silently overwrote the first revision's entry — every
 * subsequent `ctx.run('activityName')` call from EITHER running instance
 * then resolved through whichever revision loaded last, not necessarily its
 * own. This proves the fix in-process: run A (pinned to revision A) stays
 * parked while run B (pinned to revision B) starts, resolves, and installs —
 * clobbering the pre-fix shared map — then run A's OWN activity call, made
 * strictly AFTER B has loaded, must still resolve A's own implementation.
 */
describe('activity dispatch does not clobber across revisions (WFT-19)', () => {
  it('a run pinned to revision A resolves its own per-workflow activity after a sibling run pinned to revision B loads', async () => {
    const storage = new MemoryStorage();
    const definitionA = workflow({ name: 'clobber', description: 'candidate A' })
      .activities({ whoami: async () => 'activity-A' })
      .execute(async function* (ctx: WorkflowContext) {
        const value = yield* ctx.waitForSignal<string>('go');
        const who = yield* ctx.run('whoami');
        return `${value}:${String(who)}`;
      });
    const definitionB = workflow({ name: 'clobber', description: 'candidate B' })
      .activities({ whoami: async () => 'activity-B' })
      .execute(async function* () {
        return 'unused';
      });
    const revisionA = await revisionFor(definitionA);
    const revisionB = await revisionFor(definitionB);

    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.registerSource(
      workflowSource(
        { name: 'clobber', location: './a.ts', exportName: 'a', revision: revisionA },
        async () => ({ a: definitionA }),
      ),
    );
    engine.registerSource(
      workflowSource(
        { name: 'clobber', location: './b.ts', exportName: 'b', revision: revisionB },
        async () => ({ b: definitionB }),
      ),
    );

    // Activate and start run A pinned to revision A; it parks on the signal
    // before calling its activity.
    await engine.resolveWorkflowSource('clobber', revisionA);
    await activateDynamicSourceRevision(engine, 'clobber', revisionA);
    const runA = await engine.start('clobber', null, { id: 'clobber-a' });

    // Activate and start run B pinned to revision B — loads and installs B
    // AFTER A is already running, clobbering the pre-fix shared
    // type-keyed activity-registry map.
    await engine.resolveWorkflowSource('clobber', revisionB);
    await activateDynamicSourceRevision(engine, 'clobber', revisionB);
    const runB = await engine.start('clobber', null, { id: 'clobber-b' });
    expect(await runB.result()).toBe('unused');

    // A's activity call happens strictly after B has loaded and installed.
    await runA.signal('go', 'x');
    expect(await runA.result()).toBe('x:activity-A');

    engine[Symbol.dispose]();
  });
});
