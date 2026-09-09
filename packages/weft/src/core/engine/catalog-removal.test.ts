import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { WorkflowRevisionRemovedEvent } from '../events/catalog-events.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowContext, type WorkflowDefinition } from '../types.ts';
import { activateCatalogRevisionCandidate } from './catalog-activation.ts';
import { ensureWorkflowCatalogReady } from './catalog-readiness.ts';
import {
  countWorkflowRevisionReferences,
  getWorkflowRevisionDiagnostics,
  releaseInFlightStart,
  removeWorkflowRevision,
  reserveInFlightStart,
} from './catalog-removal.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { Engine } from './index.ts';
import { getInternals, getWorkflowCatalog } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';

async function manifestFor(
  name: string,
  version: string,
  overrides?: { revision?: string; description?: string },
): Promise<WorkflowRevisionManifest> {
  const contract = buildWorkflowContract({
    name,
    version,
    ...(overrides?.description === undefined ? {} : { description: overrides.description }),
  });
  return buildWorkflowRevisionManifest(
    contract,
    overrides?.revision === undefined ? undefined : { revision: overrides.revision },
  );
}

function noopWorkflow(name: string, version = '1.0.0') {
  return workflow({ name, version }).execute(async function* (_ctx: WorkflowContext) {
    return 'done';
  });
}

