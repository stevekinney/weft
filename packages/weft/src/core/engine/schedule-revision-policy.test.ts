/**
 * Schedule revision policy (WFT-20): `'active-at-fire'` (default, unchanged
 * behavior) resolves whatever revision is active at each fire;
 * `'pinned'` captures the revision active at create/update time and forces
 * every future occurrence to resolve exactly that revision, pausing the
 * schedule if it later becomes unavailable. Mirrors
 * `dynamic-source-execution.test.ts`'s two-revision dynamic-source setup.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { ScheduleFiredEvent } from '../events.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowContext, type WorkflowDefinition } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';

type Clock = { now: number };

function createEngine(clock: Clock, storage = new MemoryStorage()) {
  return new Engine({ storage, getNow: () => clock.now });
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function drainEngine(): Promise<void> {
  await yieldToEventLoop();
  await yieldToEventLoop();
}

async function tickEngine(engine: Engine, clock: Clock, nextNow: number): Promise<void> {
  clock.now = nextNow;
  await engine.scheduler.tick(clock.now);
  await drainEngine();
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

const revisionADefinition = workflow({ name: 'revision-policy-lazy' }).execute(async function* (
  _ctx: WorkflowContext,
  input: string,
) {
  return `a:${input}`;
});
const revisionBDefinition = workflow({
  name: 'revision-policy-lazy',
  description: 'revision-b',
}).execute(async function* (_ctx: WorkflowContext, input: string) {
  return `b:${input}`;
});

/**
 * Activate `revision` as the durable active pointer for `type`, reading and
 * supplying the current generation each call — `engine.workflows.activate()`
 * REFUSES (returns `{ applied: false, reason: 'expected-generation-required' }`,
 * it does not throw) when `name` already has an active pointer and no
 * `expectedGeneration` is supplied, so a bare `await engine.workflows.activate(type, revision)`
 * silently no-ops on every call after the first.
 */
async function activateLazyRevision(engine: Engine, type: string, revision: string): Promise<void> {
  const active = await engine.workflows.getActive(type);
  const result = await engine.workflows.activate(type, revision, {
    ...(active !== null && { expectedGeneration: active.generation }),
    policy: { requireExactRevision: false },
  });
  if (!result.applied) {
    throw new Error(`Failed to activate "${type}"@"${revision}": ${JSON.stringify(result)}`);
  }
}

function registerRevision(engine: Engine, revision: string, definition: WorkflowDefinition): void {
  engine.registerSource(
    workflowSource(
      { name: 'revision-policy-lazy', location: './lazy.ts', exportName: 'lazy', revision },
      async () => ({ lazy: definition }),
    ),
  );
}

/** Collects every `schedule:fired` event's launched workflow id, in fire order. */
function trackFiredWorkflowIds(engine: Engine): string[] {
  const workflowIds: string[] = [];
  engine.addEventListener(ScheduleFiredEvent.type, (event) => {
    workflowIds.push(event.workflowId);
  });
  return workflowIds;
}

