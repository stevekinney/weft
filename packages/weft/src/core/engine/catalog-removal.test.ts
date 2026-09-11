import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { removeCatalogEntry } from '../catalog/index.ts';
import { encode } from '../codec.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { WorkflowRevisionRemovedEvent } from '../events/catalog-events.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import {
  workflow,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowState,
} from '../types.ts';
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
import { WorkflowRevisionUnavailableError } from './revision-errors.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

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
    // Purge the now-completed run too: WFT-21's `retainedRecoveryRecords`
    // would otherwise durably reference revA via this exact same completed,
    // unpurged run, for the same reason `nonTerminalRuns` was excluded
    // above.
    await engine.purge({ idPrefix: startedHandle.id });
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
    // WFT-17/18: a clean `removed: true` leaves no tombstone behind — the
    // finalize half of `finalizeRevisionRemoval` durably deletes it.
    expect(await storage.get(KEYS.catalogTombstone('checkout', revA))).toBeNull();
  });

  describe('finalizeRevisionRemoval vs. a concurrent tombstone resolver — WFT-21, Codex review round 14, P2 item S-QH', () => {
    async function installRemovableRevision(engine: Engine): Promise<string> {
      engine.register(noopWorkflow('checkout'));
      const startedHandle = await engine.start('checkout', null);
      await startedHandle.result();
      await engine.purge({ idPrefix: startedHandle.id });
      const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;
      getInternals(engine).registeredCatalogRevisions.delete('checkout');
      const manifestB = await manifestFor('checkout', '1.0.0', { description: 'a later revision' });
      await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
        expectedGeneration: 1,
        policy: { requireExactRevision: false },
      });
      return revA;
    }

    it('reports "referenced" (not a lying "removed: true") and dispatches no event when a concurrent resolver RESTORED the entry before this call\'s own finalize CAS landed', async () => {
      await using storage = new MemoryStorage();
      await using engine = new Engine({ storage, backgroundTasks: 'manual' });
      const revA = await installRemovableRevision(engine);
      const tombstoneKey = KEYS.catalogTombstone('checkout', revA);

      const originalConditionalBatch = storage.conditionalBatch.bind(storage);
      let intercepted = false;
      storage.conditionalBatch = async (conditions, operations) => {
        const isFinalizeTombstoneDelete =
          !intercepted &&
          operations.length === 1 &&
          operations[0]?.type === 'delete' &&
          operations[0]?.key === tombstoneKey;
        if (isFinalizeTombstoneDelete) {
          intercepted = true;
          // Simulate a concurrent boot-time sweep RESTORING this exact
          // tombstone (its own reference-count scan found something) a
          // moment before this call's own `finalizeCatalogTombstone` CAS
          // lands — the tombstone bytes are the exact deleted entry bytes,
          // recoverable from the precondition this call itself supplied.
          const tombstoneBytesCondition = conditions.find((c) => c.key === tombstoneKey);
          const tombstoneBytes = tombstoneBytesCondition?.expectedValue;
          if (tombstoneBytes !== null && tombstoneBytes !== undefined) {
            await originalConditionalBatch(
              [{ key: tombstoneKey, expectedValue: tombstoneBytes }],
              [
                { type: 'put', key: KEYS.catalogEntry('checkout', revA), value: tombstoneBytes },
                { type: 'delete', key: tombstoneKey },
              ],
            );
          }
        }
        return originalConditionalBatch(conditions, operations);
      };

      const events: WorkflowRevisionRemovedEvent[] = [];
      engine.addEventListener(WorkflowRevisionRemovedEvent.type, (e) => events.push(e));

      const result = await removeWorkflowRevision(engine, 'checkout', revA);

      // The concurrent resolver restored the entry — the removal did NOT
      // complete. Before this fix, `finalizeRevisionRemoval` ignored its
      // own lost CAS and reported `{ removed: true }` + dispatched the
      // event regardless.
      expect(result.removed).toBe(false);
      if (!result.removed && result.reason === 'referenced') {
        // The reason code is truthful; the exact counts are this call's own
        // (possibly stale) snapshot, not re-derived from the concurrent
        // resolver's decision — documented in `finalizeRevisionRemoval`'s doc.
        expect(result.references).toBeDefined();
      } else {
        throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(result)}`);
      }
      expect(events).toHaveLength(0);
      expect(getWorkflowCatalog(engine).getEntry('checkout', revA)).toBeUndefined();
      expect(await storage.get(KEYS.catalogEntry('checkout', revA))).not.toBeNull();
    });

    it('still reports a truthful "removed: true" and dispatches the event when a concurrent resolver FINALIZED the exact same tombstone first', async () => {
      await using storage = new MemoryStorage();
      await using engine = new Engine({ storage, backgroundTasks: 'manual' });
      const revA = await installRemovableRevision(engine);
      const tombstoneKey = KEYS.catalogTombstone('checkout', revA);

      const originalConditionalBatch = storage.conditionalBatch.bind(storage);
      let intercepted = false;
      storage.conditionalBatch = async (conditions, operations) => {
        const isFinalizeTombstoneDelete =
          !intercepted &&
          operations.length === 1 &&
          operations[0]?.type === 'delete' &&
          operations[0]?.key === tombstoneKey;
        if (isFinalizeTombstoneDelete) {
          intercepted = true;
          // Simulate a concurrent boot-time sweep FINALIZING this exact
          // tombstone (zero references, same as this call's own decision)
          // a moment before this call's own CAS lands — applying the IDENTICAL
          // conditions/operations this call is about to attempt.
          await originalConditionalBatch(conditions, operations);
        }
        return originalConditionalBatch(conditions, operations);
      };

      const events: WorkflowRevisionRemovedEvent[] = [];
      engine.addEventListener(WorkflowRevisionRemovedEvent.type, (e) => events.push(e));

      const result = await removeWorkflowRevision(engine, 'checkout', revA);

      // The concurrent resolver finalized it — the removal DID complete,
      // just not through this call's own commit. `{ removed: true }` is
      // truthful, and this call dispatches the event on the concurrent
      // resolver's behalf (the boot-time sweep never dispatches engine
      // events itself).
      expect(result).toEqual({ removed: true });
      expect(events).toHaveLength(1);
      expect(events[0]?.revision).toBe(revA);
      expect(await storage.get(KEYS.catalogEntry('checkout', revA))).toBeNull();
      expect(await storage.get(tombstoneKey)).toBeNull();
    });

    it('reports "referenced" (not a lost restore treated as success) when a genuine reference appears between the pre- and post-checks AND the restore itself loses its CAS to a concurrent resolver', async () => {
      await using storage = new MemoryStorage();
      await using engine = new Engine({ storage, backgroundTasks: 'manual' });
      const revA = await installRemovableRevision(engine);
      const tombstoneKey = KEYS.catalogTombstone('checkout', revA);
      const entryKey = KEYS.catalogEntry('checkout', revA);

      const originalConditionalBatch = storage.conditionalBatch.bind(storage);
      let deleteIntercepted = false;
      let restoreIntercepted = false;
      storage.conditionalBatch = async (conditions, operations) => {
        const isDeleteAndTombstoneWrite =
          !deleteIntercepted &&
          operations.some((op) => op.type === 'delete' && op.key === entryKey) &&
          operations.some((op) => op.type === 'put' && op.key === tombstoneKey);
        if (isDeleteAndTombstoneWrite) {
          deleteIntercepted = true;
          const result = await originalConditionalBatch(conditions, operations);
          if (result) {
            // A genuine reference appears in the gap between
            // `catalog.remove()`'s own commit and `finalizeRevisionRemoval()`'s
            // post-check — the exact TOCTOU window that check exists to close.
            getInternals(engine).registeredCatalogRevisions.set('checkout', revA);
          }
          return result;
        }

        const isRestoreWrite =
          !restoreIntercepted &&
          operations.some((op) => op.type === 'put' && op.key === entryKey) &&
          operations.some((op) => op.type === 'delete' && op.key === tombstoneKey);
        if (isRestoreWrite) {
          restoreIntercepted = true;
          // Simulate a concurrent resolver (e.g. the boot-time sweep)
          // restoring this exact tombstone a moment before this call's own
          // restore CAS lands — applying the IDENTICAL conditions/operations
          // this call is about to attempt.
          await originalConditionalBatch(conditions, operations);
        }
        return originalConditionalBatch(conditions, operations);
      };

      const events: WorkflowRevisionRemovedEvent[] = [];
      engine.addEventListener(WorkflowRevisionRemovedEvent.type, (e) => events.push(e));

      const result = await removeWorkflowRevision(engine, 'checkout', revA);

      expect(result.removed).toBe(false);
      if (!result.removed && result.reason === 'referenced') {
        expect(result.references.registeredDefinitions).toBe(1);
      } else {
        throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(result)}`);
      }
      expect(events).toHaveLength(0);
      // The concurrent resolver's own restore landed durably.
      expect(await storage.get(entryKey)).not.toBeNull();
      expect(await storage.get(tombstoneKey)).toBeNull();

      getInternals(engine).registeredCatalogRevisions.delete('checkout');
    });
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
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let batchCalls = 0;
    let paused = false;
    // Pause the first commit made while a `checkout` start is reserved, whichever
    // commit method carries it. The child start supplies an explicit `id`, so its
    // create batch commits through `conditionalBatch` (WFT-152 conditions it on the
    // duplicate-id read) rather than the plain `batch` a generated-id start uses —
    // wrapping only `batch` would never see the child's CREATE write at all.
    const pauseWhileReserved = async (): Promise<void> => {
      batchCalls += 1;
      const internals = getInternals(engine);
      const alreadyReserved =
        (internals.inFlightStartsByRevision.get('checkout')?.get(revision) ?? 0) > 0;
      if (!paused && alreadyReserved) {
        paused = true;
        entered.resolve();
        await gate.promise;
      }
    };
    storage.batch = async (operations) => {
      await pauseWhileReserved();
      return originalBatch(operations);
    };
    storage.conditionalBatch = async (conditions, operations) => {
      await pauseWhileReserved();
      return originalConditionalBatch(conditions, operations);
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
    const primingHandle = await engineA.start('checkout', null).then(async (h) => {
      await h.result();
      return h;
    });
    const revA = getWorkflowCatalog(engineA).resolveActive('checkout')!.revision;
    // Also purge the now-completed run: WFT-21's `retainedRecoveryRecords`
    // would otherwise durably reference revA via this same completed run,
    // exactly like `nonTerminalRuns` would have for a non-terminal one —
    // this test's "no reference remains" premise needs both released.
    await engineA.purge({ idPrefix: primingHandle.id });

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
    // Activate 'checkout' via the register-drain path WITHOUT starting a
    // real run — this test is about the CAS race on removal's own delete,
    // not about reference counting, and a completed run pinned to revA
    // would now (WFT-21) durably reference it via `retainedRecoveryRecords`
    // and refuse removal before ever reaching the CAS this test targets.
    await ensureWorkflowCatalogReady(engine);
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
    // Activate without starting a real run — see the "conflict" test above
    // for why (WFT-21's retainedRecoveryRecords would otherwise refuse
    // removal before this TOCTOU race is ever reached).
    await ensureWorkflowCatalogReady(engine);
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
    // Activate without starting a real run — see the "conflict" test above
    // for why (WFT-21's retainedRecoveryRecords would otherwise refuse
    // removal before this TOCTOU race is ever reached).
    await ensureWorkflowCatalogReady(engine);
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
    // Activate without starting a real run: a completed-but-unpurged run
    // pinned to revA would itself be a durable reference (WFT-21's
    // retainedRecoveryRecords), which is not what this "unreferenced"
    // scenario is testing — see `countWorkflowRevisionReferences`'s own
    // "genuinely non-terminal run"/"terminal run" tests below for that.
    await ensureWorkflowCatalogReady(engineA);
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

  it('reports installed:false (not a stale cached installed:true) once a peer durably removes the revision (WFT-21, Codex review round 14, P2 item UXP-)', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    await ensureWorkflowCatalogReady(engine);
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;
    const manifestB = await manifestFor('checkout', '1.0.0', { description: 'later' });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });

    // Populate this process's own in-memory `#entries` cache for revA
    // BEFORE the durable delete below.
    const before = await getWorkflowRevisionDiagnostics(engine, 'checkout', revA);
    expect(before.installed).toBe(true);

    // Simulate a peer's `remove()` durably deleting the entry WITHOUT
    // touching this process's own cache.
    await storage.delete(KEYS.catalogEntry('checkout', revA));

    const after = await getWorkflowRevisionDiagnostics(engine, 'checkout', revA);
    expect(after.installed).toBe(false);
    expect(after.removable).toBe(false);
  });
});

