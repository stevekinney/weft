import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from '../../testing/fake-timers.test-support.ts';
import { WorkerRealm, type WorkerRealmActivation } from './worker-realm.ts';

const workerUrl = new URL('./__fixtures__/revision-realm-worker-entry.ts', import.meta.url);
const unresponsiveWorkerUrl = new URL(
  './__fixtures__/revision-realm-unresponsive-worker.ts',
  import.meta.url,
);
const throwingWorkerUrl = new URL(
  './__fixtures__/revision-realm-throwing-worker.ts',
  import.meta.url,
);

function makeRealm(
  overrides: Partial<{
    expectedArtifactDigest: string;
    workerName: string;
    isReferenced: () => boolean;
    maxRestarts: number;
    realmReadyTimeoutMs: number;
  }> = {},
): WorkerRealm {
  return new WorkerRealm({
    workerUrl,
    expectedWorkflowTypes: ['order-workflow'],
    isReferenced: overrides.isReferenced ?? (() => true),
    maxRestarts: overrides.maxRestarts ?? 3,
    ...(overrides.expectedArtifactDigest === undefined
      ? {}
      : { expectedArtifactDigest: overrides.expectedArtifactDigest }),
    ...(overrides.workerName === undefined ? {} : { workerName: overrides.workerName }),
    ...(overrides.realmReadyTimeoutMs === undefined
      ? {}
      : { realmReadyTimeoutMs: overrides.realmReadyTimeoutMs }),
  });
}

function activationFor(outcome: { realmGeneration: string }): WorkerRealmActivation {
  return {
    workflowRevision: 'revision-a',
    realmGeneration: outcome.realmGeneration,
    executionToken: 'token-1',
  };
}

async function readyAndActive(realm: WorkerRealm): Promise<WorkerRealmActivation> {
  const outcome = await realm.waitUntilReady();
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  const activation = activationFor(outcome);
  realm.activate(activation);
  return activation;
}

