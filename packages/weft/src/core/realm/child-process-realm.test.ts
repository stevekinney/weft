import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from '../../testing/fake-timers.test-support.ts';
import {
  outcomeOf,
  rethrow,
  SCENARIO_HANG_GUARD_MILLISECONDS,
} from '../../testing/module-scope-scenario.test-support.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
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

/**
 * Every realm this file creates. A scenario its hang guard abandons still owns its realm and child
 * process, so any realm left unreclaimed is crashed once the file's tests finish; `crash()` is
 * idempotent for the realms scenarios already settled.
 */
const createdRealms: ChildProcessRealm[] = [];

function tracked(realm: ChildProcessRealm): ChildProcessRealm {
  createdRealms.push(realm);
  return realm;
}

afterAll(() => {
  for (const realm of createdRealms) realm.crash();
});

/** `outcomeOf` that crashes the realms a hung scenario created as soon as its guard fires. */
async function realmScenario(scenario: () => Promise<void>): Promise<unknown> {
  const firstRealm = createdRealms.length;
  return outcomeOf(scenario, SCENARIO_HANG_GUARD_MILLISECONDS, () => {
    for (const realm of createdRealms.slice(firstRealm)) realm.crash();
  });
}

function makeRealm(
  overrides: Partial<{
    expectedArtifactDigest: string;
    workerName: string;
    isReferenced: () => boolean;
    maxRestarts: number;
    realmReadyTimeoutMs: number;
  }> = {},
): ChildProcessRealm {
  return tracked(
    new ChildProcessRealm({
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
    }),
  );
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

// Each scenario below spawns a real child-process realm, which takes seconds on a loaded host, so
// it runs here at module scope, off Bun's five-second per-test clock, and restores real timers
// when it ends; its test rethrows the outcome.

const scenario1 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    await readyAndActive(realm);
    expect(realm.lifecycle.state).toBe('active');
    realm.discard();
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario2 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a', expectedArtifactDigest: 'digest-b' });
    const outcome = await realm.waitUntilReady();
    expect(outcome.ok).toBe(false);
    expect(realm.lifecycle.state).toBe('crashed');
    realm.discard();
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario3 = await realmScenario(async () => {
  try {
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
  } finally {
    restoreRealTimers();
  }
});

const scenario4 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    expect(
      await throwingRejectionOf(
        realm.dispatchTurn({ ...activation, workflowRevision: 'revision-b', turnId: 1 }, {}),
      ),
    ).toThrow('Realm turn envelope mismatch');
    expect(realm.pendingTurnCount).toBe(0);
    realm.discard();
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario5 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
    realm.postRawMessageForTesting({ type: 'test-fail', turnId: 1, error: 'boom' });

    expect(await throwingRejectionOf(pending)).toThrow('boom');
    realm.discard();
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario6 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const first = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
    const second = realm.dispatchTurn({ ...activation, turnId: 2 }, {});
    expect(realm.pendingTurnCount).toBe(2);

    realm.crash();

    expect(realm.lifecycle.state).toBe('crashed');
    expect(realm.pendingTurnCount).toBe(0);
    // Both turns reject at the crash; observe them together so neither is
    // left without a handler while the other is awaited.
    const [firstRejection, secondRejection] = await Promise.all([
      throwingRejectionOf(first),
      throwingRejectionOf(second),
    ]);
    expect(firstRejection).toThrow('realm-not-active');
    expect(secondRejection).toThrow('realm-not-active');
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario7 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
    realm.beginDrain();
    realm.terminate();

    expect(realm.lifecycle.state).toBe('terminated');
    expect(await throwingRejectionOf(pending)).toThrow('realm-not-active');
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario8 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    await realm.waitUntilReady();
    expect(realm.lifecycle.state).toBe('ready');

    realm.discard();
    expect(realm.lifecycle.state).toBe('crashed');
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario9 = await realmScenario(async () => {
  try {
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
  } finally {
    restoreRealTimers();
  }
});

const scenario10 = await realmScenario(async () => {
  try {
    useFakeTimers();
    const realm = tracked(
      new ChildProcessRealm({
        scriptPath: unresponsiveScriptPath,
        expectedWorkflowTypes: ['order-workflow'],
        isReferenced: () => true,
        maxRestarts: 0,
        realmReadyTimeoutMs: 5,
      }),
    );

    const pending = realm.waitUntilReady();
    await advanceTimersByTime(5);

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failureCategory).toBe('timeout');
    expect(realm.lifecycle.state).toBe('crashed');
    realm.discard();
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario11 = await realmScenario(async () => {
  try {
    const realm = tracked(
      new ChildProcessRealm({
        scriptPath: throwingScriptPath,
        expectedWorkflowTypes: ['order-workflow'],
        isReferenced: () => true,
        maxRestarts: 0,
      }),
    );

    const outcome = await realm.waitUntilReady();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failureCategory).toBe('system');
    expect(realm.lifecycle.state).toBe('crashed');
    realm.discard();
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario12 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);
    const pid = realm.pid;

    const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});

    realm.crash();
    expect(await throwingRejectionOf(pending)).toThrow('realm-not-active');
    expect(() => realm.crash()).not.toThrow();

    expect(realm.lifecycle.state).toBe('crashed');
    const reclaimed = await realm.whenReclaimed();
    expect(reclaimed.pid).toBe(pid);
  } finally {
    restoreRealTimers();
  }
});

