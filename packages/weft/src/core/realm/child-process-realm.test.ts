import { afterEach, describe, expect, it } from 'bun:test';

import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from '../../testing/fake-timers.test-support.ts';
import { ChildProcessRealm } from './child-process-realm.ts';
import type { RevisionRealmActivation } from './revision-realm.ts';

const scriptPath = new URL('./__fixtures__/revision-realm-child-process-entry.ts', import.meta.url);
const unresponsiveScriptPath = new URL(
  './__fixtures__/revision-realm-child-process-unresponsive.ts',
  import.meta.url,
);
const throwingScriptPath = new URL(
  './__fixtures__/revision-realm-child-process-throwing.ts',
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
): ChildProcessRealm {
  return new ChildProcessRealm({
    scriptPath,
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

function activationFor(outcome: { realmGeneration: string }): RevisionRealmActivation {
  return {
    workflowRevision: 'revision-a',
    realmGeneration: outcome.realmGeneration,
    executionToken: 'token-1',
  };
}

async function readyAndActive(realm: ChildProcessRealm): Promise<RevisionRealmActivation> {
  const outcome = await realm.waitUntilReady();
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  const activation = activationFor(outcome);
  realm.activate(activation);
  return activation;
}

describe('ChildProcessRealm', () => {
  it('spawns a real child process, completes the ready handshake, and reaches Active on activate()', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    await readyAndActive(realm);
    expect(realm.lifecycle.state).toBe('active');
    realm.discard();
    await realm.whenReclaimed();
  });

  it('crashes instead of becoming ready when the expected artifact digest disagrees', async () => {
    const realm = makeRealm({ workerName: 'digest-a', expectedArtifactDigest: 'digest-b' });
    const outcome = await realm.waitUntilReady();
    expect(outcome.ok).toBe(false);
    expect(realm.lifecycle.state).toBe('crashed');
    realm.discard();
    await realm.whenReclaimed();
  });

  it('dispatches a turn over the IPC channel and resolves it once the child process reports a result', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, { hello: 'world' });
    // The fixture process does not auto-complete; it waits for an explicit release.
    realm.postRawMessageForTesting({ type: 'test-release', turnId: 1 });

    const result = (await pending) as { echoed: unknown; sentinel: string };
    expect(result.echoed).toEqual({ hello: 'world' });
    expect(result.sentinel).toContain('weft-cor249-revision-realm-workflow-implementation-fixture');
    realm.discard();
    await realm.whenReclaimed();
  });

  it('rejects a turn dispatched with the wrong workflowRevision before ever reaching the child process', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    await expect(
      realm.dispatchTurn({ ...activation, workflowRevision: 'revision-b', turnId: 1 }, {}),
    ).rejects.toThrow('Realm turn envelope mismatch');
    expect(realm.pendingTurnCount).toBe(0);
    realm.discard();
    await realm.whenReclaimed();
  });

  it('rejects a pending turn when the child process reports realm-failure', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
    realm.postRawMessageForTesting({ type: 'test-fail', turnId: 1, error: 'boom' });

    await expect(pending).rejects.toThrow('boom');
    realm.discard();
    await realm.whenReclaimed();
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
    await realm.whenReclaimed();
  });

  it('rejects a turn still pending at termination, ending in Terminated', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
    realm.beginDrain();
    realm.terminate();

    expect(realm.lifecycle.state).toBe('terminated');
    await expect(pending).rejects.toThrow('realm-not-active');
    await realm.whenReclaimed();
  });

  it('discard() ends an idle, never-activated Ready realm in Crashed (no Terminated exit exists from Ready)', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    await realm.waitUntilReady();
    expect(realm.lifecycle.state).toBe('ready');

    realm.discard();
    expect(realm.lifecycle.state).toBe('crashed');
    await realm.whenReclaimed();
  });

  it('restart() after a crash spawns a fresh child process that can complete a new ready handshake', async () => {
    const realm = makeRealm({ workerName: 'digest-a' });
    await readyAndActive(realm);
    const firstPid = realm.pid;
    realm.crash();
    expect(realm.lifecycle.state).toBe('crashed');

    expect(realm.restart()).toEqual({ ok: true });
    expect(realm.lifecycle.state).toBe('warming');
    expect(realm.pid).not.toBe(firstPid);

    const outcome = await realm.waitUntilReady();
    expect(outcome.ok).toBe(true);
    realm.discard();
    await realm.whenReclaimed();
  });

  describe('a real child-process failure or a stalled handshake', () => {
    afterEach(() => {
      restoreRealTimers();
    });

    it('times out waitUntilReady when the realm never sends ready', async () => {
      useFakeTimers();
      const realm = new ChildProcessRealm({
        scriptPath: unresponsiveScriptPath,
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
      await realm.whenReclaimed();
    });

    it('a real child-process load-time failure ends the realm in Crashed, not a thrown exception', async () => {
      const realm = new ChildProcessRealm({
        scriptPath: throwingScriptPath,
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
      await realm.whenReclaimed();
    });
  });

  // COR-113: repeated disposal or close signals must share one memoized
  // termination -- never a second `.kill()`, never a thrown
  // `RealmLifecycleTransitionError` for a shutdown signal that arrives after
  // this realm already finished shutting down.
  describe('idempotent termination', () => {
    it('crash() called twice does not throw and kills the underlying process exactly once', async () => {
      const realm = makeRealm({ workerName: 'digest-a' });
      const activation = await readyAndActive(realm);
      const pid = realm.pid;

      const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});

      realm.crash();
      await expect(pending).rejects.toThrow('realm-not-active');
      expect(() => realm.crash()).not.toThrow();

      expect(realm.lifecycle.state).toBe('crashed');
      const reclaimed = await realm.whenReclaimed();
      expect(reclaimed.pid).toBe(pid);
    });

    it('terminate() called twice does not throw and kills the underlying process exactly once', async () => {
      const realm = makeRealm({ workerName: 'digest-a' });
      const activation = await readyAndActive(realm);

      const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
      realm.beginDrain();

      realm.terminate();
      await expect(pending).rejects.toThrow('realm-not-active');
      expect(() => realm.terminate()).not.toThrow();

      expect(realm.lifecycle.state).toBe('terminated');
      await realm.whenReclaimed();
    });

    it('discard() called twice on an idle Ready realm does not throw', async () => {
      const realm = makeRealm({ workerName: 'digest-a' });
      await realm.waitUntilReady();

      realm.discard();
      expect(() => realm.discard()).not.toThrow();

      expect(realm.lifecycle.state).toBe('crashed');
      await realm.whenReclaimed();
    });

    it('a close signal (discard) arriving after crash() already settled the realm is a no-op, not a thrown re-crash', async () => {
      const realm = makeRealm({ workerName: 'digest-a' });
      await readyAndActive(realm);

      realm.crash();
      expect(() => realm.discard()).not.toThrow();

      expect(realm.lifecycle.state).toBe('crashed');
      await realm.whenReclaimed();
    });
  });

  // COR-246's own coordinator decision: prove reclamation via observed
  // events -- an actually-dead OS process and an actually-closed IPC
  // channel -- never inferred from `kill()`'s own void return value.
  describe('reclamation (COR-246)', () => {
    it('a terminated realm releases its OS process: the pid no longer answers to a liveness signal', async () => {
      const realm = makeRealm({ workerName: 'digest-a' });
      await readyAndActive(realm);

      const { pid } = realm;
      realm.beginDrain();
      realm.terminate();
      const reclamation = await realm.whenReclaimed();
      expect(reclamation.pid).toBe(pid);

      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    });

    it('a crashed realm releases its OS process the same way', async () => {
      const realm = makeRealm({ workerName: 'digest-a' });
      await readyAndActive(realm);

      const { pid } = realm;
      realm.crash();
      await realm.whenReclaimed();

      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    });

    it('a terminated realm closes its IPC channel: sending to it afterward throws rather than silently doing nothing', async () => {
      const realm = makeRealm({ workerName: 'digest-a' });
      await readyAndActive(realm);

      realm.beginDrain();
      realm.terminate();
      await realm.whenReclaimed();

      expect(() => realm.postRawMessageForTesting({ type: 'test-release', turnId: 1 })).toThrow();
    });
  });
});