describe('countWorkflowRevisionReferences', () => {
  it('reports 0 for nonTerminalRuns/pinnedSchedules once the run is terminal, but 1 for retainedRecoveryRecords until purge (WFT-21)', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    const handle = await engine.start('checkout', null);
    await handle.result();
    const revision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const references = await countWorkflowRevisionReferences(engine, 'checkout', revision);

    // `nonTerminalRuns` is 0: the run completed above. `pendingDispatches`
    // and `activeExecutionRealms` stay structurally present but always 0 —
    // each awaits revision identity in a different, later-owned subsystem
    // (see `reference-counts.ts`'s field docs). `retainedRecoveryRecords`
    // (WFT-21) is 1, NOT 0: the completed run's own `WorkflowState` is
    // still present (unpurged) and pinned to this exact revision — a
    // completed run is forkable against its original revision, so it is a
    // genuine durable reference until purge or retention releases it.
    expect(references.nonTerminalRuns).toBe(0);
    expect(references.pinnedSchedules).toBe(0);
    expect(references.pendingDispatches).toBe(0);
    expect(references.activeExecutionRealms).toBe(0);
    expect(references.retainedRecoveryRecords).toBe(1);

    // Purging the terminal run through the ordinary purge path (its
    // existing fenced delete of the `wf:` state IS the release for this
    // component — no new write path was needed) drops it back to 0.
    await engine.purge({ idPrefix: handle.id });
    const referencesAfterPurge = await countWorkflowRevisionReferences(
      engine,
      'checkout',
      revision,
    );
    expect(referencesAfterPurge.retainedRecoveryRecords).toBe(0);
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

  // WFT-21: `retainedRecoveryRecords` is now a real signal (was a permanent
  // `0` stub). A terminal-but-unpurged run is retryable/forkable, so it is
  // a genuine durable reference until purge or retention releases it.
  it('removeWorkflowRevision() refuses a revision with a terminal, unpurged run via retainedRecoveryRecords, and succeeds once purged', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    const handle = await engine.start('checkout', null);
    await handle.result();
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const manifestB = await manifestFor('checkout', '1.0.0', {
      description: 'a later revision for the retained-recovery-records test',
    });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    getInternals(engine).registeredCatalogRevisions.delete('checkout');

    const refused = await removeWorkflowRevision(engine, 'checkout', revA);
    expect(refused.removed).toBe(false);
    if (!refused.removed && refused.reason === 'referenced') {
      expect(refused.references.retainedRecoveryRecords).toBe(1);
    } else {
      throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(refused)}`);
    }

    await engine.purge({ idPrefix: handle.id });
    const succeeded = await removeWorkflowRevision(engine, 'checkout', revA);
    expect(succeeded).toEqual({ removed: true });
  });

  // WFT-21: a dead-lettered finalizer is a PERMANENT reference — unlike a
  // terminal WorkflowState, purge never touches it. This proves the
  // intended no-auto-release design explicitly: even after the workflow
  // record itself is purged, a dead letter alone keeps the revision
  // permanently non-removable (no acknowledge/clear API exists yet).
  it('a dead-letter-only reference makes removal permanently refused, even after the workflow record is purged', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));
    const handle = await engine.start('checkout', null);
    await handle.result();
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    // Seed under `teardownDeadLetterHistory` — the namespace
    // `countTeardownDeadLettersForRevision()` actually scans (WFT-21, Codex
    // review round 3, P2), not the single-slot `teardownDeadLetter`.
    await storage.put(
      KEYS.teardownDeadLetterHistory(handle.id, 'dead-letter-token'),
      encode({
        type: 'checkout',
        lastError: 'resource leaked',
        attempts: 8,
        deadLetteredAt: 1,
        revision: revA,
      }),
    );

    const manifestB = await manifestFor('checkout', '1.0.0', {
      description: 'a later revision for the dead-letter-permanence test',
    });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    getInternals(engine).registeredCatalogRevisions.delete('checkout');

    // Purge the workflow record itself — the terminal-run component of
    // `retainedRecoveryRecords` is released, but the dead letter is not.
    await engine.purge({ idPrefix: handle.id });

    const result = await removeWorkflowRevision(engine, 'checkout', revA);
    expect(result.removed).toBe(false);
    if (!result.removed && result.reason === 'referenced') {
      expect(result.references.retainedRecoveryRecords).toBe(1);
      expect(result.references.nonTerminalRuns).toBe(0);
    } else {
      throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(result)}`);
    }
  });

  // WFT-20: `pinnedSchedules` is now a real signal (was a permanent `0` stub).
  it('counts a pinned schedule referencing the exact revision, and removeWorkflowRevision() refuses with reason "referenced"', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.register(noopWorkflow('checkout'));

    const handle = await engine.schedule('checkout', null, '* * * * *', {
      revisionPolicy: 'pinned',
    });
    const pinnedDescription = await handle.describe();
    const revision = pinnedDescription.pinnedRevision!;
    expect(typeof revision).toBe('string');

    const references = await countWorkflowRevisionReferences(engine, 'checkout', revision);
    expect(references.pinnedSchedules).toBe(1);

    // Move the active pointer away and clear the process's own
    // `registeredDefinitions` reference so `pinnedSchedules` is the sole
    // thing standing between this call and a (wrongly) successful removal.
    const manifestB = await manifestFor('checkout', '1.0.0', {
      description: 'a later revision for the pinned-schedule test',
    });
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    getInternals(engine).registeredCatalogRevisions.delete('checkout');

    const result = await removeWorkflowRevision(engine, 'checkout', revision);
    expect(result.removed).toBe(false);
    if (!result.removed && result.reason === 'referenced') {
      expect(result.references.pinnedSchedules).toBe(1);
    } else {
      throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(result)}`);
    }
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

/**
 * WFT-17: the catalog-removal/start-admission race (Codex review, PR #958,
 * spec open question #3). Under `ownership: 'workflow-lease'`, TWO REAL
 * engine processes share ONE `MemoryStorage` — engine A holds the eager
 * registration and starts runs; engine B never registers the type at all
 * (an "admin"/cleanup process) and calls `removeWorkflowRevision()` — the
 * scenario `catalog-removal.test.ts`'s single-engine tests above cannot
 * exercise, since a SAME-process removal is already refused outright by
 * `registeredDefinitions` before the race window ever opens.
 *
 * `MemoryStorage#conditionalBatch` has no internal `await` (see
 * `workflow-claim-two-engine.test.ts`'s own module doc), so these tests
 * gate at the OUTER call boundary — replacing `storage.conditionalBatch`
 * with a wrapper that awaits a `Promise.withResolvers()` latch before
 * delegating to the real implementation — the same technique this file's
 * `storage.batch` interleaving tests above already use.
 */
describe('removeWorkflowRevision vs. a concurrent start() — cross-process race (WFT-17)', () => {
  async function revisionFor(definition: WorkflowDefinition): Promise<string> {
    const entry = buildRegistrationEntry(definition.name, definition);
    const registered = copyWorkflowDefinition(definition.name, entry);
    const manifest = await buildWorkflowManifestFromDefinition(
      registered,
      new ActivityRegistry().listDefinitions(),
    );
    return manifest.revision;
  }

  /** Real, working `ownership: 'workflow-lease'` engine — mirrors `workflow-claim-two-engine.test.ts`'s `createClaimEngine`. */
  async function createClaimEngine(
    storage: MemoryStorage,
    engineId: string,
    workflows: Record<string, WorkflowDefinition>,
  ): Promise<Engine> {
    // Cast once, here, to the bare `Engine` type `removeWorkflowRevision()`/
    // `activateCatalogRevisionCandidate()` accept — `Engine.create()`'s
    // return type is parameterized by the exact `workflows` object passed
    // in, so engine A (registered) and engine B (an empty registry) infer
    // structurally different phantom workflow registries even though both
    // are ordinary, fully-functional engines at runtime.
    const engine = (await Engine.create({
      storage,
      workflows,
      ownership: 'workflow-lease',
      workflowClaimTtl: '1m',
      workflowClaimRenewInterval: '5s',
      recover: false,
    })) as unknown as Engine;
    getInternals(engine).workflowClaimRegistry = new WorkflowClaimRegistry({
      storage,
      engineId,
      getNow: () => Date.now(),
      claimTtlMs: 60_000,
      claimRenewIntervalMs: 5_000,
    });
    return engine;
  }

  it("restores the entry and reports 'referenced' when a run committed by a concurrent start lands between removal's delete and its own post-check", async () => {
    const storage = new MemoryStorage();
    const raceRestoreWorkflow = workflow({ name: 'race-restore', version: '1.0.0' }).execute(
      async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal<string>('go');
      },
    );
    const revisionR1 = await revisionFor(raceRestoreWorkflow);

    await using engineA = await createClaimEngine(storage, 'engine-a', {
      'race-restore': raceRestoreWorkflow,
    });
    // Prime the catalog (install R1 + activate it) with an UNCONTENDED start.
    await engineA.start('race-restore', null, { id: 'race-restore-priming' }).then(async (h) => {
      await h.signal('go', 'done');
      await h.result();
    });
    // Purge the now-completed priming run: WFT-21's `retainedRecoveryRecords`
    // would otherwise durably reference R1 via this run and make removal's
    // own PRE-check refuse before ever reaching the delete-CAS this test
    // parks on — this test is about the post-delete restore race, not
    // reference counting.
    await engineA.purge({ idPrefix: 'race-restore-priming' });

    // Move the ACTIVE pointer to a DIFFERENT revision R2 — R1 stays
    // INSTALLED but not active, the state `removeWorkflowRevision()`
    // actually needs to reach its reference-count checks at all (an active
    // revision is refused before ever reaching them).
    const manifestR2 = await manifestFor('race-restore', '1.0.0', {
      description: 'a later revision A never loaded',
    });
    await activateCatalogRevisionCandidate(engineA, 'race-restore', manifestR2, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });
    expect(getWorkflowCatalog(engineA).resolveActive('race-restore')?.revision).toBe(
      manifestR2.revision,
    );

    // Engine B: a SEPARATE process that never `register()`s 'race-restore'
    // — its own `registeredCatalogRevisions` has no entry for it, so
    // `countWorkflowRevisionReferences`'s `registeredDefinitions` count is
    // 0 from B's side, unlike a same-process removal attempt.
    await using engineB = await createClaimEngine(storage, 'engine-b', {});

    // Both engines share this ONE `storage` instance, so the wrapper below
    // must pause ONLY removal's own delete-CAS — never A's later start
    // commit, which also goes through `conditionalBatch` (its claim fold),
    // or A's start would deadlock awaiting the same gate B is parked on.
    // `removeCatalogEntry()`'s delete-CAS is the only call in this test
    // whose operations include a `'delete'` on this exact catalog-entry key.
    const entryKey = KEYS.catalogEntry('race-restore', revisionR1);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      const isRemovalDelete = operations.some((op) => op.type === 'delete' && op.key === entryKey);
      if (isRemovalDelete) {
        entered.resolve();
        await gate.promise;
      }
      return originalConditionalBatch(conditions, operations);
    };

    const removalPromise = removeWorkflowRevision(engineB, 'race-restore', revisionR1);
    await entered.promise;
    // Removal is now parked exactly at its delete-CAS: the pre-check above
    // already ran (finding zero references — A's priming run was already
    // purged above, so it no longer durably references R1 in any of the
    // pre-check's reference-count fields).

    // A fresh, non-terminal start on ENGINE A — the SAME process that still
    // has R1's code loaded — pins to R1 (its own `registeredCatalogRevisions`
    // entry), NOT the now-active R2 (the exact "pinned runs continue on
    // their original revision after activation changes" acceptance
    // criterion). Its own start-commit catalog-entry precondition reads R1
    // still installed (B's delete hasn't landed yet — B is parked above)
    // and commits successfully.
    const parkedHandle = await engineA.start('race-restore', null, {
      id: 'race-restore-parked',
    });
    const parkedState = await engineA.get('race-restore-parked');
    expect(parkedState?.revision).toBe(revisionR1);
    // Durably `running` (non-terminal) regardless of whether `engine.get()`
    // presents it as `'pending'` — the queued-not-yet-dispatched inline
    // presentation `hasQueuedInlineWorkflowStart` produces — since it is
    // this DURABLE non-terminal status the removal post-check below reads
    // directly from storage.
    expect(['running', 'pending']).toContain(parkedState?.status ?? 'missing');

    gate.resolve();
    const result = await removalPromise;

    expect(result).toEqual({
      removed: false,
      reason: 'referenced',
      references: expect.objectContaining({ nonTerminalRuns: 1 }),
    });
    // The entry was restored — still installed, from EITHER engine's view.
    expect(await getWorkflowCatalog(engineB).hasInstalled('race-restore', revisionR1)).toBe(true);
    expect(await getWorkflowCatalog(engineA).hasInstalled('race-restore', revisionR1)).toBe(true);
    // WFT-17/18: the restore goes through the tombstone atomically (see
    // `catalog/removal.ts`) — no tombstone remains once resolved, and the
    // restored entry bytes are byte-identical to what was originally there.
    expect(await storage.get(KEYS.catalogTombstone('race-restore', revisionR1))).toBeNull();

    // A's parked run is unaffected — never touched by the removal/restore
    // dance, still running against its own in-memory code.
    await parkedHandle.signal('go', 'done');
    expect(await parkedHandle.result()).toBe('done');
  });

  it("fails a fresh start closed with WorkflowRevisionUnavailableError('not-installed') when the resolved revision is removed by a concurrent process before the start's own commit lands — no wf: record is created", async () => {
    const storage = new MemoryStorage();
    const raceFailClosedWorkflow = workflow({
      name: 'race-fail-closed',
      version: '1.0.0',
    }).execute(async function* (ctx: WorkflowContext) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const revisionR1 = await revisionFor(raceFailClosedWorkflow);

    await using engineA = await createClaimEngine(storage, 'engine-a-fc', {
      'race-fail-closed': raceFailClosedWorkflow,
    });
    await engineA
      .start('race-fail-closed', null, { id: 'race-fail-closed-priming' })
      .then(async (h) => {
        await h.signal('go', 'done');
        await h.result();
      });
    // Purge the now-completed priming run: WFT-21's `retainedRecoveryRecords`
    // would otherwise durably reference R1 via this run and make the later
    // `removeWorkflowRevision()` call below refuse outright — this test is
    // about the fresh-start-vs-removal commit-ordering race, not reference
    // counting.
    await engineA.purge({ idPrefix: 'race-fail-closed-priming' });

    // `removeWorkflowRevision()` refuses removal of the currently ACTIVE
    // revision outright — move the active pointer to a DIFFERENT revision
    // first, so R1 is installed-but-not-active, the state this test's race
    // actually needs to reach `removeWorkflowRevision()`'s reference checks
    // at all.
    const manifestR2 = await manifestFor('race-fail-closed', '1.0.0', {
      description: 'a later revision A never loaded',
    });
    const activation = await activateCatalogRevisionCandidate(
      engineA,
      'race-fail-closed',
      manifestR2,
      {
        expectedGeneration: 1,
        policy: { requireExactRevision: false },
      },
    );
    expect(activation.applied).toBe(true);
    expect(getWorkflowCatalog(engineA).resolveActive('race-fail-closed')?.revision).toBe(
      manifestR2.revision,
    );

    await using engineB = await createClaimEngine(storage, 'engine-b-fc', {});

    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let paused = false;
    storage.conditionalBatch = async (conditions, operations) => {
      if (!paused) {
        paused = true;
        entered.resolve();
        await gate.promise;
      }
      return originalConditionalBatch(conditions, operations);
    };

    // Park engine A's NEW start exactly at its own commit CAS: its
    // catalog-entry precondition already captured R1's bytes (read before
    // this gated call) before pausing here.
    const startPromise = engineA.start('race-fail-closed', null, {
      id: 'race-fail-closed-new',
    });
    await entered.promise;

    // Restore the real conditionalBatch for engine B's OWN removal so it is
    // not itself gated by the same wrapper (both engines share one
    // `storage` instance).
    storage.conditionalBatch = originalConditionalBatch;
    const removed = await removeWorkflowRevision(engineB, 'race-fail-closed', revisionR1);
    expect(removed).toEqual({ removed: true });
    expect(await getWorkflowCatalog(engineB).hasInstalled('race-fail-closed', revisionR1)).toBe(
      false,
    );

    gate.resolve();
    await expect(startPromise).rejects.toThrow(WorkflowRevisionUnavailableError);

    const state = await engineA.get('race-fail-closed-new');
    expect(state).toBeNull();
  });
});

