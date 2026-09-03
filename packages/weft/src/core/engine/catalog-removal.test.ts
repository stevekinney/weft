import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { WorkflowRevisionRemovedEvent } from '../events/catalog-events.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { activateCatalogRevisionCandidate } from './catalog-activation.ts';
import {
  countWorkflowRevisionReferences,
  getWorkflowRevisionDiagnostics,
  removeWorkflowRevision,
} from './catalog-removal.ts';
import { Engine } from './index.ts';
import { getInternals, getWorkflowCatalog } from './internals.ts';

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
    await engine.start('checkout', null);
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

  it('succeeds removing a non-active revision once no reference remains (in a second process/engine that never registered it)', async () => {
    await using storage = new MemoryStorage();
    await using engineA = new Engine({ storage, backgroundTasks: 'manual' });
    engineA.register(noopWorkflow('checkout'));
    await engineA.start('checkout', null);
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
  it('reports zeros for the five structurally-present WFT-17-dependent fields', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const references = await countWorkflowRevisionReferences(engine, 'checkout', revision);

    expect(references.nonTerminalRuns).toBe(0);
    expect(references.pinnedSchedules).toBe(0);
    expect(references.pendingDispatches).toBe(0);
    expect(references.activeExecutionRealms).toBe(0);
    expect(references.retainedRecoveryRecords).toBe(0);
  });
});
