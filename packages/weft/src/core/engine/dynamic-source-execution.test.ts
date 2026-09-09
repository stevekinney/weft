import { beforeAll, describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowDefinition } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import {
  DynamicWorkflowSourceUnavailableError,
  WorkflowSourceNotRegisteredError,
} from './dynamic-source-errors.ts';
import {
  getResolvedDynamicRegistration,
  resolveExecutableRegistration,
  resolveExecutableRegistrationOrRenamedNotFound,
} from './dynamic-source-execution.ts';
import { WorkflowNotRegisteredError } from './errors.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';

const eagerDefinition = workflow({ name: 'eager' }).execute(async function* () {
  return 'eager-done';
});

const lazyDefinition = workflow({ name: 'lazy' }).execute(async function* () {
  return 'lazy-done';
});

async function revisionFor(definition: WorkflowDefinition): Promise<string> {
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  const manifest = await buildWorkflowManifestFromDefinition(
    registered,
    new ActivityRegistry().listDefinitions(),
  );
  return manifest.revision;
}

let lazyRevision: string;
let lazyRevisionB: string;

beforeAll(async () => {
  lazyRevision = await revisionFor(lazyDefinition as WorkflowDefinition);
  // A second, distinct revision for the same name — differ by description so
  // the derived revision hash differs from `lazyRevision`.
  const variant = workflow({ name: 'lazy', description: 'variant-b' }).execute(async function* () {
    return 'lazy-b-done';
  });
  lazyRevisionB = await revisionFor(variant as WorkflowDefinition);
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
    expect(getResolvedDynamicRegistration(internals, 'lazy')).toBeUndefined();

    deferred.resolve({ lazy: lazyDefinition });
    await promise;
    expect(resolved).toBe(true);

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

    expect(getResolvedDynamicRegistration(internals, 'lazy')).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('returns the eager registration first when both an eager and a resolved dynamic entry exist under different names', async () => {
    const engine = await newEngine();
    engine.register(eagerDefinition);
    const internals = getInternals(engine);

    expect(getResolvedDynamicRegistration(internals, 'eager')?.handler).toBe(
      eagerDefinition.handler,
    );

    engine[Symbol.dispose]();
  });

  it('falls back to the most recently resolved dynamic-source definition', async () => {
    const engine = await newEngine();
    registerLazy(engine, lazyRevision, async () => ({ lazy: lazyDefinition }));
    const internals = getInternals(engine);
    await resolveExecutableRegistration(engine, internals, 'lazy');

    const registration = getResolvedDynamicRegistration(internals, 'lazy');

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
