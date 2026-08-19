import { describe, expect, it } from 'bun:test';

import { DeploymentConsistencyGuard } from './deployment-consistency.ts';

describe('DeploymentConsistencyGuard', () => {
  it('accepts the first digest seen for a deployment/build pair', () => {
    const guard = new DeploymentConsistencyGuard();
    expect(guard.checkAndRecord('billing', 'b3', 'sha256:aa')).toEqual({ ok: true });
  });

  it('accepts a repeated registration with the same digest', () => {
    const guard = new DeploymentConsistencyGuard();
    guard.checkAndRecord('billing', 'b3', 'sha256:aa');

    expect(guard.checkAndRecord('billing', 'b3', 'sha256:aa')).toEqual({ ok: true });
  });

  it('rejects a different digest for the same deployment/build pair', () => {
    const guard = new DeploymentConsistencyGuard();
    guard.checkAndRecord('billing', 'b3', 'sha256:aa');

    expect(guard.checkAndRecord('billing', 'b3', 'sha256:bb')).toEqual({
      ok: false,
      existingArtifactDigest: 'sha256:aa',
    });
  });

  it('does not evict the recorded digest when the only worker for it disconnects', () => {
    // The guard has no disconnect hook to simulate — this test documents the
    // invariant by construction: nothing in checkAndRecord depends on any
    // notion of "still connected", so a build identity recorded once stays
    // recorded for the process lifetime regardless of connection churn.
    const guard = new DeploymentConsistencyGuard();
    guard.checkAndRecord('billing', 'b3', 'sha256:aa');

    // A "redeploy" reusing the same build ID with different bytes still
    // conflicts, proving the record survived past the first worker's tenure.
    expect(guard.checkAndRecord('billing', 'b3', 'sha256:bb')).toEqual({
      ok: false,
      existingArtifactDigest: 'sha256:aa',
    });
  });

  it('does not misclassify different builds of the same deployment as conflicting', () => {
    const guard = new DeploymentConsistencyGuard();
    guard.checkAndRecord('billing', 'b3', 'sha256:aa');

    expect(guard.checkAndRecord('billing', 'b4', 'sha256:bb')).toEqual({ ok: true });
  });

  it('does not misclassify the same build id across different deployments as conflicting', () => {
    const guard = new DeploymentConsistencyGuard();
    guard.checkAndRecord('billing', 'b3', 'sha256:aa');

    expect(guard.checkAndRecord('shipping', 'b3', 'sha256:bb')).toEqual({ ok: true });
  });

  it('does not let a deployment name and build id boundary collide via key concatenation', () => {
    // Without a separator, ("billing", "b3") and ("billingb", "3") would both
    // key to "billingb3" and be treated as the same identity.
    const guard = new DeploymentConsistencyGuard();
    guard.checkAndRecord('billing', 'b3', 'sha256:aa');

    expect(guard.checkAndRecord('billingb', '3', 'sha256:bb')).toEqual({ ok: true });
  });

  it('does not collide when a component contains a would-be separator character', () => {
    // deploymentName/buildId are validated only as non-empty, byte-bounded
    // strings with no character-set restriction, so a string-concatenation
    // key joined by any fixed separator character could be defeated by a
    // component that itself contains that character: ("a\u{1f}b", "c") and
    // ("a", "b\u{1f}c") would both join to "a\u{1f}b\u{1f}c". Nested maps
    // compare each component independently and cannot collide this way.
    const guard = new DeploymentConsistencyGuard();
    guard.checkAndRecord('a\u{1f}b', 'c', 'sha256:aa');

    expect(guard.checkAndRecord('a', 'b\u{1f}c', 'sha256:bb')).toEqual({ ok: true });
  });

  describe('check', () => {
    it('does not record — a repeated check with a different digest still succeeds', () => {
      const guard = new DeploymentConsistencyGuard();

      expect(guard.check('billing', 'b3', 'sha256:aa')).toEqual({ ok: true });
      // If check() had recorded, this would conflict; it must not.
      expect(guard.check('billing', 'b3', 'sha256:bb')).toEqual({ ok: true });
    });

    it('reports a conflict against a digest recorded separately', () => {
      const guard = new DeploymentConsistencyGuard();
      guard.record('billing', 'b3', 'sha256:aa');

      expect(guard.check('billing', 'b3', 'sha256:bb')).toEqual({
        ok: false,
        existingArtifactDigest: 'sha256:aa',
      });
    });
  });

  describe('record', () => {
    it('is idempotent for a repeated identical digest', () => {
      const guard = new DeploymentConsistencyGuard();
      guard.record('billing', 'b3', 'sha256:aa');
      guard.record('billing', 'b3', 'sha256:aa');

      expect(guard.check('billing', 'b3', 'sha256:aa')).toEqual({ ok: true });
    });

    it('keeps the first-recorded digest as the digest of record, even if record() is called again with a different value', () => {
      // record() intentionally never overwrites — callers are expected to
      // have already confirmed via check() that the value they are
      // recording does not conflict, so a second call with a different
      // digest here would only happen if a caller skipped that check.
      const guard = new DeploymentConsistencyGuard();
      guard.record('billing', 'b3', 'sha256:aa');
      guard.record('billing', 'b3', 'sha256:bb');

      expect(guard.check('billing', 'b3', 'sha256:aa')).toEqual({ ok: true });
      expect(guard.check('billing', 'b3', 'sha256:bb')).toEqual({
        ok: false,
        existingArtifactDigest: 'sha256:aa',
      });
    });
  });
});