describe('removeWorkflowRevision', () => {
  it('reports "not-found" for a (name, revision) that was never installed', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });

    const result = await removeWorkflowRevision(engine, 'checkout', 'never-installed');

    expect(result).toEqual({ removed: false, reason: 'not-found' });
  });

  it('refuses removal of the active revision', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const result = await removeWorkflowRevision(engine, 'checkout', revision);

    expect(result).toEqual({ removed: false, reason: 'active', activeRevision: revision });
  });

  it('is rejected while registeredDefinitions references the (non-active) revision', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    // `registeredCatalogRevisions` is written ONLY by the register()-drain
    // path — moving the active pointer away via `activateCatalogRevisionCandidate`
    // (the guarded primitive, distinct from register()) does NOT update it.
    // revA is no longer active, but this process's own registration still
    // names it — a real, distinct guard from the "active" check above.
    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'a later revision' });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    expect(getWorkflowCatalog(engine).resolveActive('checkout')?.revision).toBe(manifestB.revision);
    expect(getInternals(engine).registeredCatalogRevisions.get('checkout')).toBe(revA);

    const result = await removeWorkflowRevision(engine, 'checkout', revA);

    expect(result.removed).toBe(false);
    if (!result.removed && result.reason === 'referenced') {
      expect(result.references.registeredDefinitions).toBe(1);
    } else {
      throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(result)}`);
    }
  });

  it('is rejected while inFlightStarts references the (non-active) revision, and succeeds once released', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    const startedHandle = await engine.start('checkout', null);
    // Drive the run to completion so this test's later "removal succeeds"
    // assertion isn't blocked by the NEW `nonTerminalRuns` reference count
    // (WFT-17) — this test is about `inFlightStarts`, not non-terminal runs.
    await startedHandle.result();
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;
    getInternals(engine).registeredCatalogRevisions.delete('checkout');

    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'a later revision' });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });

    // Directly seed the in-flight-start signal against the now-non-active
    // revA, mirroring what a real parked `startWorkflow` reserved while
    // revA was still active (see the deferred-start test below for the
    // real code path exercising the increment/decrement itself).
    getInternals(engine).inFlightStartsByRevision.set('checkout', new Map([[revA, 1]]));

    const rejected = await removeWorkflowRevision(engine, 'checkout', revA);
    expect(rejected.removed).toBe(false);
    if (!rejected.removed && rejected.reason === 'referenced') {
      expect(rejected.references.inFlightStarts).toBe(1);
    } else {
      throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(rejected)}`);
    }

    getInternals(engine).inFlightStartsByRevision.set('checkout', new Map());
    const events: WorkflowRevisionRemovedEvent[] = [];
    engine.addEventListener(WorkflowRevisionRemovedEvent.type, (e) => events.push(e));

    const succeeded = await removeWorkflowRevision(engine, 'checkout', revA);

    expect(succeeded).toEqual({ removed: true });
    expect(events).toHaveLength(1);
    expect(events[0]?.revision).toBe(revA);
    expect(getWorkflowCatalog(engine).getEntry('checkout', revA)).toBeUndefined();
  });

  it('the inFlightStarts counter itself is reserved/released around a real in-flight start()', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    // Prime the catalog (install + activate) before delaying storage.batch,
    // so the delay below only affects the CREATE write, not catalog drain.
    await engine.start('checkout', 'priming').then((h) => h.result());
    const revision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalBatch = storage.batch.bind(storage);
    let batchCalls = 0;
    storage.batch = async (operations) => {
      batchCalls += 1;
      if (batchCalls === 1) {
        entered.resolve();
        await gate.promise;
      }
      return originalBatch(operations);
    };

    const startPromise = engine.start('checkout', 'parked');
    await entered.promise;

    // The start is now parked mid-flight: the increment already ran
    // (synchronously, before the delayed storage.batch call), so the
    // in-flight signal is observable right now.
    const diagnosticsWhileParked = await getWorkflowRevisionDiagnostics(
      engine,
      'checkout',
      revision,
    );
    expect(diagnosticsWhileParked.references.inFlightStarts).toBeGreaterThanOrEqual(1);

    gate.resolve();
    await startPromise;

    const diagnosticsAfter = await getWorkflowRevisionDiagnostics(engine, 'checkout', revision);
    expect(diagnosticsAfter.references.inFlightStarts).toBe(0);
  });

  it('is also reserved/released for a real child-workflow start via ctx.startChild(), not just a top-level engine.start()', async () => {
    // Regression for the documented (but previously untested) claim: a
    // direct child start funnels through the same `lifecycle/start.ts`
    // `startWorkflow` choke point as a top-level start, since
    // `createChildWorkflowOperationCallbacks` calls it directly — so
    // `ctx.startChild()` must feed `inFlightStarts` exactly like the
    // in-flight top-level start above does.
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    engine.register(
      workflow({ name: 'checkout-parent' }).execute(async function* (
        ctx: WorkflowContext,
        input: { startChild: boolean },
      ) {
        if (!input.startChild) return 'primed';
        return yield* ctx.startChild('checkout', null, { id: 'checkout-parent-child' });
      }),
    );

    // Prime both catalog entries (install + activate for 'checkout' and
    // 'checkout-parent') before delaying storage.batch, and prime the
    // parent WITHOUT starting a child, so the delay below only affects the
    // child's own CREATE write.
    await engine.start('checkout', 'priming').then((h) => h.result());
    await engine
      .start('checkout-parent', { startChild: false }, { id: 'priming-parent' })
      .then((h) => h.result());
    const revision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalBatch = storage.batch.bind(storage);
    let batchCalls = 0;
    let paused = false;
    storage.batch = async (operations) => {
      batchCalls += 1;
      const internals = getInternals(engine);
      const alreadyReserved =
        (internals.inFlightStartsByRevision.get('checkout')?.get(revision) ?? 0) > 0;
      if (!paused && alreadyReserved) {
        paused = true;
        entered.resolve();
        await gate.promise;
      }
      return originalBatch(operations);
    };

    const parentPromise = engine.start('checkout-parent', { startChild: true });
    await entered.promise;

    const diagnosticsWhileParked = await getWorkflowRevisionDiagnostics(
      engine,
      'checkout',
      revision,
    );
    expect(diagnosticsWhileParked.references.inFlightStarts).toBeGreaterThanOrEqual(1);

    gate.resolve();
    await parentPromise.then((h) => h.result());

    const diagnosticsAfter = await getWorkflowRevisionDiagnostics(engine, 'checkout', revision);
    expect(diagnosticsAfter.references.inFlightStarts).toBe(0);
  });

  it('succeeds removing a non-active revision once no reference remains (in a second process/engine that never registered it)', async () => {
    await using storage = new MemoryStorage();
    await using engineA = new Engine({ storage, backgroundTasks: 'manual' });
    engineA.register(noopWorkflow('checkout'));
    // Drive the run to completion — `countWorkflowRevisionReferences()`'s
    // `nonTerminalRuns` (WFT-17) is a DURABLE storage scan, so a genuinely
    // non-terminal run pinned to `revA` would correctly block removal from
    // ANY engine, not just this in-process-accounting-gap scenario this
    // test targets (`registeredDefinitions`/`inFlightStarts`, both
    // process-local).
    await engineA.start('checkout', null).then((h) => h.result());
    const revA = getWorkflowCatalog(engineA).resolveActive('checkout')!.revision;

    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'a later revision' });
    await activateCatalogRevisionCandidate(engineA, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });

    // A SECOND engine over the same durable store — the realistic
    // "release" path in this batch's in-process-only accounting: it never
    // registered `checkout` at all, so its own registeredCatalogRevisions
    // and inFlightStartsByRevision are empty for revA. This is also the
    // concrete shape of the documented multi-process gap: engineB can
    // remove a revision engineA's OWN process might still consider live if
    // engineA had registered it.
    await using engineB = new Engine({ storage, backgroundTasks: 'manual' });
    const events: WorkflowRevisionRemovedEvent[] = [];
    engineB.addEventListener(WorkflowRevisionRemovedEvent.type, (e) => events.push(e));

    const result = await removeWorkflowRevision(engineB, 'checkout', revA);

    expect(result).toEqual({ removed: true });
    expect(events).toHaveLength(1);
  });

  it('refuses removal of a revision a SECOND process durably activated after this process cached it as installed-but-inactive', async () => {
    await using storage = new MemoryStorage();
    await using engineA = new Engine({ storage, backgroundTasks: 'manual' });
    engineA.register(noopWorkflow('checkout'));
    await engineA.start('checkout', null);
    const revA = getWorkflowCatalog(engineA).resolveActive('checkout')!.revision;

    // engineA learns about revB (installs it into ITS OWN in-memory cache)
    // but never activates it itself, so engineA's cached active pointer for
    // 'checkout' stays revA.
    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'a later revision' });
    await getWorkflowCatalog(engineA).install(manifestB);
    expect(getWorkflowCatalog(engineA).resolveActive('checkout')?.revision).toBe(revA);

    // A SECOND process (engineB, same durable store) durably activates
    // revB — moving the durable active pointer to revB WITHOUT ever
    // touching engineA's in-memory `#active` cache, which stays stale at
    // revA. This is the ADR 0002 workflow-lease scenario: a second engine
    // durably activating a revision this process only knows as installed.
    await using engineB = new Engine({ storage, backgroundTasks: 'manual' });
    await activateCatalogRevisionCandidate(engineB, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });

    // engineA's OWN stale cache still says revA is active — proving this
    // regression genuinely exercises the cache/durable-truth divergence,
    // not just a fresh, never-populated cache.
    expect(getWorkflowCatalog(engineA).resolveActive('checkout')?.revision).toBe(revA);

    // Diagnostics and removal, both issued against engineA, MUST consult
    // durable truth rather than engineA's stale cache: revB is durably
    // active, so it must never be reported removable, and removal must be
    // refused with 'active' rather than silently deleting a durably-active
    // revision.
    const diagnostics = await getWorkflowRevisionDiagnostics(
      engineA,
      'checkout',
      manifestB.revision,
    );
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.active).toBe(true);
    expect(diagnostics.activeRevision).toBe(manifestB.revision);
    expect(diagnostics.removable).toBe(false);

    const result = await removeWorkflowRevision(engineA, 'checkout', manifestB.revision);
    expect(result).toEqual({
      removed: false,
      reason: 'active',
      activeRevision: manifestB.revision,
    });
  });

  it('succeeds removing a revision a SECOND process durably installed that this process never cached at all', async () => {
    // Distinct from the "installed-but-inactive" regression above: here
    // engineA's `#entries` cache has NEVER heard of revC — this is
    // `hasInstalled()`'s own storage-read-through fallback branch (a cache
    // MISS, not a stale cache HIT), exercised through `removeWorkflowRevision`'s
    // precheck rather than `hasInstalled()`'s own unit tests.
    await using storage = new MemoryStorage();
    await using engineA = new Engine({ storage, backgroundTasks: 'manual' });
    engineA.register(noopWorkflow('checkout'));
    await engineA.start('checkout', null);

    const manifestC = await manifestFor('checkout', '1.0.0', {
      description: 'installed elsewhere',
    });
    await using engineB = new Engine({ storage, backgroundTasks: 'manual' });
    // Force engineB's own catalog readiness (restore) before reaching for
    // its `WorkflowCatalog` directly — `getWorkflowCatalog()` throws if
    // `ensureWorkflowCatalogReady()` was never awaited first.
    await getWorkflowRevisionDiagnostics(engineB, 'checkout', 'priming-read');
    // Install only — never activated, so it stays non-active and
    // unreferenced, and engineA's own catalog restore (already completed
    // above, before this write) never picks it up either.
    await getWorkflowCatalog(engineB).install(manifestC);

    expect(getWorkflowCatalog(engineA).getEntry('checkout', manifestC.revision)).toBeUndefined();

    const result = await removeWorkflowRevision(engineA, 'checkout', manifestC.revision);

    expect(result).toEqual({ removed: true });
  });

  it('reports "conflict" when the durable delete loses its CAS', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;
    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'later' });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    getInternals(engine).registeredCatalogRevisions.delete('checkout');
    // Stub AFTER every real install/activation write above so this only
    // fails removal's own CAS, not an earlier catalog write.
    storage.conditionalBatch = async () => false;

    const result = await removeWorkflowRevision(engine, 'checkout', revA);

    expect(result).toEqual({ removed: false, reason: 'conflict' });
  });

  it("surfaces catalog.remove()'s own 'not-found' outcome (a TOCTOU race between the top-level check and the delete)", async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;
    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'later' });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    getInternals(engine).registeredCatalogRevisions.delete('checkout');
    const catalog = getWorkflowCatalog(engine);
    // Simulate the entry disappearing between removeWorkflowRevision's own
    // getEntry() precheck and the delegated catalog.remove() call actually
    // running — a real, if narrow, race window this switch must still
    // handle correctly rather than assuming impossible.
    catalog.remove = async () => ({ outcome: 'not-found' });

    const result = await removeWorkflowRevision(engine, 'checkout', revA);

    expect(result).toEqual({ removed: false, reason: 'not-found' });
  });

  it("surfaces catalog.remove()'s own 'active' outcome (a TOCTOU race between the top-level check and the delete)", async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;
    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'later' });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    getInternals(engine).registeredCatalogRevisions.delete('checkout');
    const catalog = getWorkflowCatalog(engine);
    // Simulate revA becoming active again between the top-level "not the
    // active revision" check and the delegated catalog.remove() call.
    catalog.remove = async () => ({ outcome: 'active', activeRevision: revA });

    const result = await removeWorkflowRevision(engine, 'checkout', revA);

    expect(result).toEqual({ removed: false, reason: 'active', activeRevision: revA });
  });
});

