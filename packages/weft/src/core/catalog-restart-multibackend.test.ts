import { afterEach, describe, expect, it } from 'bun:test';

import {
  storageBackends,
  teardown,
  waitForWorkflowStatus,
} from '../testing/storage-backends.test-support.ts';
import { Engine } from './engine.ts';
import { getWorkflowCatalog } from './engine/index.ts';
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
  });
}
