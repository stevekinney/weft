/**
 * Direct unit coverage for `resolveAndReservePinnedExecutableRegistration()`
 * and `resolveScheduleRevisionForPin()` (WFT-20) — the fire-time and
 * capture-time resolvers a pinned schedule uses. `schedule-revision-policy.test.ts`
 * exercises these through a real `engine.schedule()`/timer-fire round trip;
 * this file isolates the resolver's own branches (eager exact-match,
 * eager mismatch, dynamic-source delegation) the way
 * `dynamic-source-execution.test.ts` isolates `resolveExecutableRegistrationForRevision()`.
 */
import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowDefinition } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import {
  resolveAndReservePinnedExecutableRegistration,
  resolveScheduleRevisionForPin,
} from './pinned-schedule-revision.ts';
import { buildRegistrationEntry } from './registration.ts';
import { WorkflowRevisionUnavailableError } from './revision-errors.ts';

const eagerDefinition = workflow({ name: 'pinned-eager' }).execute(async function* () {
  return 'eager-done';
});

const lazyDefinition = workflow({ name: 'pinned-lazy' }).execute(async function* () {
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

async function newEngine() {
  const storage = new MemoryStorage();
  return new Engine({ storage, backgroundTasks: 'manual' });
}

describe('resolveScheduleRevisionForPin', () => {
  it('resolves an eager type synchronously to its registeredCatalogRevisions entry', async () => {
    const engine = await newEngine();
    engine.register(eagerDefinition);
    const internals = getInternals(engine);

    const revision = await resolveScheduleRevisionForPin(engine, internals, 'pinned-eager');

    expect(revision).toBe(internals.registeredCatalogRevisions.get('pinned-eager')!);

    engine[Symbol.dispose]();
  });
});

describe('resolveAndReservePinnedExecutableRegistration', () => {
  it('resolves an eager type whose registered revision matches the pin exactly', async () => {
    const engine = await newEngine();
    engine.register(eagerDefinition);
    const internals = getInternals(engine);
    const pinned = internals.registeredCatalogRevisions.get('pinned-eager')!;

    const result = await resolveAndReservePinnedExecutableRegistration(
      engine,
      internals,
      'pinned-eager',
      pinned,
    );

    expect(result.registration).toBeDefined();

    engine[Symbol.dispose]();
  });

  it('rejects an eager type whose registered revision no longer matches the pin (a "redeploy")', async () => {
    const engine = await newEngine();
    engine.register(eagerDefinition);
    const internals = getInternals(engine);

    const rejection = await resolveAndReservePinnedExecutableRegistration(
      engine,
      internals,
      'pinned-eager',
      'a-revision-this-process-never-registered',
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect((rejection as WorkflowRevisionUnavailableError).reason).toBe('not-registered');

    engine[Symbol.dispose]();
  });

  it('does NOT silently fall back to whatever is active for an eager type with a mismatched pin — unlike resolveExecutableRegistrationForRevision', async () => {
    const engine = await newEngine();
    engine.register(eagerDefinition);
    const internals = getInternals(engine);
    const registeredRevision = internals.registeredCatalogRevisions.get('pinned-eager')!;

    // Simulate a redeploy: the process's own registeredCatalogRevisions now
    // names a DIFFERENT revision than the schedule's captured pin.
    internals.registeredCatalogRevisions.set('pinned-eager', 'a-newly-deployed-revision');

    const rejection = await resolveAndReservePinnedExecutableRegistration(
      engine,
      internals,
      'pinned-eager',
      registeredRevision,
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(WorkflowRevisionUnavailableError);

    engine[Symbol.dispose]();
  });

  it('delegates a dynamic-source type to resolveExecutableRegistrationForRevision unchanged', async () => {
    const engine = await newEngine();
    const internals = getInternals(engine);
    const revision = await revisionFor(lazyDefinition);
    const loader = mock(async () => ({ lazy: lazyDefinition }));
    engine.registerSource(
      workflowSource(
        { name: 'pinned-lazy', location: './lazy.ts', exportName: 'lazy', revision },
        loader,
      ),
    );

    const result = await resolveAndReservePinnedExecutableRegistration(
      engine,
      internals,
      'pinned-lazy',
      revision,
    );

    expect(result.registration).toBeDefined();
    expect(result.resolvedRevision).toBe(revision);
    expect(loader).toHaveBeenCalledTimes(1);

    engine[Symbol.dispose]();
  });

  it('rejects a dynamic-source type pinned to a revision that was never registered', async () => {
    const engine = await newEngine();
    const internals = getInternals(engine);
    const revision = await revisionFor(lazyDefinition);
    engine.registerSource(
      workflowSource(
        { name: 'pinned-lazy', location: './lazy.ts', exportName: 'lazy', revision },
        async () => ({ lazy: lazyDefinition }),
      ),
    );

    const rejection = await resolveAndReservePinnedExecutableRegistration(
      engine,
      internals,
      'pinned-lazy',
      'never-registered-revision',
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect((rejection as WorkflowRevisionUnavailableError).reason).toBe('not-registered');

    engine[Symbol.dispose]();
  });
});
