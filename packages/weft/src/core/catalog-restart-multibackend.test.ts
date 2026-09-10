import { afterEach, describe, expect, it } from 'bun:test';

import {
  storageBackends,
  teardown,
  waitForWorkflowStatus,
} from '../testing/storage-backends.test-support.ts';
import { Engine } from './engine.ts';
import {
  getWorkflowCatalog,
  getWorkflowRevisionDiagnostics,
  removeWorkflowRevision,
} from './engine/index.ts';
import { buildRegistrySnapshot } from './registry-snapshot.ts';
import { workflow, type WorkflowContext } from './types.ts';

function makeWorkflow(name: string, version: string) {
  return workflow({ name, version }).execute(async function* (ctx: WorkflowContext) {
    const value = yield* ctx.waitForSignal<string>('go');
    return `done:${value}`;
  });
}

// ---------------------------------------------------------------------------
// Multi-backend test coverage for the durable workflow catalog (WFT-9/WFT-10):
// restart resolves the same active revision/generation from durable state,
// a genuine content change bumps generation, new starts resolve the active
// revision via the registry snapshot, and activating a new revision never
// alters an already-started run's state.
//
// `Engine.create({ workflows: {...} })` returns a registry-typed
// `Engine<TWorkflows, TActivities>`, which is not structurally assignable to
// the bare (default-generic) `Engine` type these test helpers are typed
// against — the same generic-registry variance `src/server/**` already
// works around with `engine as Engine`. Cast at each `Engine.create(...)`
// call site here for the same reason.
// ---------------------------------------------------------------------------