describe('WorkerRealm', () => {
  it('spawns a real Worker, completes the ready handshake, and reaches Active on activate()', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    await readyAndActive(realm);
    expect(realm.lifecycle.state).toBe('active');
    realm.discard();
  });

  it('crashes instead of becoming ready when the expected artifact digest disagrees', async () => {
    const realm = makeRealm({ workerName: 'digest-a', expectedArtifactDigest: 'digest-b' });
    const outcome = await realm.waitUntilReady();
    expect(outcome.ok).toBe(false);
    expect(realm.lifecycle.state).toBe('crashed');
    realm.discard();
  });

  it('dispatches a turn over postMessage and resolves it once the worker reports a result', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, { hello: 'world' });
    // The fixture worker does not auto-complete; it waits for an explicit release.
    realm.postRawMessageForTesting({ type: 'test-release', turnId: 1 });

    const result = (await pending) as { echoed: unknown; sentinel: string };
    expect(result.echoed).toEqual({ hello: 'world' });
    expect(result.sentinel).toContain('weft-cor249-revision-realm-workflow-implementation-fixture');
    realm.discard();
  });

  it('rejects a turn dispatched with the wrong workflowRevision before ever reaching the worker', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    await expect(
      realm.dispatchTurn({ ...activation, workflowRevision: 'revision-b', turnId: 1 }, {}),
    ).rejects.toThrow('Realm turn envelope mismatch');
    expect(realm.pendingTurnCount).toBe(0);
    realm.discard();
  });

  it('rejects a pending turn when the worker reports realm-failure', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
    realm.postRawMessageForTesting({ type: 'test-fail', turnId: 1, error: 'boom' });

    await expect(pending).rejects.toThrow('boom');
    realm.discard();
  });

  it('settles every pending turn on crash, ending in Crashed', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const first = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
    const second = realm.dispatchTurn({ ...activation, turnId: 2 }, {});
    expect(realm.pendingTurnCount).toBe(2);

    realm.crash();

    expect(realm.lifecycle.state).toBe('crashed');
    expect(realm.pendingTurnCount).toBe(0);
    await expect(first).rejects.toThrow('realm-not-active');
    await expect(second).rejects.toThrow('realm-not-active');
  });

  it('rejects a turn still pending at termination, ending in Terminated', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
    realm.beginDrain();
    realm.terminate();

    expect(realm.lifecycle.state).toBe('terminated');
    await expect(pending).rejects.toThrow('realm-not-active');
  });

  it('discard() ends an idle, never-activated Ready realm in Crashed (no Terminated exit exists from Ready)', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    await realm.waitUntilReady();
    expect(realm.lifecycle.state).toBe('ready');

    realm.discard();
    expect(realm.lifecycle.state).toBe('crashed');
  });

  it('restart() after a crash spawns a fresh Worker that can complete a new ready handshake', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    await readyAndActive(realm);
    realm.crash();
    expect(realm.lifecycle.state).toBe('crashed');

    expect(realm.restart()).toEqual({ ok: true });
    expect(realm.lifecycle.state).toBe('warming');

    const outcome = await realm.waitUntilReady();
    expect(outcome.ok).toBe(true);
    realm.discard();
  });

  describe('a real Worker failure or a stalled handshake', () => {
    afterEach(() => {
      restoreRealTimers();
    });

    it('times out waitUntilReady when the realm never sends ready', async () => {
      useFakeTimers();
      const realm = new WorkerRealm({
        workerUrl: unresponsiveWorkerUrl,
        expectedWorkflowTypes: ['order-workflow'],
        isReferenced: () => true,
        maxRestarts: 0,
        realmReadyTimeoutMs: 5,
      });

      const pending = realm.waitUntilReady();
      await advanceTimersByTime(5);

      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('unreachable');
      expect(outcome.failureCategory).toBe('timeout');
      expect(realm.lifecycle.state).toBe('crashed');
      realm.discard();
    });

    it('a real Worker error before the ready handshake ends the realm in Crashed, not a thrown exception', async () => {
      const realm = new WorkerRealm({
        workerUrl: throwingWorkerUrl,
        expectedWorkflowTypes: ['order-workflow'],
        isReferenced: () => true,
        maxRestarts: 0,
      });

      const outcome = await realm.waitUntilReady();
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('unreachable');
      expect(outcome.failureCategory).toBe('system');
      expect(realm.lifecycle.state).toBe('crashed');
      realm.discard();
    });
  });

  // COR-113: repeated disposal or close signals must share one memoized
  // termination -- never a second `Worker.terminate()`, never a thrown
  // `RealmLifecycleTransitionError` for a shutdown signal that arrives after
  // this realm already finished shutting down.
  describe('idempotent termination', () => {
    afterEach(() => {
      // See revision-realm-pool.test.ts's identical comment: `spyOn` wraps
      // the shared, process-global `Worker.prototype` and must not leak into
      // other test files in this same `bun test` process.
      Worker.prototype.terminate &&
        (Worker.prototype.terminate as unknown as { mockRestore?: () => void }).mockRestore?.();
    });

    it('crash() called twice does not throw and terminates the underlying Worker exactly once', async () => {
      const terminateSpy = spyOn(Worker.prototype, 'terminate');
      const realm = makeRealm({ workerName: 'digest-a' });
      const activation = await readyAndActive(realm);

      const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});

      realm.crash();
      // Attach the rejection handler immediately after the call that settles
      // `pending` -- before any further synchronous statement -- so this
      // test's own assertion machinery cannot itself widen the window in
      // which the rejection is momentarily unobserved.
      await expect(pending).rejects.toThrow('realm-not-active');
      expect(() => realm.crash()).not.toThrow();

      expect(realm.lifecycle.state).toBe('crashed');
      expect(terminateSpy).toHaveBeenCalledTimes(1);
    });

    it('terminate() called twice does not throw and terminates the underlying Worker exactly once', async () => {
      const terminateSpy = spyOn(Worker.prototype, 'terminate');
      const realm = makeRealm({ workerName: 'digest-a' });
      const activation = await readyAndActive(realm);

      const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
      realm.beginDrain();

      realm.terminate();
      await expect(pending).rejects.toThrow('realm-not-active');
      expect(() => realm.terminate()).not.toThrow();

      expect(realm.lifecycle.state).toBe('terminated');
      expect(terminateSpy).toHaveBeenCalledTimes(1);
    });

    it('discard() called twice on an idle Ready realm does not throw and terminates the underlying Worker exactly once', async () => {
      const terminateSpy = spyOn(Worker.prototype, 'terminate');
      const realm = makeRealm({ workerName: 'digest-a' });
      await realm.waitUntilReady();

      realm.discard();
      expect(() => realm.discard()).not.toThrow();

      expect(realm.lifecycle.state).toBe('crashed');
      expect(terminateSpy).toHaveBeenCalledTimes(1);
    });

    it('a close signal (discard) arriving after crash() already settled the realm is a no-op, not a thrown re-crash', async () => {
      const terminateSpy = spyOn(Worker.prototype, 'terminate');
      const realm = makeRealm({ workerName: 'digest-a' });
      await readyAndActive(realm);

      realm.crash();
      expect(() => realm.discard()).not.toThrow();

      expect(realm.lifecycle.state).toBe('crashed');
      expect(terminateSpy).toHaveBeenCalledTimes(1);
    });

    it('a crash() arriving after terminate() already settled the realm is a no-op, not a thrown re-crash', async () => {
      const terminateSpy = spyOn(Worker.prototype, 'terminate');
      const realm = makeRealm({ workerName: 'digest-a' });
      const activation = await readyAndActive(realm);
      const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
      realm.beginDrain();
      realm.terminate();
      await expect(pending).rejects.toThrow('realm-not-active');

      expect(() => realm.crash()).not.toThrow();

      expect(realm.lifecycle.state).toBe('terminated');
      expect(terminateSpy).toHaveBeenCalledTimes(1);
    });
  });

  // COR-246's own coordinator decision: prove reclamation via an observed
  // event -- Bun's real `close` `CloseEvent` on the underlying Worker --
  // rather than inferring it from `worker.terminate()`'s own void return
  // (what the `terminateSpy` assertions above only ever proved).
  describe('reclamation (COR-246)', () => {
    it('a terminated realm releases its Worker handle: the underlying thread reports its own close event', async () => {
      const realm = makeRealm({ workerName: 'digest-a' });
      await readyAndActive(realm);

      realm.beginDrain();
      realm.terminate();

      await realm.whenReclaimed();
      // Reaching this line at all is the proof: `whenReclaimed()` resolves
      // only on Bun's own `close` event firing for the underlying Worker,
      // never merely because `terminate()` was called.
      expect(realm.lifecycle.state).toBe('terminated');
    });

    it('a crashed realm releases its Worker handle the same way', async () => {
      const realm = makeRealm({ workerName: 'digest-a' });
      await readyAndActive(realm);

      realm.crash();

      await realm.whenReclaimed();
      expect(realm.lifecycle.state).toBe('crashed');
    });
  });
});