describe('schedule revisionPolicy (WFT-20)', () => {
  it("defaults to 'active-at-fire' and resolves whichever revision is active at each fire, even across an activation change between fires", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const revisionA = await revisionFor(revisionADefinition as WorkflowDefinition);
    const revisionB = await revisionFor(revisionBDefinition as WorkflowDefinition);
    registerRevision(engine, revisionA, revisionADefinition as WorkflowDefinition);
    registerRevision(engine, revisionB, revisionBDefinition as WorkflowDefinition);
    await engine.resolveWorkflowSource('revision-policy-lazy', revisionA);
    await activateLazyRevision(engine, 'revision-policy-lazy', revisionA);
    const firedWorkflowIds = trackFiredWorkflowIds(engine);

    const handle = await engine.schedule('revision-policy-lazy', 'x', '* * * * *');
    const description = await handle.describe();
    expect(description.revisionPolicy).toBe('active-at-fire');
    expect(description.pinnedRevision).toBeUndefined();

    await tickEngine(engine, clock, description.nextFireAt!);
    expect(firedWorkflowIds).toHaveLength(1);
    const firstState = await engine.get(firedWorkflowIds[0]!);
    expect(firstState?.revision).toBe(revisionA);

    // Activate a DIFFERENT revision between fires.
    await engine.resolveWorkflowSource('revision-policy-lazy', revisionB);
    await activateLazyRevision(engine, 'revision-policy-lazy', revisionB);

    const secondDescription = await handle.describe();
    await tickEngine(engine, clock, secondDescription.nextFireAt!);
    expect(firedWorkflowIds).toHaveLength(2);
    const secondState = await engine.get(firedWorkflowIds[1]!);
    expect(secondState?.revision).toBe(revisionB);

    engine[Symbol.dispose]();
  });

  it("'pinned' captures the active revision at create time and every future fire resolves it, even after a different revision is activated", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const revisionA = await revisionFor(revisionADefinition as WorkflowDefinition);
    const revisionB = await revisionFor(revisionBDefinition as WorkflowDefinition);
    registerRevision(engine, revisionA, revisionADefinition as WorkflowDefinition);
    registerRevision(engine, revisionB, revisionBDefinition as WorkflowDefinition);
    await engine.resolveWorkflowSource('revision-policy-lazy', revisionA);
    await activateLazyRevision(engine, 'revision-policy-lazy', revisionA);
    const firedWorkflowIds = trackFiredWorkflowIds(engine);

    const handle = await engine.schedule('revision-policy-lazy', 'x', '* * * * *', {
      revisionPolicy: 'pinned',
    });
    const description = await handle.describe();
    expect(description.revisionPolicy).toBe('pinned');
    expect(description.pinnedRevision).toBe(revisionA);

    // Activate a DIFFERENT revision before the schedule ever fires.
    await engine.resolveWorkflowSource('revision-policy-lazy', revisionB);
    await activateLazyRevision(engine, 'revision-policy-lazy', revisionB);

    await tickEngine(engine, clock, description.nextFireAt!);
    expect(firedWorkflowIds).toHaveLength(1);
    const state = await engine.get(firedWorkflowIds[0]!);
    expect(state?.revision).toBe(revisionA);

    engine[Symbol.dispose]();
  });

  it('pauses the schedule when the pinned revision becomes unavailable in this process', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const revisionA = await revisionFor(revisionADefinition as WorkflowDefinition);
    const revisionB = await revisionFor(revisionBDefinition as WorkflowDefinition);
    registerRevision(engine, revisionA, revisionADefinition as WorkflowDefinition);
    registerRevision(engine, revisionB, revisionBDefinition as WorkflowDefinition);
    await engine.resolveWorkflowSource('revision-policy-lazy', revisionA);
    await activateLazyRevision(engine, 'revision-policy-lazy', revisionA);
    await engine.resolveWorkflowSource('revision-policy-lazy', revisionB);
    await activateLazyRevision(engine, 'revision-policy-lazy', revisionB);

    const handle = await engine.schedule('revision-policy-lazy', 'x', '* * * * *', {
      revisionPolicy: 'pinned',
    });
    const description = await handle.describe();
    expect(description.pinnedRevision).toBe(revisionB);

    // The pinned revision's own reference (`pinnedSchedules`) is exactly
    // what keeps `removeWorkflowRevision()` from removing it out from under
    // this still-active schedule — so simulate the pin becoming unavailable
    // the way it actually happens in practice: a fresh process's own
    // dynamic-source registration for this EXACT revision is simply absent
    // (never `registerSource()`-registered there), mirroring
    // `resolveExecutableRegistrationForRevision()`'s documented
    // `reason: 'not-registered'` case.
    getInternals(engine).sources.byName.get('revision-policy-lazy')?.delete(revisionB);

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await tickEngine(engine, clock, description.nextFireAt!);
      const pausedDescription = await handle.describe();
      expect(pausedDescription.status).toBe('paused');
    } finally {
      errorSpy.mockRestore();
    }

    engine[Symbol.dispose]();
  });

  it('eager type pin fails when a redeploy replaces the pinned revision without matching it exactly', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const definition = workflow({ name: 'revision-policy-eager' }).execute(async function* (
      _ctx: WorkflowContext,
    ) {
      return 'eager-done';
    });
    engine.register(definition);

    const handle = await engine.schedule('revision-policy-eager', null, '* * * * *', {
      revisionPolicy: 'pinned',
    });
    const description = await handle.describe();
    expect(description.revisionPolicy).toBe('pinned');
    expect(typeof description.pinnedRevision).toBe('string');

    // Simulate a redeploy: `engine.register()` refuses to re-register the
    // SAME name with different content (see `registration.ts`'s collision
    // guard), which is not what a real redeploy in a NEW process looks
    // like anyway — a fresh process's own `registeredCatalogRevisions` entry
    // simply names whatever code IT loaded, independent of any prior pin.
    // Mutate that map directly, exactly as `pinned-schedule-revision.test.ts`
    // does for the identical scenario.
    getInternals(engine).registeredCatalogRevisions.set(
      'revision-policy-eager',
      'a-newly-deployed-revision-this-schedule-never-pinned',
    );

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await tickEngine(engine, clock, description.nextFireAt!);
      const pausedDescription = await handle.describe();
      expect(pausedDescription.status).toBe('paused');
    } finally {
      errorSpy.mockRestore();
    }

    engine[Symbol.dispose]();
  });
});