for (const backend of storageBackends) {
  describe(`Workflow catalog restart [${backend.name}]`, () => {
    let engine: Engine | undefined;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    it('restart against the same content resolves the same active revision and generation', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;

      const engineA = (await Engine.create({
        storage: result.storage,
        workflows: { alpha: makeWorkflow('alpha', '1.0.0') },
      })) as unknown as Engine;
      const snapshotA = await buildRegistrySnapshot(engineA);
      const pointerA = getWorkflowCatalog(engineA).resolveActive('alpha');
      expect(snapshotA.activeRevisions['alpha']).toBe(pointerA?.revision);
      expect(pointerA?.generation).toBe(1);
      engineA[Symbol.dispose]();

      const engineB = (await Engine.create({
        storage: result.storage,
        workflows: { alpha: makeWorkflow('alpha', '1.0.0') },
      })) as unknown as Engine;
      engine = engineB;
      const snapshotB = await buildRegistrySnapshot(engineB);
      const pointerB = getWorkflowCatalog(engineB).resolveActive('alpha');

      expect(snapshotB.activeRevisions['alpha']).toBe(snapshotA.activeRevisions['alpha']);
      expect(pointerB?.generation).toBe(pointerA?.generation);
    });

    it('a genuine content change on restart bumps the generation by exactly 1', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;

      const engineA = (await Engine.create({
        storage: result.storage,
        workflows: { alpha: makeWorkflow('alpha', '1.0.0') },
      })) as unknown as Engine;
      const pointerA = getWorkflowCatalog(engineA).resolveActive('alpha');
      engineA[Symbol.dispose]();

      const engineB = (await Engine.create({
        storage: result.storage,
        workflows: { alpha: makeWorkflow('alpha', '2.0.0') },
      })) as unknown as Engine;
      engine = engineB;
      const pointerB = getWorkflowCatalog(engineB).resolveActive('alpha');

      expect(pointerB?.revision).not.toBe(pointerA?.revision);
      expect(pointerB?.generation).toBe((pointerA?.generation ?? 0) + 1);
    });

    it('new starts resolve the active revision through the registry snapshot', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;

      engine = (await Engine.create({
        storage: result.storage,
        workflows: { alpha: makeWorkflow('alpha', '1.0.0') },
      })) as unknown as Engine;
      const snapshot = await buildRegistrySnapshot(engine);
      const manifest = snapshot.workflows.find((entry) => entry.name === 'alpha');

      expect(manifest).toBeDefined();
      expect(snapshot.activeRevisions['alpha']).toBe(manifest?.revision);
    });

    it('activating a new revision does not alter an already-started run', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;

      // Engine A: starts a run and keeps it in-flight (parked on a signal
      // wait), simulating the process that owns an already-running workflow.
      const engineA = (await Engine.create({
        storage: result.storage,
        workflows: { alpha: makeWorkflow('alpha', '1.0.0') },
      })) as unknown as Engine;
      const handle = await engineA.start('alpha', null);
      const runningId = handle.id;
      await waitForWorkflowStatus(engineA, runningId, 'running');
      const beforeState = await engineA.get(runningId);
      expect(beforeState?.status).toBe('running');
      expect(beforeState?.versionTuple.workflowVersion).toBe('1.0.0');
      const pointerBefore = getWorkflowCatalog(engineA).resolveActive('alpha');

      // Engine B: a second engine instance against the SAME durable
      // storage — simulating a rolling-deploy sibling process — registers
      // and activates a genuinely different revision for the same name.
      const engineB = (await Engine.create({
        storage: result.storage,
        workflows: { alpha: makeWorkflow('alpha', '2.0.0') },
        // Only exercising catalog install/activate here — recovering
        // engine A's in-flight run from a second, unfenced engine instance
        // would race it (ownership defaults to 'none' in this test).
        recover: false,
      })) as unknown as Engine;
      engine = engineB;
      const snapshot = await buildRegistrySnapshot(engineB);
      const pointerAfter = getWorkflowCatalog(engineB).resolveActive('alpha');

      expect(pointerAfter?.revision).not.toBe(pointerBefore?.revision);
      expect(snapshot.activeRevisions['alpha']).toBe(pointerAfter?.revision);

      // Engine A's already-started run is untouched by the later
      // activation on engine B: same id, still running, and its own
      // recorded workflowVersion is unchanged.
      const afterState = await engineA.get(runningId);
      expect(afterState?.status).toBe('running');
      expect(afterState?.id).toBe(runningId);
      expect(afterState?.versionTuple.workflowVersion).toBe('1.0.0');

      await engineA.signal(runningId, 'go', 'ok');
      engineA[Symbol.dispose]();
    });

    it('a removed revision does not rehydrate on restart, while the active revision/generation still resolve identically (WFT-12)', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;

      // Deploy v1, then v2 as a second engine over the same durable store
      // (the rolling-deploy shape the sibling tests above already use).
      // register()'s own drain path is the ONLY reference this batch wires
      // durably in-process, so v1 is unreferenced from engine B's
      // perspective the moment engine A is gone.
      const engineA = (await Engine.create({
        storage: result.storage,
        workflows: { alpha: makeWorkflow('alpha', '1.0.0') },
      })) as unknown as Engine;
      const v1 = getWorkflowCatalog(engineA).resolveActive('alpha')?.revision;
      expect(v1).toBeDefined();
      engineA[Symbol.dispose]();

      const engineB = (await Engine.create({
        storage: result.storage,
        workflows: { alpha: makeWorkflow('alpha', '2.0.0') },
      })) as unknown as Engine;
      const removal = await removeWorkflowRevision(engineB, 'alpha', v1!);
      expect(removal).toEqual({ removed: true });
      const pointerB = getWorkflowCatalog(engineB).resolveActive('alpha');
      expect(pointerB?.revision).not.toBe(v1);
      engineB[Symbol.dispose]();

      // Restart resolves the same active revision/generation the earlier
      // "restart resolves the same active revision and generation" test
      // proves in general — the invariant must survive a removal
      // happening earlier in the same durable store's lifetime.
      const engineC = (await Engine.create({
        storage: result.storage,
        workflows: { alpha: makeWorkflow('alpha', '2.0.0') },
      })) as unknown as Engine;
      engine = engineC;
      const catalogC = getWorkflowCatalog(engineC);

      expect(catalogC.getEntry('alpha', v1!)).toBeUndefined();
      const pointerC = catalogC.resolveActive('alpha');
      expect(pointerC?.revision).toBe(pointerB?.revision);
      expect(pointerC?.generation).toBe(pointerB?.generation);
    });
  });
}

/**
 * WFT-21: `retainedRecoveryRecords` wires a terminal-but-unpurged run as a
 * real, durable reference — end to end: register v1 -> start a run pinned
 * to v1 -> activate v2 -> the run completes terminal -> diagnostics report
 * removable:false with retainedRecoveryRecords:1 -> purge deletes the
 * terminal WorkflowState -> removable:true -> removeWorkflowRevision
 * succeeds.
 *
 * Excludes `IndexedDBStorage` — independently discovered, pre-existing bug
 * unrelated to WFT-21: `engine.purge()` throws
 * `TransactionInactiveError: A request was placed against a transaction
 * which is currently not active, or which is finished.` on
 * `IndexedDBStorage`. Root cause: `IndexedDBStorage.scan()`
 * (`storage/indexeddb.ts`'s `iterateCursor()`) yields lazily from a LIVE
 * IndexedDB cursor/transaction, one item per `yield`, calling
 * `cursor.continue()` only after the consumer resumes the generator. Per
 * the IndexedDB spec, a transaction auto-commits once the microtask queue
 * drains with no pending request against it — so ANY `await` a `for await
 * (... of storage.scan(...))` consumer performs inside its loop body (e.g.
 * `bulk-operations-purge.ts`'s several `for await` loops over
 * `storage.scan()`/`storageKeys()`) risks the transaction going stale
 * mid-iteration. This is systemic to every `IndexedDBStorage.scan()`
 * consumer with async loop-body work, not a one-function bug isolated to
 * purge, and is out of WFT-21's scope to fix (a storage-layer redesign of
 * `iterateCursor()`, e.g. buffering cursor results before yielding, or
 * consumers restructuring to collect keys before their own awaits). Filed
 * as a follow-up rather than fixed here — see the batch's structured
 * output `deviations` for the exact repro this test's own body doubles as.
 */