const scenario13 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    const activation = await readyAndActive(realm);

    const pending = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
    realm.beginDrain();

    realm.terminate();
    expect(await throwingRejectionOf(pending)).toThrow('realm-not-active');
    expect(() => realm.terminate()).not.toThrow();

    expect(realm.lifecycle.state).toBe('terminated');
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario14 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    await realm.waitUntilReady();

    realm.discard();
    expect(() => realm.discard()).not.toThrow();

    expect(realm.lifecycle.state).toBe('crashed');
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario15 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    await readyAndActive(realm);

    realm.crash();
    expect(() => realm.discard()).not.toThrow();

    expect(realm.lifecycle.state).toBe('crashed');
    await realm.whenReclaimed();
  } finally {
    restoreRealTimers();
  }
});

const scenario16 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    await readyAndActive(realm);

    const { pid } = realm;
    realm.beginDrain();
    realm.terminate();
    const reclamation = await realm.whenReclaimed();
    expect(reclamation.pid).toBe(pid);

    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    restoreRealTimers();
  }
});

const scenario17 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    await readyAndActive(realm);

    const { pid } = realm;
    realm.crash();
    await realm.whenReclaimed();

    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    restoreRealTimers();
  }
});

const scenario18 = await realmScenario(async () => {
  try {
    const realm = makeRealm({ workerName: 'digest-a' });
    await readyAndActive(realm);

    realm.beginDrain();
    realm.terminate();
    await realm.whenReclaimed();

    expect(() => realm.postRawMessageForTesting({ type: 'test-release', turnId: 1 })).toThrow();
  } finally {
    restoreRealTimers();
  }
});

describe('ChildProcessRealm', () => {
  it('spawns a real child process, completes the ready handshake, and reaches Active on activate()', () =>
    rethrow(scenario1));

  it('crashes instead of becoming ready when the expected artifact digest disagrees', () =>
    rethrow(scenario2));

  it('dispatches a turn over the IPC channel and resolves it once the child process reports a result', () =>
    rethrow(scenario3));

  it('rejects a turn dispatched with the wrong workflowRevision before ever reaching the child process', () =>
    rethrow(scenario4));

  it('rejects a pending turn when the child process reports realm-failure', () =>
    rethrow(scenario5));

  it('settles every pending turn on crash, ending in Crashed', () => rethrow(scenario6));

  it('rejects a turn still pending at termination, ending in Terminated', () => rethrow(scenario7));

  it('discard() ends an idle, never-activated Ready realm in Crashed (no Terminated exit exists from Ready)', () =>
    rethrow(scenario8));

  it('restart() after a crash spawns a fresh child process that can complete a new ready handshake', () =>
    rethrow(scenario9));

  describe('a real child-process failure or a stalled handshake', () => {
    afterEach(() => {
      restoreRealTimers();
    });

    it('times out waitUntilReady when the realm never sends ready', () => rethrow(scenario10));

    it('a real child-process load-time failure ends the realm in Crashed, not a thrown exception', () =>
      rethrow(scenario11));
  });

  // COR-113: repeated disposal or close signals must share one memoized
  // termination -- never a second `.kill()`, never a thrown
  // `RealmLifecycleTransitionError` for a shutdown signal that arrives after
  // this realm already finished shutting down.
  describe('idempotent termination', () => {
    it('crash() called twice does not throw and kills the underlying process exactly once', () =>
      rethrow(scenario12));

    it('terminate() called twice does not throw and kills the underlying process exactly once', () =>
      rethrow(scenario13));

    it('discard() called twice on an idle Ready realm does not throw', () => rethrow(scenario14));

    it('a close signal (discard) arriving after crash() already settled the realm is a no-op, not a thrown re-crash', () =>
      rethrow(scenario15));
  });

  // COR-246's own coordinator decision: prove reclamation via observed
  // events -- an actually-dead OS process and an actually-closed IPC
  // channel -- never inferred from `kill()`'s own void return value.
  describe('reclamation (COR-246)', () => {
    it('a terminated realm releases its OS process: the pid no longer answers to a liveness signal', () =>
      rethrow(scenario16));

    it('a crashed realm releases its OS process the same way', () => rethrow(scenario17));

    it('a terminated realm closes its IPC channel: sending to it afterward throws rather than silently doing nothing', () =>
      rethrow(scenario18));
  });
});
