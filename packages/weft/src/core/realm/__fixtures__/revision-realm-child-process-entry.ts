/**
 * Real child-process bootstrap fixture for revision-realm tests (COR-246).
 *
 * The `Bun.spawn` IPC counterpart of `revision-realm-worker-entry.ts`:
 * imports the workflow-implementation fixture the same way a production
 * child-process realm's bootstrap would import real workflow code — this is
 * the "realm side" half of the module-graph boundary test
 * (`revision-realm-module-boundary.test.ts`), which asserts a bundle of THIS
 * file contains `WORKFLOW_IMPLEMENTATION_SENTINEL` while a bundle of the
 * host-side pool/registry/`ChildProcessRealm` modules does not.
 *
 * Waits for the `realm-configure` message {@link
 * import('../child-process-realm.ts').ChildProcessRealm} always sends
 * immediately after spawning, over `process.on('message')` (Bun's IPC —
 * Node's `child_process.fork()` API, which this same script speaks since it
 * is itself spawned as another `bun` instance), before sending its own
 * `ready` handshake via `process.send` — mirrors the Worker fixture's
 * `self.onmessage`/`self.postMessage` exactly, just over a different
 * channel. `artifactDigest` lets one physical script stand in for several
 * distinct revisions in tests; a real deployment instead gives each
 * revision its own built bootstrap module and derives its digest from that
 * build.
 *
 * Turns do not auto-complete: `realm-run` records the pending turn and
 * waits for an explicit `test-release`/`test-fail` control message, so
 * tests can prove two turns are genuinely concurrent (both in flight, one
 * released before the other) rather than merely fast.
 */

import { buildInternalRealmManifest } from '../../../worker/manifest/internal-realm.ts';
import type {
  RealmFailureMessage,
  RealmResultMessage,
  RealmRunMessage,
} from '../worker-realm-messages.ts';
import { runFixtureWorkflow } from './workflow-implementation.fixture.ts';

const EXPECTED_WORKFLOW_TYPES = ['order-workflow'];
const DEFAULT_ARTIFACT_DIGEST = 'fixture-default-digest';

const realmGeneration = crypto.randomUUID();
const pendingRuns = new Map<number, RealmRunMessage>();

interface ConfigureMessage {
  readonly type: 'realm-configure';
  readonly artifactDigest?: string;
}

interface TestReleaseMessage {
  readonly type: 'test-release';
  readonly turnId: number;
}

interface TestFailMessage {
  readonly type: 'test-fail';
  readonly turnId: number;
  readonly error: string;
}

function sendReady(artifactDigest: string): void {
  const manifest = buildInternalRealmManifest(EXPECTED_WORKFLOW_TYPES);
  process.send?.({
    type: 'ready',
    protocolVersion: manifest.protocolVersion,
    realmGeneration,
    manifest: {
      ...manifest,
      deployment: { ...manifest.deployment, buildId: artifactDigest, artifactDigest },
    },
  });
}

process.on(
  'message',
  (message: RealmRunMessage | ConfigureMessage | TestReleaseMessage | TestFailMessage) => {
    if (message.type === 'realm-configure') {
      sendReady(message.artifactDigest ?? DEFAULT_ARTIFACT_DIGEST);
      return;
    }

    if (message.type === 'realm-run') {
      pendingRuns.set(message.envelope.turnId, message);
      return;
    }

    if (message.type === 'test-release') {
      const run = pendingRuns.get(message.turnId);
      if (!run) return;
      pendingRuns.delete(message.turnId);
      const result: RealmResultMessage = {
        type: 'realm-result',
        envelope: run.envelope,
        result: runFixtureWorkflow(run.input),
      };
      process.send?.(result);
      return;
    }

    if (message.type === 'test-fail') {
      const run = pendingRuns.get(message.turnId);
      if (!run) return;
      pendingRuns.delete(message.turnId);
      const failure: RealmFailureMessage = {
        type: 'realm-failure',
        envelope: run.envelope,
        error: message.error,
      };
      process.send?.(failure);
    }
  },
);

// A child process outlives its host by default -- exit as soon as the
// parent's IPC channel goes away (the host discarded/terminated this realm,
// or the host process itself is gone) rather than becoming an orphan.
process.on('disconnect', () => {
  process.exit(0);
});
