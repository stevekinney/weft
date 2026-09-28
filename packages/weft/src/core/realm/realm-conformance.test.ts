/**
 * Runs the shared realm-protocol conformance suite
 * (`realm-conformance.test-support.ts`) against all three realm kinds this
 * package builds: the deterministic fake realm (COR-117), the real Worker
 * adapter (COR-249), and the real child-process adapter (COR-246). See that
 * module's own doc for what this proves and what is deliberately out of
 * scope.
 *
 * Every wrapper below uses each adapter's own `receiveRealmMessageForTesting`/
 * `acceptResult` test seam to deliver an incoming result directly, rather
 * than round-tripping through a real fixture's own echo behavior — this is
 * what lets the shared suite assert on an arbitrary literal result value and
 * a deliberately mismatched envelope identically across all three, without
 * depending on what any one fixture script happens to compute.
 *
 * @module core/realm/realm-conformance.test
 */

import { ChildProcessRealm } from './child-process-realm.ts';
import { FakeRealm } from './fake-realm.test-support.ts';
import type {
  ConformanceRealm,
  RealmConformanceCreateOptions,
} from './realm-conformance.test-support.ts';
import { describeRealmConformance } from './realm-conformance.test-support.ts';
import type { RealmLifecycleState } from './realm-lifecycle.ts';
import type { RealmTurnEnvelope } from './realm-protocol.ts';
import { WorkerRealm } from './worker-realm.ts';

const EXPECTED_WORKFLOW_TYPES = ['order-workflow'];
const TERMINAL_STATES: readonly RealmLifecycleState[] = ['terminated', 'crashed'];

function fakeRealmConformance(options: RealmConformanceCreateOptions = {}): ConformanceRealm {
  const fake = new FakeRealm({
    expectedWorkflowTypes: EXPECTED_WORKFLOW_TYPES,
    isReferenced: options.isReferenced ?? (() => true),
    maxRestarts: options.maxRestarts ?? 3,
    ...(options.expectedArtifactDigest === undefined
      ? {}
      : { expectedArtifactDigest: options.expectedArtifactDigest }),
  });

  return {
    lifecycle: fake.lifecycle,
    get pendingTurnCount() {
      return fake.pendingTurnCount;
    },
    async waitUntilReady() {
      const message = fake.buildReadyMessage(crypto.randomUUID()) as {
        manifest: { deployment: Record<string, unknown> };
      };
      if (options.advertisedArtifactDigest !== undefined) {
        message.manifest = {
          ...message.manifest,
          deployment: {
            ...message.manifest.deployment,
            artifactDigest: options.advertisedArtifactDigest,
            buildId: options.advertisedArtifactDigest,
          },
        };
      }
      return fake.sendReady(message);
    },
    activate: (activation) => fake.activate(activation),
    dispatchTurn: (envelope) => fake.dispatchTurn(envelope),
    deliverResult: (envelope: RealmTurnEnvelope, result: unknown) => {
      try {
        fake.acceptResult(envelope, result);
      } catch {
        // A mismatched envelope throws from `FakeRealm.acceptResult` --
        // every real adapter instead silently drops it. Normalizing to the
        // real adapters' behavior is exactly what this wrapper is for.
      }
    },
    beginDrain: () => fake.beginDrain(),
    terminate: () => fake.terminate(),
    crash: () => fake.crash(),
    restart: () => fake.restart(),
    // `FakeRealm` has no `discard()` -- unlike the real adapters, its own
    // `crash()` is not idempotent (it throws from an already-terminal
    // state). This wrapper's `discard` normalizes to the real adapters'
    // "no-op once terminal" contract the same way `deliverResult`'s
    // try/catch normalizes the mismatch behavior above.
    discard: () => {
      if (!TERMINAL_STATES.includes(fake.lifecycle.state)) fake.crash();
    },
    dispose: async () => {
      // Purely in-process and synchronous -- nothing to await.
    },
  };
}

const workerUrl = new URL('./__fixtures__/revision-realm-worker-entry.ts', import.meta.url);

function workerRealmConformance(options: RealmConformanceCreateOptions = {}): ConformanceRealm {
  const realm = new WorkerRealm({
    workerUrl,
    expectedWorkflowTypes: EXPECTED_WORKFLOW_TYPES,
    isReferenced: options.isReferenced ?? (() => true),
    maxRestarts: options.maxRestarts ?? 3,
    ...(options.expectedArtifactDigest === undefined
      ? {}
      : { expectedArtifactDigest: options.expectedArtifactDigest }),
    ...(options.advertisedArtifactDigest === undefined
      ? {}
      : { workerName: options.advertisedArtifactDigest }),
    ...(options.realmReadyTimeoutMs === undefined
      ? {}
      : { realmReadyTimeoutMs: options.realmReadyTimeoutMs }),
  });

  return {
    lifecycle: realm.lifecycle,
    get pendingTurnCount() {
      return realm.pendingTurnCount;
    },
    waitUntilReady: () => realm.waitUntilReady(),
    activate: (activation) => realm.activate(activation),
    dispatchTurn: (envelope, input) => realm.dispatchTurn(envelope, input),
    deliverResult: (envelope: RealmTurnEnvelope, result: unknown) => {
      void realm.receiveRealmMessageForTesting({ type: 'realm-result', envelope, result });
    },
    beginDrain: () => realm.beginDrain(),
    terminate: () => realm.terminate(),
    crash: () => realm.crash(),
    restart: () => realm.restart(),
    discard: () => realm.discard(),
    dispose: () => realm.whenReclaimed(),
  };
}

const childProcessScriptPath = new URL(
  './__fixtures__/revision-realm-child-process-entry.ts',
  import.meta.url,
);

function childProcessRealmConformance(
  options: RealmConformanceCreateOptions = {},
): ConformanceRealm {
  const realm = new ChildProcessRealm({
    scriptPath: childProcessScriptPath,
    expectedWorkflowTypes: EXPECTED_WORKFLOW_TYPES,
    isReferenced: options.isReferenced ?? (() => true),
    maxRestarts: options.maxRestarts ?? 3,
    ...(options.expectedArtifactDigest === undefined
      ? {}
      : { expectedArtifactDigest: options.expectedArtifactDigest }),
    ...(options.advertisedArtifactDigest === undefined
      ? {}
      : { workerName: options.advertisedArtifactDigest }),
    ...(options.realmReadyTimeoutMs === undefined
      ? {}
      : { realmReadyTimeoutMs: options.realmReadyTimeoutMs }),
  });

  return {
    lifecycle: realm.lifecycle,
    get pendingTurnCount() {
      return realm.pendingTurnCount;
    },
    waitUntilReady: () => realm.waitUntilReady(),
    activate: (activation) => realm.activate(activation),
    dispatchTurn: (envelope, input) => realm.dispatchTurn(envelope, input),
    deliverResult: (envelope: RealmTurnEnvelope, result: unknown) => {
      void realm.receiveRealmMessageForTesting({ type: 'realm-result', envelope, result });
    },
    beginDrain: () => realm.beginDrain(),
    terminate: () => realm.terminate(),
    crash: () => realm.crash(),
    restart: () => realm.restart(),
    discard: () => realm.discard(),
    dispose: async () => {
      await realm.whenReclaimed();
    },
  };
}

describeRealmConformance({ label: 'FakeRealm', create: fakeRealmConformance });
describeRealmConformance({ label: 'WorkerRealm', create: workerRealmConformance });
describeRealmConformance({ label: 'ChildProcessRealm', create: childProcessRealmConformance });