describe('getWorkflowRevisionDiagnostics', () => {
  it('reports installed:false and removable:false for an unknown (name, revision)', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });

    const diagnostics = await getWorkflowRevisionDiagnostics(engine, 'checkout', 'unknown');

    expect(diagnostics.installed).toBe(false);
    expect(diagnostics.active).toBe(false);
    expect(diagnostics.activeRevision).toBeUndefined();
    expect(diagnostics.removable).toBe(false);
  });

  it('reports installed:true, active:true, removable:false for the active revision', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const diagnostics = await getWorkflowRevisionDiagnostics(engine, 'checkout', revision);

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.active).toBe(true);
    expect(diagnostics.activeRevision).toBe(revision);
    expect(diagnostics.removable).toBe(false);
  });

  it('reports removable:true for an installed, non-active, unreferenced revision', async () => {
    await using storage = new MemoryStorage();
    await using engineA = new Engine({ storage, backgroundTasks: 'manual' });
    engineA.register(noopWorkflow('checkout'));
    await engineA.start('checkout', null);
    const revA = getWorkflowCatalog(engineA).resolveActive('checkout')!.revision;
    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'later' });
    await activateCatalogRevisionCandidate(engineA, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });

    await using engineB = new Engine({ storage, backgroundTasks: 'manual' });
    const diagnostics = await getWorkflowRevisionDiagnostics(engineB, 'checkout', revA);

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.active).toBe(false);
    expect(diagnostics.activeRevision).toBe(manifestB.revision);
    expect(diagnostics.removable).toBe(true);
  });

  it('reports removable:false for an installed, non-active, referenced revision', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;
    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'later' });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });

    const diagnostics = await getWorkflowRevisionDiagnostics(engine, 'checkout', revA);

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.active).toBe(false);
    expect(diagnostics.references.registeredDefinitions).toBe(1);
    expect(diagnostics.removable).toBe(false);
  });
});

