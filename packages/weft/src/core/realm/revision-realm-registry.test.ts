import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { RevisionRealmRegistry } from './revision-realm-registry.ts';
import type { RevisionRealm } from './revision-realm.ts';
import type { WorkerRealm, WorkerRealmActivation } from './worker-realm.ts';

/**
 * Every pool this file constructs uses the default `'worker'` transport, so
 * an acquired `RevisionRealm` is always genuinely a `WorkerRealm` at
 * runtime. This narrows for the one test-only seam
 * (`postRawMessageForTesting`) the shared `RevisionRealm` port deliberately
 * excludes — see `revision-realm.ts`'s own module doc for why.
 */
function asWorkerRealm(realm: RevisionRealm): WorkerRealm {
  return realm as WorkerRealm;
}

const workerUrl = new URL('./__fixtures__/revision-realm-worker-entry.ts', import.meta.url);

function configFor(revision: 'revision-a' | 'revision-b') {
  return {
    workerUrl,
    expectedWorkflowTypes: ['order-workflow'],
    expectedArtifactDigest: `digest-${revision}`,
    workerName: `digest-${revision}`,
    concurrency: 2,
  };
}

/** A settled-or-not tracker that never resolves/rejects the underlying promise itself -- used to observe whether a turn is still in flight without racing a timer. */
function trackSettlement(promise: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  void (async () => {
    try {
      await promise;
    } catch {
      // Settlement (success or failure) is all this tracker observes.
    } finally {
      settled = true;
    }
  })();
  return { settled: () => settled };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('RevisionRealmRegistry', () => {
  describe('two revisions of one workflow execute concurrently in distinct realms', () => {
    it('acquires a distinct realm per revision, each honoring only its own artifact digest', async () => {
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));
      registry.ensurePool('order-workflow', 'revision-b', configFor('revision-b'));

      const a = await registry.acquireForExecution('order-workflow', 'revision-a', 'execution-a');
      const b = await registry.acquireForExecution('order-workflow', 'revision-b', 'execution-b');
      if (!a.ok || !b.ok) throw new Error('unreachable');

      expect(a.realm).not.toBe(b.realm);
      expect(registry.activeRealmCount('order-workflow', 'revision-a')).toBe(1);
      expect(registry.activeRealmCount('order-workflow', 'revision-b')).toBe(1);

      registry.releaseAfterExecution('order-workflow', 'revision-a', a.realm);
      registry.releaseAfterExecution('order-workflow', 'revision-b', b.realm);
    });

    it("runs a concurrent, in-flight turn on each revision's realm at once -- proved by barriers, not timing", async () => {
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));
      registry.ensurePool('order-workflow', 'revision-b', configFor('revision-b'));

      const a = await registry.acquireForExecution('order-workflow', 'revision-a', 'execution-a');
      const b = await registry.acquireForExecution('order-workflow', 'revision-b', 'execution-b');
      if (!a.ok || !b.ok) throw new Error('unreachable');

      const activationA: WorkerRealmActivation = {
        workflowRevision: 'revision-a',
        realmGeneration: realmGenerationOf(a.realm),
        executionToken: 'execution-a',
      };
      const activationB: WorkerRealmActivation = {
        workflowRevision: 'revision-b',
        realmGeneration: realmGenerationOf(b.realm),
        executionToken: 'execution-b',
      };

      const turnA = a.realm.dispatchTurn({ ...activationA, turnId: 1 }, { from: 'a' });
      const turnB = b.realm.dispatchTurn({ ...activationB, turnId: 1 }, { from: 'b' });
      const trackedA = trackSettlement(turnA);
      const trackedB = trackSettlement(turnB);

      // Both turns are genuinely in flight at once -- neither settles just
      // because the other was dispatched.
      await flushMicrotasks();
      expect(trackedA.settled()).toBe(false);
      expect(trackedB.settled()).toBe(false);

      // Releasing A alone must not affect B: this is the barrier proving
      // concurrency, not a timing race -- B only ever settles from its OWN
      // explicit release below.
      asWorkerRealm(a.realm).postRawMessageForTesting({ type: 'test-release', turnId: 1 });
      const resultA = (await turnA) as { echoed: unknown };
      expect(resultA.echoed).toEqual({ from: 'a' });
      await flushMicrotasks();
      expect(trackedB.settled()).toBe(false);

      asWorkerRealm(b.realm).postRawMessageForTesting({ type: 'test-release', turnId: 1 });
      const resultB = (await turnB) as { echoed: unknown };
      expect(resultB.echoed).toEqual({ from: 'b' });

      registry.releaseAfterExecution('order-workflow', 'revision-a', a.realm);
      registry.releaseAfterExecution('order-workflow', 'revision-b', b.realm);
    });

    it("rejects revision A's turn envelope against revision B's realm, and vice versa -- distinct realm identity, not just distinct objects", async () => {
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));
      registry.ensurePool('order-workflow', 'revision-b', configFor('revision-b'));

      const a = await registry.acquireForExecution('order-workflow', 'revision-a', 'execution-a');
      const b = await registry.acquireForExecution('order-workflow', 'revision-b', 'execution-b');
      if (!a.ok || !b.ok) throw new Error('unreachable');

      expect(
        await throwingRejectionOf(
          a.realm.dispatchTurn(
            {
              workflowRevision: 'revision-b',
              realmGeneration: realmGenerationOf(a.realm),
              executionToken: 'execution-a',
              turnId: 1,
            },
            {},
          ),
        ),
      ).toThrow('Realm turn envelope mismatch');

      expect(
        await throwingRejectionOf(
          b.realm.dispatchTurn(
            {
              workflowRevision: 'revision-a',
              realmGeneration: realmGenerationOf(b.realm),
              executionToken: 'execution-b',
              turnId: 1,
            },
            {},
          ),
        ),
      ).toThrow('Realm turn envelope mismatch');

      registry.releaseAfterExecution('order-workflow', 'revision-a', a.realm);
      registry.releaseAfterExecution('order-workflow', 'revision-b', b.realm);
    });

    it('crashing revision A does not touch revision B -- realm crash isolates sibling revisions', async () => {
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));
      registry.ensurePool('order-workflow', 'revision-b', configFor('revision-b'));

      const a = await registry.acquireForExecution('order-workflow', 'revision-a', 'execution-a');
      const b = await registry.acquireForExecution('order-workflow', 'revision-b', 'execution-b');
      if (!a.ok || !b.ok) throw new Error('unreachable');

      a.realm.crash();
      registry.forgetCrashedRealm('order-workflow', 'revision-a', a.realm);

      expect(registry.activeRealmCount('order-workflow', 'revision-a')).toBe(0);
      expect(registry.activeRealmCount('order-workflow', 'revision-b')).toBe(1);
      expect(b.realm.lifecycle.state).toBe('active');

      registry.releaseAfterExecution('order-workflow', 'revision-b', b.realm);
    });
  });

  describe('activation routing and reclamation', () => {
    it('routes a new start only to the active revision, refusing an inactive one', async () => {
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));
      registry.markInactive('order-workflow', 'revision-a');

      const outcome = await registry.acquireForExecution(
        'order-workflow',
        'revision-a',
        'execution-x',
      );
      expect(outcome).toEqual({ ok: false, reason: 'revision-not-active' });
    });

    it('keeps the old realm available for a run already pinned to it after activation moves elsewhere', async () => {
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));

      const pinned = await registry.acquireForExecution(
        'order-workflow',
        'revision-a',
        'execution-pinned',
      );
      if (!pinned.ok) throw new Error('unreachable');

      registry.markInactive('order-workflow', 'revision-a');

      expect(pinned.realm.lifecycle.state).toBe('active');
      expect(registry.activeRealmCount('order-workflow', 'revision-a')).toBe(1);

      registry.releaseAfterExecution('order-workflow', 'revision-a', pinned.realm);
      expect(registry.getPool('order-workflow', 'revision-a')).toBeUndefined();
    });

    it('a drained realm with no pinned work terminates and cannot emit an accepted late result', async () => {
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));

      const acquired = await registry.acquireForExecution(
        'order-workflow',
        'revision-a',
        'execution-a',
      );
      if (!acquired.ok) throw new Error('unreachable');
      const activation: WorkerRealmActivation = {
        workflowRevision: 'revision-a',
        realmGeneration: realmGenerationOf(acquired.realm),
        executionToken: 'execution-a',
      };

      const pending = acquired.realm.dispatchTurn({ ...activation, turnId: 1 }, {});

      registry.markInactive('order-workflow', 'revision-a');
      registry.releaseAfterExecution('order-workflow', 'revision-a', acquired.realm);

      expect(acquired.realm.lifecycle.state).toBe('terminated');
      expect(await throwingRejectionOf(pending)).toThrow('realm-not-active');

      // A late result from the (already-terminated) realm's worker cannot
      // resurrect the turn -- it is simply dropped.
      asWorkerRealm(acquired.realm).postRawMessageForTesting({
        type: 'realm-result',
        envelope: { ...activation, turnId: 1 },
        result: 'too-late',
      });
      expect(registry.getPool('order-workflow', 'revision-a')).toBeUndefined();
    });

    it('does not reclaim the pool out from under a still-warming acquisition, refusing cleanly instead of tearing the realm down mid-handshake', async () => {
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));

      const acquisition = registry.acquireForExecution(
        'order-workflow',
        'revision-a',
        'execution-a',
      );
      // Called synchronously, before the real Worker's `ready` message can
      // possibly have arrived (see the equivalent pool-level test's comment
      // for why this ordering is guaranteed, not timed). Before the fix,
      // this tore the pool -- and the still-warming realm's Worker -- down
      // immediately, and the acquisition failed with the unrelated
      // `realm-ready-handshake-failed` instead of a clean refusal.
      registry.markInactive('order-workflow', 'revision-a');

      const outcome = await acquisition;
      expect(outcome).toEqual({ ok: false, reason: 'revision-not-active' });
    });

    it('markActive reactivates a still-tracked pool (one with in-flight work), letting a concurrent new start through', async () => {
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));

      const first = await registry.acquireForExecution(
        'order-workflow',
        'revision-a',
        'execution-1',
      );
      if (!first.ok) throw new Error('unreachable');

      registry.markInactive('order-workflow', 'revision-a');
      registry.markActive('order-workflow', 'revision-a');

      const second = await registry.acquireForExecution(
        'order-workflow',
        'revision-a',
        'execution-2',
      );
      expect(second.ok).toBe(true);

      registry.releaseAfterExecution('order-workflow', 'revision-a', first.realm);
      if (second.ok) registry.releaseAfterExecution('order-workflow', 'revision-a', second.realm);
    });
  });

  describe('dispose', () => {
    afterEach(() => {
      // See revision-realm-pool.test.ts's identical comment: `spyOn` wraps
      // the shared, process-global `Worker.prototype` and must not leak into
      // other test files in this same `bun test` process.
      Worker.prototype.terminate &&
        (Worker.prototype.terminate as unknown as { mockRestore?: () => void }).mockRestore?.();
    });

    it('discards every pool and realm regardless of state', async () => {
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));
      const acquired = await registry.acquireForExecution(
        'order-workflow',
        'revision-a',
        'execution-1',
      );
      if (!acquired.ok) throw new Error('unreachable');

      registry.dispose();

      expect(acquired.realm.lifecycle.state).toBe('terminated');
      expect(registry.getPool('order-workflow', 'revision-a')).toBeUndefined();
    });

    // COR-113: repeated disposal or close signals must share one memoized
    // termination -- a second `dispose()` call must not re-discard an
    // already-discarded realm or send a second `Worker.terminate()`.
    it('is idempotent: a repeated dispose() call does not re-discard or re-terminate any realm', async () => {
      const terminateSpy = spyOn(Worker.prototype, 'terminate');
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));
      const acquired = await registry.acquireForExecution(
        'order-workflow',
        'revision-a',
        'execution-1',
      );
      if (!acquired.ok) throw new Error('unreachable');

      registry.dispose();
      expect(() => registry.dispose()).not.toThrow();

      expect(terminateSpy).toHaveBeenCalledTimes(1);
    });

    // COR-113: "realm crash settles all pending turns and isolates sibling
    // revisions" extends to disposal -- a pending turn in EVERY distinct
    // revision pool this registry owns must settle, and every realm's
    // underlying Worker must be terminated exactly once, never leaked.
    it('settles a pending turn in every distinct revision pool and terminates each realm exactly once', async () => {
      const terminateSpy = spyOn(Worker.prototype, 'terminate');
      const registry = new RevisionRealmRegistry();
      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));
      registry.ensurePool('order-workflow', 'revision-b', configFor('revision-b'));

      const acquiredA = await registry.acquireForExecution(
        'order-workflow',
        'revision-a',
        'execution-a',
      );
      const acquiredB = await registry.acquireForExecution(
        'order-workflow',
        'revision-b',
        'execution-b',
      );
      if (!acquiredA.ok || !acquiredB.ok) throw new Error('unreachable');

      const activationA = acquiredA.realm.activation;
      const activationB = acquiredB.realm.activation;
      if (!activationA || !activationB) throw new Error('unreachable');

      const pendingA = acquiredA.realm.dispatchTurn({ ...activationA, turnId: 1 }, {});
      const pendingB = acquiredB.realm.dispatchTurn({ ...activationB, turnId: 1 }, {});
      const trackedA = trackSettlement(pendingA);
      const trackedB = trackSettlement(pendingB);

      registry.dispose();
      await flushMicrotasks();

      expect(trackedA.settled()).toBe(true);
      expect(trackedB.settled()).toBe(true);
      expect(acquiredA.realm.lifecycle.state).toBe('terminated');
      expect(acquiredB.realm.lifecycle.state).toBe('terminated');
      expect(terminateSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('listDiagnostics (COR-243)', () => {
    it('reports every pool this registry owns, keyed by (name, revision)', async () => {
      const registry = new RevisionRealmRegistry();
      expect(registry.listDiagnostics()).toEqual([]);

      registry.ensurePool('order-workflow', 'revision-a', configFor('revision-a'));
      registry.ensurePool('order-workflow', 'revision-b', configFor('revision-b'));
      const a = await registry.acquireForExecution('order-workflow', 'revision-a', 'execution-a');
      if (!a.ok) throw new Error('unreachable');

      const diagnostics = registry.listDiagnostics();
      expect(diagnostics).toHaveLength(2);
      const forRevisionA = diagnostics.find((entry) => entry.revision === 'revision-a');
      const forRevisionB = diagnostics.find((entry) => entry.revision === 'revision-b');
      expect(forRevisionA).toEqual({
        name: 'order-workflow',
        revision: 'revision-a',
        revisionActive: true,
        realms: [
          {
            state: 'active',
            realmGeneration: realmGenerationOf(a.realm),
            restartCount: 0,
            pendingTurnCount: 0,
          },
        ],
      });
      expect(forRevisionB).toEqual({
        name: 'order-workflow',
        revision: 'revision-b',
        revisionActive: true,
        realms: [],
      });

      registry.releaseAfterExecution('order-workflow', 'revision-a', a.realm);
    });
  });
});

function realmGenerationOf(realm: RevisionRealm): string {
  if (!realm.activation) throw new Error('realm is not activated');
  return realm.activation.realmGeneration;
}
