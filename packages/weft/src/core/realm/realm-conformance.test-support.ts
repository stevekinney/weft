/**
 * Shared realm-protocol conformance suite (COR-246).
 *
 * `FakeRealm` (COR-117), `WorkerRealm` (COR-249), and `ChildProcessRealm`
 * (COR-246) each implement the same host/realm protocol — `RealmLifecycle`
 * transitions and `RealmTurnEnvelope` fencing — over three different wires
 * (a direct synchronous method call, a real `Worker`'s `postMessage`, and a
 * real `Bun.spawn` IPC channel). Before this suite, that protocol was proved
 * three times, once per adapter's own `*.test.ts` file, each writing its own
 * version of "wrong envelope field is rejected," "crash settles every
 * pending turn," and so on — this module extracts that shared assertion set
 * ONCE and runs it against all three through one small per-kind harness, so
 * the three adapters are proved to agree with each other, not merely proved
 * individually against their own, separately-written expectations.
 *
 * `FakeRealm`'s own port is deliberately synchronous and test-only
 * (`sendReady`/`acceptResult` instead of a real handshake/message loop) — see
 * `revision-realm.ts`'s module doc for why it does not implement
 * `RevisionRealm`. `wrapFakeRealm`/`wrapWorkerRealm`/`wrapChildProcessRealm`
 * (each adapter's own `*.conformance-harness.ts` — see
 * `realm-conformance.test.ts`) are what bridge each one to the uniform
 * {@link ConformanceRealm} surface this suite is written against; this
 * module knows nothing about any concrete adapter class.
 *
 * A "realm reports a failed turn" (`realm-failure`/`test-fail`) scenario is
 * deliberately OUT of this shared suite: `FakeRealm`'s synchronous port has
 * no analogous "the realm's own user code threw" concept distinct from a
 * host-side refusal, so there is nothing for all three to agree on there.
 * Each real adapter's own dedicated test file (`worker-realm.test.ts`,
 * `child-process-realm.test.ts`) already proves that scenario individually.
 *
 * @module core/realm/realm-conformance.test-support
 */

import { describe, expect, it } from 'bun:test';

import type { RealmReadyOutcome } from '../worker-realm-readiness.ts';
import type { RealmLifecycle, RealmRestartOutcome } from './realm-lifecycle.ts';
import type { RealmTurnEnvelope } from './realm-protocol.ts';
import type { RevisionRealmActivation } from './revision-realm.ts';

/** Options a conformance harness's `create()` normalizes into whatever its own concrete realm kind needs. */
export interface RealmConformanceCreateOptions {
  readonly expectedArtifactDigest?: string;
  /**
   * The digest THIS realm instance itself advertises in its ready handshake.
   * Every harness treats an identical `expectedArtifactDigest` /
   * `advertisedArtifactDigest` pair as a match and a differing pair as a
   * mismatch, regardless of how its own concrete adapter actually carries
   * that digest on the wire (`workerName`'s `realm-configure` message for
   * `WorkerRealm`/`ChildProcessRealm`, a manifest override for `FakeRealm`).
   */
  readonly advertisedArtifactDigest?: string;
  readonly maxRestarts?: number;
  readonly isReferenced?: () => boolean;
  readonly realmReadyTimeoutMs?: number;
}

/**
 * The uniform surface this suite drives every realm kind through. See the
 * module doc for why `FakeRealm` needs its own thin wrapper to present this
 * shape rather than implementing it directly.
 */
export interface ConformanceRealm {
  readonly lifecycle: RealmLifecycle;
  readonly pendingTurnCount: number;
  waitUntilReady(): Promise<RealmReadyOutcome>;
  activate(activation: RevisionRealmActivation): void;
  dispatchTurn(envelope: RealmTurnEnvelope, input: unknown): Promise<unknown>;
  /**
   * Deliver a successful result for the turn `envelope.turnId` names, using
   * whatever mechanism this realm kind's own wire actually uses. `envelope`
   * is compared against the ORIGINAL dispatch's own stored envelope by the
   * realm itself (not merely `turnId`) — passing a deliberately mismatched
   * `envelope` here is exactly how the envelope-fencing conformance case
   * below exercises that.
   */
  deliverResult(envelope: RealmTurnEnvelope, result: unknown): void;
  beginDrain(): void;
  terminate(): void;
  crash(): void;
  restart(): RealmRestartOutcome;
  discard(): void;
  /** Await this realm's own underlying resource reclamation where that is meaningful (a real adapter); a no-op for `FakeRealm`. */
  dispose(): Promise<void>;
}

/** One realm kind's conformance harness — see `realm-conformance.test.ts` for the three concrete factories. */
export interface RealmConformanceHarness {
  readonly label: string;
  create(options?: RealmConformanceCreateOptions): ConformanceRealm;
}

async function readyAndActive(
  realm: ConformanceRealm,
  overrides: Partial<RevisionRealmActivation> = {},
): Promise<RevisionRealmActivation> {
  const outcome = await realm.waitUntilReady();
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  const activation: RevisionRealmActivation = {
    workflowRevision: 'revision-a',
    realmGeneration: outcome.realmGeneration,
    executionToken: 'execution-1',
    ...overrides,
  };
  realm.activate(activation);
  return activation;
}