/**
 * WFT-17/WFT-18: the catalog-removal/checkpoint-retry race (Codex review,
 * PR #958). A checkpoint-backed `retryFailedAll()` reactivation commits a
 * `failed` -> `running` transition. At the time this race was discovered,
 * `countNonTerminalRunsForRevision()`'s reference scan — what
 * `removeWorkflowRevision()`'s pre- and post-checks both relied on — never
 * counted a `failed` run at all, so a revision removal concurrent with a
 * retry could not see this run coming even via the post-check that closes
 * the equivalent fresh-`start()` race above; the fix was the CAS-fencing
 * mechanism this test exercises (park the retry's reactivation exactly at
 * its own commit CAS, remove the revision underneath it, and prove the
 * retry's own precondition read fails closed rather than committing a
 * stranded `running` state).
 *
 * WFT-21 separately wires `retainedRecoveryRecords` to count a `failed`
 * run's own `WorkflowState` as a durable reference too (a failed run is
 * retryable, so it durably pins its revision exactly like a completed run
 * durably pins its own) — `removeWorkflowRevision()` now correctly REFUSES
 * this exact scenario outright, via its ordinary reference pre-check,
 * before ever reaching the CAS race below. That is the intended behavior
 * change (see `CHANGELOG.md`'s `[Unreleased]` entry), but it means this
 * test can no longer exercise the CAS-fencing invariant through
 * `removeWorkflowRevision()`'s own public entry point. It now calls the
 * lower-level `removeCatalogEntry()` primitive directly instead — the same
 * primitive `removeWorkflowRevision()` itself delegates to once its own
 * reference check passes — mirroring `catalog-tombstone-recovery.test.ts`'s
 * `simulateCrashedRemoval()` precedent for isolating this exact layer.
 *
 * Deliberately run under `ownership: 'none'` (a single, plain
 * `new Engine({ storage })`) — unlike a fresh start, a retry's reactivation
 * carries no `inFlightStartsByRevision` reservation of its own to close the
 * SAME-process half of this race, so the fix must fence retries in every
 * ownership mode, not just under a lease topology with two real engines.
 */