describe('updateSchedule() revisionPolicy transitions (WFT-20)', () => {
  it('switching active-at-fire -> pinned captures the current revision; pinned -> active-at-fire clears it; re-pinning while already pinned re-resolves', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const revisionA = await revisionFor(revisionADefinition as WorkflowDefinition);
    const revisionB = await revisionFor(revisionBDefinition as WorkflowDefinition);
    registerRevision(engine, revisionA, revisionADefinition as WorkflowDefinition);
    registerRevision(engine, revisionB, revisionBDefinition as WorkflowDefinition);
    await engine.resolveWorkflowSource('revision-policy-lazy', revisionA);
    await activateLazyRevision(engine, 'revision-policy-lazy', revisionA);

    const handle = await engine.schedule('revision-policy-lazy', 'x', '* * * * *');
    const initial = await handle.describe();
    expect(initial.revisionPolicy).toBe('active-at-fire');

    await handle.update('* * * * *', { revisionPolicy: 'pinned' });
    const pinnedAtA = await handle.describe();
    expect(pinnedAtA.revisionPolicy).toBe('pinned');
    expect(pinnedAtA.pinnedRevision).toBe(revisionA);

    await engine.resolveWorkflowSource('revision-policy-lazy', revisionB);
    await activateLazyRevision(engine, 'revision-policy-lazy', revisionB);

    // Re-issuing 'pinned' while already pinned RE-resolves against the
    // revision active right now — never a no-op.
    await handle.update('* * * * *', { revisionPolicy: 'pinned' });
    const rePinnedAtB = await handle.describe();
    expect(rePinnedAtB.revisionPolicy).toBe('pinned');
    expect(rePinnedAtB.pinnedRevision).toBe(revisionB);

    await handle.update('* * * * *', { revisionPolicy: 'active-at-fire' });
    const clearedPin = await handle.describe();
    expect(clearedPin.revisionPolicy).toBe('active-at-fire');
    expect(clearedPin.pinnedRevision).toBeUndefined();

    // Omitting revisionPolicy entirely preserves the current (active-at-fire) state.
    await handle.update('*/5 * * * *', {});
    const preserved = await handle.describe();
    expect(preserved.revisionPolicy).toBe('active-at-fire');
    expect(preserved.pinnedRevision).toBeUndefined();

    engine[Symbol.dispose]();
  });
});
