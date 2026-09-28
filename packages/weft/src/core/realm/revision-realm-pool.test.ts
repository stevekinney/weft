import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { ChildProcessRealm } from './child-process-realm.ts';
import { RevisionRealmPool } from './revision-realm-pool.ts';
import { WorkerRealm } from './worker-realm.ts';

const workerUrl = new URL('./__fixtures__/revision-realm-worker-entry.ts', import.meta.url);
const childProcessScriptPath = new URL(
  './__fixtures__/revision-realm-child-process-entry.ts',
  import.meta.url,
);

function makePool(overrides: Partial<{ concurrency: number }> = {}): RevisionRealmPool {
  return new RevisionRealmPool({
    workflowRevision: 'revision-a',
    workerUrl,
    expectedWorkflowTypes: ['order-workflow'],
    expectedArtifactDigest: 'digest-a',
    workerName: 'digest-a',
    concurrency: overrides.concurrency ?? 2,
  });
}

describe('RevisionRealmPool', () => {
  it('warms a fresh realm on acquireForExecution and activates it', async () => {
    const pool = makePool();
    const outcome = await pool.acquireForExecution('execution-1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.realm.lifecycle.state).toBe('active');
    expect(pool.activeRealmCount).toBe(1);
    pool.dispose();
  });

  it('diagnostics() reports state, generation, restarts, and pending turns for every tracked realm (COR-243)', async () => {
    const pool = makePool();
    expect(pool.diagnostics()).toEqual([]);

    const outcome = await pool.acquireForExecution('execution-1');
    if (!outcome.ok) throw new Error('unreachable');

    const diagnostics = pool.diagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual({
      state: 'active',
      realmGeneration: outcome.realm.activation?.realmGeneration ?? null,
      restartCount: 0,
      pendingTurnCount: 0,
    });
    expect(diagnostics[0]?.realmGeneration).not.toBeNull();

    pool.dispose();
  });

  it('warms up to but not beyond its concurrency limit', async () => {
    const pool = makePool({ concurrency: 1 });
    const first = await pool.acquireForExecution('execution-1');
    expect(first.ok).toBe(true);

    const second = await pool.acquireForExecution('execution-2');
    expect(second).toEqual({ ok: false, reason: 'pool-at-capacity' });
    pool.dispose();
  });

  it('reuses an idle Ready realm instead of warming a new one', async () => {
    const pool = makePool({ concurrency: 1 });
    const first = await pool.acquireForExecution('execution-1');
    if (!first.ok) throw new Error('unreachable');
    expect(pool.realmCount).toBe(1);

    pool.releaseAfterExecution(first.realm);
    // The one realm this pool warmed is now Terminated (drained after its
    // one execution), not idle-and-reusable -- a realm never serves two
    // executions in this slice. A second acquire must warm a fresh one.
    expect(pool.realmCount).toBe(0);
    expect(first.realm.lifecycle.state).toBe('terminated');

    const second = await pool.acquireForExecution('execution-2');
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.realm).not.toBe(first.realm);
    pool.dispose();
  });

  it('refuses a new execution once the revision is marked inactive', async () => {
    const pool = makePool();
    pool.markInactive();
    const outcome = await pool.acquireForExecution('execution-1');
    expect(outcome).toEqual({ ok: false, reason: 'revision-not-active' });
    pool.dispose();
  });

  it('keeps an in-flight execution running after markInactive -- the old realm remains available for runs pinned to it', async () => {
    const pool = makePool();
    const outcome = await pool.acquireForExecution('execution-1');
    if (!outcome.ok) throw new Error('unreachable');

    pool.markInactive();

    expect(outcome.realm.lifecycle.state).toBe('active');
    expect(pool.activeRealmCount).toBe(1);
    expect(pool.isDrained).toBe(false);

    pool.releaseAfterExecution(outcome.realm);
    expect(pool.isDrained).toBe(true);
  });

  it('is drained immediately by markInactive when it has no in-flight execution', () => {
    const pool = makePool();
    expect(pool.isDrained).toBe(false);
    pool.markInactive();
    expect(pool.isDrained).toBe(true);
  });

  describe('markInactive racing a still-warming acquisition', () => {
    it('refuses, rather than activates, a realm whose handshake settles after markInactive was called mid-warm', async () => {
      const pool = makePool({ concurrency: 1 });

      const acquisition = pool.acquireForExecution('execution-1');
      // `acquireForExecution` has only run synchronously up to its `await
      // realm.waitUntilReady()` -- the real Worker it just spawned cannot
      // have crossed the thread boundary with its `ready` message yet,
      // because nothing above this line has yielded to the event loop.
      // Calling `markInactive` here is an event-ordering proof (ordinary JS
      // run-to-completion semantics), not a timing margin.
      pool.markInactive();

      const outcome = await acquisition;
      expect(outcome).toEqual({ ok: false, reason: 'revision-not-active' });
      expect(pool.realmCount).toBe(0);
      pool.dispose();
    });

    it('does not report drained while an acquisition is still warming, only once it resolves', async () => {
      const pool = makePool({ concurrency: 1 });

      const acquisition = pool.acquireForExecution('execution-1');
      pool.markInactive();

      // Reclaiming the pool right now would terminate the Worker this
      // still-pending acquisition has a live claim on.
      expect(pool.isDrained).toBe(false);

      await acquisition;
      expect(pool.isDrained).toBe(true);
      pool.dispose();
    });
  });

  it('discards a crashed realm and reflects zero active realms', async () => {
    const pool = makePool();
    const outcome = await pool.acquireForExecution('execution-1');
    if (!outcome.ok) throw new Error('unreachable');

    outcome.realm.crash();
    pool.forgetCrashedRealm(outcome.realm);

    expect(pool.activeRealmCount).toBe(0);
    expect(pool.realmCount).toBe(0);
  });

  it('markActive reverses a prior markInactive, letting acquireForExecution succeed again', async () => {
    const pool = makePool();
    pool.markInactive();
    expect(await pool.acquireForExecution('execution-1')).toEqual({
      ok: false,
      reason: 'revision-not-active',
    });

    pool.markActive();
    const outcome = await pool.acquireForExecution('execution-2');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) pool.releaseAfterExecution(outcome.realm);
  });

  it("a crashed realm's restart() consults this pool's own isReferenced, refusing once the pool has gone inactive", async () => {
    const pool = makePool();
    const outcome = await pool.acquireForExecution('execution-1');
    if (!outcome.ok) throw new Error('unreachable');

    outcome.realm.crash();
    pool.markInactive();

    expect(outcome.realm.restart()).toEqual({ ok: false, reason: 'unreferenced' });
    pool.forgetCrashedRealm(outcome.realm);
  });

  describe('a failed realm-ready handshake', () => {
    afterEach(() => {
      // `spyOn` wraps the shared, process-global `Worker.prototype` -- left
      // unrestored, it would leak into every other test file `bun test`
      // runs in this same process (worker-realm.test.ts in particular).
      Worker.prototype.terminate &&
        (Worker.prototype.terminate as unknown as { mockRestore?: () => void }).mockRestore?.();
    });

    it('terminates the underlying Worker thread instead of leaking it when the ready handshake rejects a digest mismatch', async () => {
      const terminateSpy = spyOn(Worker.prototype, 'terminate');
      const pool = new RevisionRealmPool({
        workflowRevision: 'revision-a',
        workerUrl,
        expectedWorkflowTypes: ['order-workflow'],
        // The fixture worker advertises `digest-a`; the pool expects
        // `digest-b`, so `validateRealmReadyMessage` rejects the handshake
        // and `acquireForExecution` takes its `!outcome.ok` branch.
        expectedArtifactDigest: 'digest-b',
        workerName: 'digest-a',
        concurrency: 1,
      });

      const outcome = await pool.acquireForExecution('execution-1');

      expect(outcome).toEqual({
        ok: false,
        reason: 'realm-ready-handshake-failed',
        error: expect.any(String),
      });
      // The pool's own bookkeeping already reports zero realms on this
      // failure path (that part was never broken) -- the regression is
      // that the real Worker thread behind the dropped realm kept running.
      // `realmCount === 0` alone cannot distinguish "properly discarded"
      // from "silently leaked"; the terminate spy is the only check that can.
      expect(pool.realmCount).toBe(0);
      expect(terminateSpy).toHaveBeenCalledTimes(1);
      pool.dispose();
    });
  });

  describe('dispose (COR-113: idempotent termination)', () => {
    afterEach(() => {
      Worker.prototype.terminate &&
        (Worker.prototype.terminate as unknown as { mockRestore?: () => void }).mockRestore?.();
    });

    it('a repeated dispose() call does not re-discard or re-terminate any realm', async () => {
      const terminateSpy = spyOn(Worker.prototype, 'terminate');
      const pool = makePool();
      const outcome = await pool.acquireForExecution('execution-1');
      if (!outcome.ok) throw new Error('unreachable');

      pool.dispose();
      expect(() => pool.dispose()).not.toThrow();

      expect(pool.realmCount).toBe(0);
      expect(terminateSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('transport selection (COR-246)', () => {
    it('omitting transport (the default) warms a WorkerRealm', async () => {
      const pool = makePool();
      const outcome = await pool.acquireForExecution('execution-1');
      if (!outcome.ok) throw new Error('unreachable');

      expect(outcome.realm).toBeInstanceOf(WorkerRealm);
      pool.dispose();
    });

    it("transport: 'child-process' warms a ChildProcessRealm that completes a real handshake and dispatches a turn", async () => {
      const pool = new RevisionRealmPool({
        workflowRevision: 'revision-a',
        workerUrl: childProcessScriptPath,
        expectedWorkflowTypes: ['order-workflow'],
        expectedArtifactDigest: 'digest-a',
        workerName: 'digest-a',
        concurrency: 1,
        transport: 'child-process',
      });
      const outcome = await pool.acquireForExecution('execution-1');
      if (!outcome.ok) throw new Error('unreachable');

      expect(outcome.realm).toBeInstanceOf(ChildProcessRealm);
      const realm = outcome.realm as ChildProcessRealm;
      if (!realm.activation) throw new Error('unreachable');

      const pending = realm.dispatchTurn({ ...realm.activation, turnId: 1 }, { hello: 'world' });
      realm.postRawMessageForTesting({ type: 'test-release', turnId: 1 });
      const result = (await pending) as { echoed: unknown };
      expect(result.echoed).toEqual({ hello: 'world' });

      pool.releaseAfterExecution(realm);
      await realm.whenReclaimed();
    });

    it("reserves capacity across the child-process transport's async warm path, so two concurrent acquires at concurrency: 1 cannot both pass the capacity gate", async () => {
      const pool = new RevisionRealmPool({
        workflowRevision: 'revision-a',
        workerUrl: childProcessScriptPath,
        expectedWorkflowTypes: ['order-workflow'],
        expectedArtifactDigest: 'digest-a',
        workerName: 'digest-a',
        concurrency: 1,
        transport: 'child-process',
      });

      // Both calls are issued synchronously, in the same microtask, before
      // either yields to the event loop: `acquireForExecution` runs
      // synchronously up to its own `await realm.waitUntilReady()`, and
      // `#warmNewChildProcessRealmIfUnderCapacity`'s capacity check plus its
      // `#warmingReservations` reservation both happen before ITS first
      // `await` too (see that member's own doc). This is an event-ordering
      // proof of the reservation guard, not a timing margin: without the
      // reservation, both calls would observe `#realms.size === 0` (neither
      // realm has been constructed yet) and pass the capacity check, both
      // warming a realm and exceeding `concurrency: 1`.
      const [first, second] = await Promise.all([
        pool.acquireForExecution('execution-1'),
        pool.acquireForExecution('execution-2'),
      ]);

      const outcomes = [first, second];
      const succeeded = outcomes.filter((outcome) => outcome.ok);
      const failed = outcomes.filter((outcome) => !outcome.ok);

      expect(succeeded).toHaveLength(1);
      expect(failed).toEqual([{ ok: false, reason: 'pool-at-capacity' }]);

      const winner = succeeded[0];
      if (!winner || !winner.ok) throw new Error('unreachable');
      const realm = winner.realm as ChildProcessRealm;
      pool.releaseAfterExecution(realm);
      await realm.whenReclaimed();
    });
  });
});
