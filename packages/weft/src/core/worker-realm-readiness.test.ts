import { describe, expect, it } from 'bun:test';

import { buildInternalRealmManifest } from '../worker/manifest/internal-realm.ts';
import { WORKER_PROTOCOL_VERSION } from './worker-protocol.ts';
import {
  validateRealmReadyMessage,
  type RealmReadyValidationDependencies,
} from './worker-realm-readiness.ts';

function readyMessage(
  workflowTypes: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'ready',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    realmGeneration: 'generation-1',
    manifest: buildInternalRealmManifest(workflowTypes),
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<RealmReadyValidationDependencies> = {},
): RealmReadyValidationDependencies {
  return {
    getExpectedWorkflowTypes: () => ['order-workflow'],
    maxProtocolMessageBytes: undefined,
    ...overrides,
  };
}

describe('validateRealmReadyMessage', () => {
  describe('the existing (opt-out) generic Worker path', () => {
    it('accepts a matching manifest when no expected artifact digest is configured', async () => {
      const message = readyMessage(['order-workflow']);
      const outcome = await validateRealmReadyMessage(message, dependencies());
      expect(outcome.ok).toBe(true);
    });

    it('accepts a matching manifest whose deployment.artifactDigest differs from another realm entirely, since no digest is expected', async () => {
      // Two realms advertising different workflow-type sets have different
      // artifactDigests (buildInternalRealmManifest derives it from the
      // sorted type list) but the same per-type contract for the type the
      // host actually expects. With no getExpectedArtifactDigest configured,
      // this must still be accepted -- this is the default path's existing
      // behavior, unchanged by the COR-117 opt-in check.
      const message = readyMessage(['order-workflow', 'extra-workflow']);
      const outcome = await validateRealmReadyMessage(message, dependencies());
      expect(outcome.ok).toBe(true);
    });

    it('still rejects a missing workflow type', async () => {
      const message = readyMessage(['some-other-workflow']);
      const outcome = await validateRealmReadyMessage(message, dependencies());
      expect(outcome).toMatchObject({ ok: false, failureCategory: 'system' });
    });

    it('still rejects a protocol version mismatch', async () => {
      const message = readyMessage(['order-workflow'], { protocolVersion: 999 });
      const outcome = await validateRealmReadyMessage(message, dependencies());
      expect(outcome).toMatchObject({ ok: false, failureCategory: 'system' });
    });
  });

  describe('the COR-117 opt-in artifact digest check', () => {
    it('accepts a realm whose artifactDigest matches the expected one', async () => {
      const manifest = buildInternalRealmManifest(['order-workflow']);
      const message = readyMessage(['order-workflow']);
      const outcome = await validateRealmReadyMessage(
        message,
        dependencies({ getExpectedArtifactDigest: () => manifest.deployment.artifactDigest }),
      );
      expect(outcome.ok).toBe(true);
    });

    it('rejects a realm with matching per-type contracts but a different artifactDigest', async () => {
      // Same workflow type, same contract -- but a different overall build,
      // simulated here by expecting a digest the manifest cannot produce.
      const message = readyMessage(['order-workflow']);
      const outcome = await validateRealmReadyMessage(
        message,
        dependencies({ getExpectedArtifactDigest: () => 'sha256:not-the-real-digest' }),
      );
      expect(outcome).toMatchObject({ ok: false, failureCategory: 'system' });
      expect(!outcome.ok && outcome.error).toContain('artifact digest');
    });

    it('never enters Ready (never returns ok:true) on an artifact digest mismatch even though workflow types match', async () => {
      const message = readyMessage(['order-workflow']);
      const outcome = await validateRealmReadyMessage(
        message,
        dependencies({ getExpectedArtifactDigest: () => 'sha256:wrong' }),
      );
      expect(outcome.ok).toBe(false);
    });
  });
});