async function waitForWorkflowStatus(
  engine: Engine,
  workflowId: string,
  status: WorkflowState['status'],
): Promise<WorkflowState> {
  let matchingState: WorkflowState | null = null;
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      if (state?.status === status) {
        matchingState = state;
        return true;
      }
      return false;
    },
    { label: `workflow "${workflowId}" to reach ${status}`, intervalMs: 5 },
  );
  if (matchingState === null) {
    throw new Error(`Workflow "${workflowId}" did not reach ${status}`);
  }
  return matchingState;
}

describe('removeWorkflowRevision vs. a concurrent retryFailedAll() — checkpoint-backed reactivation race (WFT-17/18)', () => {
  async function revisionFor(definition: WorkflowDefinition): Promise<string> {
    const entry = buildRegistrationEntry(definition.name, definition);
    const registered = copyWorkflowDefinition(definition.name, entry);
    const manifest = await buildWorkflowManifestFromDefinition(
      registered,
      new ActivityRegistry().listDefinitions(),
    );
    return manifest.revision;
  }

  it("fails a checkpoint-backed retry closed with WorkflowRevisionUnavailableError('not-installed') — leaving the run FAILED, not stranded RUNNING — when its pinned revision is removed by a concurrent process before the retry's own reactivation commit lands, even under ownership: 'none'", async () => {
    const storage = new MemoryStorage();

    const retryRaceWorkflow = workflow({
      name: 'retry-fence-race',
      version: '1.0.0',
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.run(async () => 'checkpoint-marker');
      throw new Error('always fails after the checkpoint');
    });
    const revisionR1 = await revisionFor(retryRaceWorkflow);

    await using engineA = new Engine({ storage });
    engineA.register(retryRaceWorkflow);
    const handle = await engineA.start('retry-fence-race', null, { id: 'retry-fence-race-target' });
    const failedState = await waitForWorkflowStatus(engineA, handle.id, 'failed');
    expect(failedState.revision).toBe(revisionR1);
    expect(await storage.get(KEYS.checkpoint(handle.id))).not.toBeNull();

    // `removeWorkflowRevision()` refuses removal of the currently ACTIVE
    // revision outright — move the active pointer to a DIFFERENT revision
    // first, mirroring the fresh-start race test above, so R1 is
    // installed-but-not-active when the removal actually runs.
    const manifestR2 = await manifestFor('retry-fence-race', '1.0.0', {
      description: 'a later revision never loaded',
    });
    const activation = await activateCatalogRevisionCandidate(
      engineA,
      'retry-fence-race',
      manifestR2,
      { expectedGeneration: 1, policy: { requireExactRevision: false } },
    );
    expect(activation.applied).toBe(true);

    // No second engine is needed here: the concurrent removal below goes
    // through the low-level `removeCatalogEntry()` primitive directly
    // (storage-only, no engine's own reference accounting involved) — see
    // the module doc above for why `removeWorkflowRevision()` itself is no
    // longer reachable for this exact race post-WFT-21.
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let paused = false;
    storage.conditionalBatch = async (conditions, operations) => {
      if (!paused) {
        paused = true;
        entered.resolve();
        await gate.promise;
      }
      return originalConditionalBatch(conditions, operations);
    };

    // Park the retry's reactivation exactly at its own commit CAS: its
    // catalog-entry precondition already captured R1's bytes (read before
    // this gated call) before pausing here.
    const retryPromise = engineA.retryFailedAll({ type: 'retry-fence-race' });
    await entered.promise;

    // Restore the real conditionalBatch before the concurrent removal so it
    // is not itself gated by the same wrapper.
    storage.conditionalBatch = originalConditionalBatch;
    // `removeCatalogEntry()` — the lower-level primitive, not
    // `removeWorkflowRevision()` — deliberately bypasses reference-count
    // enforcement (see the module doc above): the failed run being retried
    // durably references R1 via WFT-21's `retainedRecoveryRecords`, so
    // `removeWorkflowRevision()` itself would now correctly refuse this
    // removal before ever reaching the CAS race this test targets.
    const removed = await removeCatalogEntry(storage, 'retry-fence-race', revisionR1);
    expect(removed.outcome).toBe('removed');

    gate.resolve();
    const result = await retryPromise;
    expect(result.retried).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.id).toBe(handle.id);
    expect(result.errors[0]?.error).toContain('is no longer installed');

    // The critical regression assertion: the run must still be `failed`,
    // never left `running` with a reactivation commit that landed anyway.
    const stateAfterRace = await engineA.get(handle.id);
    expect(stateAfterRace?.status).toBe('failed');
  });
});