describe('countWorkflowRevisionReferences', () => {
  it('reports zeros for the four still-structurally-present fields once the run is terminal', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    const handle = await engine.start('checkout', null);
    await handle.result();
    const revision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const references = await countWorkflowRevisionReferences(engine, 'checkout', revision);

    // `nonTerminalRuns` is real (WFT-17) but correctly 0 here: the run
    // completed above. The remaining four fields stay structurally present
    // but always 0 — each awaits revision identity in a different,
    // later-owned subsystem (see `reference-counts.ts`'s field docs).
    expect(references.nonTerminalRuns).toBe(0);
    expect(references.pinnedSchedules).toBe(0);
    expect(references.pendingDispatches).toBe(0);
    expect(references.activeExecutionRealms).toBe(0);
    expect(references.retainedRecoveryRecords).toBe(0);
  });

  it('counts a genuinely non-terminal run pinned to the exact revision, and only that revision', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const parked = workflow({ name: 'checkout', version: '1.0.0' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    engine.register(parked);
    await engine.start('checkout', null, { id: 'checkout-parked' });
    const revision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const references = await countWorkflowRevisionReferences(engine, 'checkout', revision);
    expect(references.nonTerminalRuns).toBe(1);

    // A DIFFERENT (never-installed) revision string must not match.
    const otherReferences = await countWorkflowRevisionReferences(
      engine,
      'checkout',
      `${revision}-different`,
    );
    expect(otherReferences.nonTerminalRuns).toBe(0);

    await engine.getHandle('checkout-parked')?.signal('go', 'done');
    await engine.getHandle('checkout-parked')?.result();
  });

  it('removeWorkflowRevision() refuses a revision with a non-terminal run — the WFT-12-flagged gap this batch closes', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const parked = workflow({ name: 'checkout', version: '1.0.0' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    engine.register(parked);
    await engine.start('checkout', null, { id: 'checkout-parked-2' });
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    // Move the active pointer away and clear the only OTHER reference
    // (`registeredDefinitions`) this process still holds against revA, so
    // `nonTerminalRuns` is the sole thing standing between this call and a
    // (wrongly) successful removal — before WFT-17 it always was 0 and
    // removal would have silently succeeded out from under the parked run.
    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'a later revision' });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    getInternals(engine).registeredCatalogRevisions.delete('checkout');

    const result = await removeWorkflowRevision(engine, 'checkout', revA);
    expect(result.removed).toBe(false);
    if (!result.removed && result.reason === 'referenced') {
      expect(result.references.nonTerminalRuns).toBe(1);
    } else {
      throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(result)}`);
    }

    await engine.getHandle('checkout-parked-2')?.signal('go', 'done');
    await engine.getHandle('checkout-parked-2')?.result();
  });
});

// WFT-15/16: `WorkflowRevisionDiagnostics.source` and the `revisionOverride`
// threading fix for `reserveInFlightStart`/`releaseInFlightStart`.
describe('getWorkflowRevisionDiagnostics — dynamic-source extension (WFT-15/16)', () => {
  const lazyDefinition = workflow({ name: 'lazy-checkout' }).execute(async function* () {
    return 'done';
  });

  async function lazyRevision(): Promise<string> {
    const definition = lazyDefinition as WorkflowDefinition;
    const entry = buildRegistrationEntry(definition.name, definition);
    const registered = copyWorkflowDefinition(definition.name, entry);
    const manifest = await buildWorkflowManifestFromDefinition(
      registered,
      new ActivityRegistry().listDefinitions(),
    );
    return manifest.revision;
  }

  it('omits `source` for a purely eager name', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const diagnostics = await getWorkflowRevisionDiagnostics(engine, 'checkout', revision);

    expect(diagnostics.source).toBeUndefined();
  });

  it('reports state:"idle" for a registerSource()-registered name never resolved', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const revision = await lazyRevision();
    engine.registerSource(
      workflowSource(
        { name: 'lazy-checkout', location: './lazy.ts', exportName: 'lazy', revision },
        async () => ({ lazy: lazyDefinition }),
      ),
    );

    const diagnostics = await getWorkflowRevisionDiagnostics(engine, 'lazy-checkout', revision);

    expect(diagnostics.source).toBeDefined();
    expect(diagnostics.source?.kind).toBe('module');
    expect(diagnostics.source?.requestedRevision).toBe(revision);
    expect(diagnostics.source?.state).toBe('idle');
    expect(diagnostics.source?.waiterCount).toBe(0);
  });

  it('falls back to kind "module" when querying a revision registered under no entry for this name', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const revision = await lazyRevision();
    engine.registerSource(
      workflowSource(
        { name: 'lazy-checkout', location: './lazy.ts', exportName: 'lazy', revision },
        async () => ({ lazy: lazyDefinition }),
      ),
    );

    // `lazy-checkout` IS registerSource()-registered (under `revision`), so
    // `source` is present — but THIS specific revision was never registered
    // and never resolved, so both `diagnostics` and `registeredRevisions.get()`
    // miss, exercising the last-resort 'module' fallback.
    const diagnostics = await getWorkflowRevisionDiagnostics(
      engine,
      'lazy-checkout',
      'never-registered-revision',
    );

    expect(diagnostics.source).toBeDefined();
    expect(diagnostics.source?.kind).toBe('module');
    expect(diagnostics.source?.state).toBe('idle');
  });

  it('reports state:"ready" and loadDurationMs once the source has resolved', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const revision = await lazyRevision();
    engine.registerSource(
      workflowSource(
        { name: 'lazy-checkout', location: './lazy.ts', exportName: 'lazy', revision },
        async () => ({ lazy: lazyDefinition }),
      ),
    );
    await engine.resolveWorkflowSource('lazy-checkout', revision);

    const diagnostics = await getWorkflowRevisionDiagnostics(engine, 'lazy-checkout', revision);

    expect(diagnostics.source?.state).toBe('ready');
    expect(diagnostics.source?.loadDurationMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.source?.lastFailureCategory).toBeUndefined();
  });

  it('reserveInFlightStart/releaseInFlightStart thread an explicit revisionOverride for a lazy type (revisionOverride threading fix)', async () => {
    // `reserveInFlightStart(internals, type, revisionOverride)` — the
    // `revisionOverride` fix `startWorkflow()` passes the resolved dynamic-
    // source revision through for once resolution completes (unit-level:
    // `reserveInFlightStart` re-derives via `catalog.resolveActive(type)`
    // when no override is given, which reads `undefined` for a dynamic
    // source never `engine.workflows.activate()`-d — exactly the gap this
    // parameter closes). Reproducing the live async race through a real
    // `engine.start()` call is not reliable: `reserveInFlightStart` is only
    // called AFTER `resolveExecutableRegistration()` resolves (the revision
    // must be known before a revision-scoped concurrency slot can be
    // reserved), so the in-flight window it protects is the atomic create
    // commit immediately after resolution, not the load itself.
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const revision = await lazyRevision();
    engine.registerSource(
      workflowSource(
        { name: 'lazy-checkout', location: './lazy.ts', exportName: 'lazy', revision },
        async () => ({ lazy: lazyDefinition }),
      ),
    );
    // No catalog active pointer for 'lazy-checkout' — the exact scenario
    // where the pre-fix `catalog.resolveActive(type)?.revision` read would
    // silently derive `undefined` instead of the real resolved revision.
    await ensureWorkflowCatalogReady(engine);
    expect(getWorkflowCatalog(engine).resolveActive('lazy-checkout')).toBeUndefined();

    const internals = getInternals(engine);
    const releaseRevision = reserveInFlightStart(internals, 'lazy-checkout', revision);
    expect(releaseRevision).toBe(revision);

    const diagnosticsWhileReserved = await getWorkflowRevisionDiagnostics(
      engine,
      'lazy-checkout',
      revision,
    );
    expect(diagnosticsWhileReserved.references.inFlightStarts).toBe(1);

    releaseInFlightStart(internals, 'lazy-checkout', releaseRevision);

    const diagnosticsAfter = await getWorkflowRevisionDiagnostics(
      engine,
      'lazy-checkout',
      revision,
    );
    expect(diagnosticsAfter.references.inFlightStarts).toBe(0);
  });

  it('a live engine.start() on a lazy type leaves no stale inFlightStarts reservation behind', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const revision = await lazyRevision();
    engine.registerSource(
      workflowSource(
        { name: 'lazy-checkout', location: './lazy.ts', exportName: 'lazy', revision },
        async () => ({ lazy: lazyDefinition }),
      ),
    );

    await engine.start('lazy-checkout', null);

    const diagnosticsAfter = await getWorkflowRevisionDiagnostics(
      engine,
      'lazy-checkout',
      revision,
    );
    expect(diagnosticsAfter.references.inFlightStarts).toBe(0);
    expect(getInternals(engine).inFlightStartsByRevision.get('lazy-checkout')).toBeUndefined();
  });

  it('a failed engine.start() on a lazy type releases its early inFlightStarts reservation instead of leaking it', async () => {
    // `resolveAndReserveExecutableRegistration()`'s `onRevisionChosen` hook
    // reserves BEFORE the loader is awaited; if the loader then throws, the
    // reservation must be released rather than left permanently inflated
    // (which would report the revision non-removable forever).
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const revision = await lazyRevision();
    engine.registerSource(
      workflowSource(
        { name: 'lazy-checkout', location: './lazy.ts', exportName: 'lazy', revision },
        async () => {
          throw new Error('loader exploded');
        },
      ),
    );

    await expect(engine.start('lazy-checkout', null)).rejects.toThrow();

    const diagnosticsAfter = await getWorkflowRevisionDiagnostics(
      engine,
      'lazy-checkout',
      revision,
    );
    expect(diagnosticsAfter.references.inFlightStarts).toBe(0);
    expect(getInternals(engine).inFlightStartsByRevision.get('lazy-checkout')).toBeUndefined();
  });
});