const purgeCapableBackends = storageBackends.filter(
  (backend) => backend.name !== 'IndexedDBStorage',
);

describe('WFT-21: retainedRecoveryRecords release via purge', () => {
  for (const backend of purgeCapableBackends) {
    it(`releases the retainedRecoveryRecords reference so a terminal-unpurged revision becomes removable [${backend.name}]`, async () => {
      const result = backend.factory();
      let engine: Engine | undefined;
      try {
        const engineA = (await Engine.create({
          storage: result.storage,
          workflows: { alpha: makeWorkflow('alpha', '1.0.0') },
        })) as unknown as Engine;
        const v1 = getWorkflowCatalog(engineA).resolveActive('alpha')?.revision;
        expect(v1).toBeDefined();

        const handle = await engineA.start('alpha', null, {
          id: `multibackend-retained-${backend.name}`,
        });
        await waitForWorkflowStatus(engineA, handle.id, 'running');
        const beforeState = await engineA.get(handle.id);
        expect(beforeState?.revision).toBe(v1);

        // A genuinely different revision, activated AFTER the run above
        // started — v1 stays installed but not active. Kept alive (not
        // disposed) as the engine that runs every diagnostics/removal
        // check below: engineA's own `registeredCatalogRevisions` names v1
        // forever (eager, this-process-only), so calling
        // `removeWorkflowRevision` from engineA itself would report
        // "referenced" via `registeredDefinitions` regardless of purge —
        // engineB's own registration names v2, so it has no such
        // self-reference against v1.
        engine = (await Engine.create({
          storage: result.storage,
          workflows: { alpha: makeWorkflow('alpha', '2.0.0') },
          recover: false,
        })) as unknown as Engine;
        const v2 = getWorkflowCatalog(engine).resolveActive('alpha')?.revision;
        expect(v2).not.toBe(v1);

        // Complete the run — its `WorkflowState` remains present
        // (unpurged), still pinned to v1.
        await engineA.signal(handle.id, 'go', 'done');
        await expect(handle.result()).resolves.toBe('done:done');
        engineA[Symbol.dispose]();
        const terminalState = await engine.get(handle.id);
        expect(terminalState?.status).toBe('completed');
        expect(terminalState?.revision).toBe(v1);

        const diagnosticsBeforePurge = await getWorkflowRevisionDiagnostics(engine, 'alpha', v1!);
        expect(diagnosticsBeforePurge.removable).toBe(false);
        expect(diagnosticsBeforePurge.references.retainedRecoveryRecords).toBe(1);
        expect(diagnosticsBeforePurge.references.registeredDefinitions).toBe(0);

        const refused = await removeWorkflowRevision(engine, 'alpha', v1!);
        expect(refused.removed).toBe(false);
        if (!refused.removed && refused.reason === 'referenced') {
          expect(refused.references.retainedRecoveryRecords).toBe(1);
        } else {
          throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(refused)}`);
        }

        // Purge the terminal run — its existing fenced delete of the
        // `wf:` state IS the release for this component; no new write
        // path exists.
        const purgeResult = await engine.purge({ idPrefix: handle.id });
        expect(purgeResult.deleted).toBeGreaterThan(0);

        const diagnosticsAfterPurge = await getWorkflowRevisionDiagnostics(engine, 'alpha', v1!);
        expect(diagnosticsAfterPurge.references.retainedRecoveryRecords).toBe(0);
        expect(diagnosticsAfterPurge.removable).toBe(true);

        const removed = await removeWorkflowRevision(engine, 'alpha', v1!);
        expect(removed).toEqual({ removed: true });
      } finally {
        engine?.[Symbol.dispose]();
        await result.cleanup();
      }
    });
  }
});