/** Run the shared realm-protocol conformance suite against one realm kind. */
export function describeRealmConformance(harness: RealmConformanceHarness): void {
  describe(`realm protocol conformance: ${harness.label}`, () => {
    it('completes the ready handshake and reaches Active on activate()', async () => {
      const realm = harness.create();
      await readyAndActive(realm);
      expect(realm.lifecycle.state).toBe('active');
      realm.discard();
      await realm.dispose();
    });

    it('crashes instead of becoming ready when the expected artifact digest disagrees', async () => {
      const realm = harness.create({
        expectedArtifactDigest: 'digest-expected',
        advertisedArtifactDigest: 'digest-actual',
      });
      const outcome = await realm.waitUntilReady();
      expect(outcome.ok).toBe(false);
      expect(realm.lifecycle.state).toBe('crashed');
      realm.discard();
      await realm.dispose();
    });

    it('a matching artifact digest reaches Ready', async () => {
      const realm = harness.create({
        expectedArtifactDigest: 'digest-shared',
        advertisedArtifactDigest: 'digest-shared',
      });
      const outcome = await realm.waitUntilReady();
      expect(outcome.ok).toBe(true);
      realm.discard();
      await realm.dispose();
    });

    it('dispatches a turn and resolves it once the realm delivers a matching result', async () => {
      const realm = harness.create();
      const activation = await readyAndActive(realm);
      const envelope = { ...activation, turnId: 1 };

      const pending = realm.dispatchTurn(envelope, { hello: 'world' });
      realm.deliverResult(envelope, { echoed: true });

      await expect(pending).resolves.toEqual({ echoed: true });
      realm.discard();
      await realm.dispose();
    });

    it('rejects a turn dispatched with a wrong envelope field before the realm ever sees it, leaving no pending turn', async () => {
      const realm = harness.create();
      const activation = await readyAndActive(realm);

      await expect(
        realm.dispatchTurn({ ...activation, workflowRevision: 'wrong-revision', turnId: 1 }, {}),
      ).rejects.toThrow();
      expect(realm.pendingTurnCount).toBe(0);
      realm.discard();
      await realm.dispose();
    });

    it('rejects a turn dispatched with the wrong next turnId', async () => {
      const realm = harness.create();
      const activation = await readyAndActive(realm);

      await expect(realm.dispatchTurn({ ...activation, turnId: 2 }, {})).rejects.toThrow();
      expect(realm.pendingTurnCount).toBe(0);
      realm.discard();
      await realm.dispose();
    });

    it('a result carrying a mismatched envelope does not settle the real, still-pending turn', async () => {
      const realm = harness.create();
      const activation = await readyAndActive(realm);
      const envelope = { ...activation, turnId: 1 };

      const pending = realm.dispatchTurn(envelope, {});
      // A stale/misrouted message for the same turnId but a different
      // executionToken -- the exact "a slow realm's answer to a turn the
      // host already gave up on" case every adapter's own module doc names.
      realm.deliverResult({ ...envelope, executionToken: 'a-different-execution' }, 'too-late');

      expect(realm.pendingTurnCount).toBe(1);
      realm.deliverResult(envelope, 'the-real-result');
      await expect(pending).resolves.toBe('the-real-result');
      realm.discard();
      await realm.dispose();
    });

    it('crash settles every pending turn with a rejection and ends in Crashed', async () => {
      const realm = harness.create();
      const activation = await readyAndActive(realm);

      const first = realm.dispatchTurn({ ...activation, turnId: 1 }, {});
      const second = realm.dispatchTurn({ ...activation, turnId: 2 }, {});
      expect(realm.pendingTurnCount).toBe(2);

      realm.crash();

      expect(realm.lifecycle.state).toBe('crashed');
      expect(realm.pendingTurnCount).toBe(0);
      await expect(first).rejects.toThrow();
      await expect(second).rejects.toThrow();
      await realm.dispose();
    });

    it('terminate settles a turn still pending and ends in Terminated; a late result afterward cannot resurrect it', async () => {
      const realm = harness.create();
      const activation = await readyAndActive(realm);
      const envelope = { ...activation, turnId: 1 };

      const pending = realm.dispatchTurn(envelope, {});
      realm.beginDrain();
      realm.terminate();

      expect(realm.lifecycle.state).toBe('terminated');
      await expect(pending).rejects.toThrow();

      // "A drained realm terminates and cannot emit an accepted late
      // result" -- delivering one now must be a silent no-op, never a
      // resurrection of the already-rejected turn or a thrown exception.
      expect(() => realm.deliverResult(envelope, 'too-late')).not.toThrow();
      realm.discard();
      await realm.dispose();
    });

    it('discard() ends an idle, never-activated Ready realm in Crashed (no Terminated exit exists from Ready)', async () => {
      const realm = harness.create();
      await realm.waitUntilReady();
      expect(realm.lifecycle.state).toBe('ready');

      realm.discard();
      expect(realm.lifecycle.state).toBe('crashed');
      await realm.dispose();
    });

    it('restart() is refused once nothing references this realm, without throwing', async () => {
      const realm = harness.create({ isReferenced: () => false });
      await readyAndActive(realm);
      realm.crash();

      expect(realm.restart()).toEqual({ ok: false, reason: 'unreferenced' });
      expect(realm.lifecycle.state).toBe('crashed');
      await realm.dispose();
    });

    it('restart() is bounded by maxRestarts and yields a fresh realmGeneration on each successful restart', async () => {
      const realm = harness.create({ maxRestarts: 1 });
      const first = await readyAndActive(realm);
      realm.crash();

      expect(realm.restart()).toEqual({ ok: true });
      const second = await realm.waitUntilReady();
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('unreachable');
      expect(second.realmGeneration).not.toBe(first.realmGeneration);
      realm.activate({ ...first, realmGeneration: second.realmGeneration });
      realm.crash();

      // The restart budget (1) is now exhausted.
      expect(realm.restart()).toEqual({ ok: false, reason: 'restart-budget-exceeded' });
      realm.discard();
      await realm.dispose();
    });
  });
}
