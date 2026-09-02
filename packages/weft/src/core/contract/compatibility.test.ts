import { describe, expect, it } from 'bun:test';

import { checkVersionCompatibility } from '../versioning.ts';
import semanticallyDifferentContracts from './__fixtures__/semantically-different-contracts.json';
import { buildWorkflowContract } from './build.ts';
import type { WorkflowCompatibilityReason } from './compatibility.ts';
import {
  DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
  checkWorkflowCompatibility,
} from './compatibility.ts';
import { buildWorkflowRevisionManifest } from './manifest.ts';
import type { WorkflowContract, WorkflowRevisionManifest } from './types.ts';

/** Build a manifest from a full-source description (name, version, schemas, ...). */
async function manifestFromSource(
  source: Parameters<typeof buildWorkflowContract>[0],
): Promise<WorkflowRevisionManifest> {
  return buildWorkflowRevisionManifest(buildWorkflowContract(source));
}

/** Build a manifest directly from an already-normalized-shape contract (as the fixtures carry). */
async function manifestFromContract(contract: WorkflowContract): Promise<WorkflowRevisionManifest> {
  return buildWorkflowRevisionManifest(contract);
}

/**
 * Construct a manifest that structurally fails `manifestVersion` validation.
 * No real producer in this codebase can build one—`buildWorkflowRevisionManifest`
 * and `parseWorkflowRevisionManifest` both guarantee the literal version—so this
 * cast is the only way to reach the `manifest-version-unsupported` branch and is
 * kept local to this one test helper, matching `manifest-parse.test.ts`'s own
 * hostile-input-fixture style.
 */
function withUnsupportedManifestVersion(
  manifest: WorkflowRevisionManifest,
): WorkflowRevisionManifest {
  return { ...manifest, manifestVersion: 999 } as unknown as WorkflowRevisionManifest;
}

describe('checkWorkflowCompatibility', () => {
  it('reports identical manifests as compatible with no reasons array', async () => {
    const manifest = await manifestFromSource({ name: 'checkout', version: '2.1.0' });
    expect(checkWorkflowCompatibility(manifest, manifest)).toStrictEqual({ compatible: true });
  });

  it('reports name-mismatch (and the resulting artifact-revision-mismatch) when only name differs', async () => {
    const current = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
    const candidate = await manifestFromSource({ name: 'checkout-v2', version: '1.0.0' });

    expect(current.contractHash).toBe(candidate.contractHash);
    expect(current.revision).not.toBe(candidate.revision);

    expect(checkWorkflowCompatibility(current, candidate)).toStrictEqual({
      compatible: false,
      reasons: ['name-mismatch', 'artifact-revision-mismatch'],
    });
  });

  describe('manifest-version-unsupported', () => {
    it('fires when only the candidate carries an unsupported manifestVersion', async () => {
      const base = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
      const candidate = withUnsupportedManifestVersion(base);

      expect(checkWorkflowCompatibility(base, candidate)).toStrictEqual({
        compatible: false,
        reasons: ['manifest-version-unsupported'],
      });
    });

    it('fires when only the current side carries an unsupported manifestVersion', async () => {
      const base = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
      const current = withUnsupportedManifestVersion(base);

      expect(checkWorkflowCompatibility(current, base)).toStrictEqual({
        compatible: false,
        reasons: ['manifest-version-unsupported'],
      });
    });

    it('deduplicates to a single reason when both sides are unsupported', async () => {
      const base = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
      const current = withUnsupportedManifestVersion(base);
      const candidate = withUnsupportedManifestVersion(base);

      expect(checkWorkflowCompatibility(current, candidate)).toStrictEqual({
        compatible: false,
        reasons: ['manifest-version-unsupported'],
      });
    });
  });

  describe('contract-hash-mismatch', () => {
    for (const entry of semanticallyDifferentContracts as Array<{
      description: string;
      a: WorkflowContract;
      b: WorkflowContract;
    }>) {
      it(`${entry.description} -> contract-hash-mismatch and artifact-revision-mismatch, nothing else`, async () => {
        const current = await manifestFromContract(entry.a);
        const candidate = await manifestFromContract(entry.b);

        expect(current.name).toBe(candidate.name);
        expect(current.workflowVersion).toBe(candidate.workflowVersion);
        expect(current.contractHash).not.toBe(candidate.contractHash);

        expect(checkWorkflowCompatibility(current, candidate)).toStrictEqual({
          compatible: false,
          reasons: ['contract-hash-mismatch', 'artifact-revision-mismatch'],
        });
      });
    }
  });

  describe('workflow-version-incompatible', () => {
    it('fires exactly when checkVersionCompatibility() would say incompatible', async () => {
      const current = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
      const matchingCandidate = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
      const differingCandidate = await manifestFromSource({ name: 'checkout', version: '2.0.0' });

      expect(
        checkVersionCompatibility(matchingCandidate.workflowVersion, current.workflowVersion),
      ).toBe('compatible');
      expect(checkWorkflowCompatibility(current, matchingCandidate).compatible).toBe(true);

      expect(
        checkVersionCompatibility(differingCandidate.workflowVersion, current.workflowVersion),
      ).toBe('incompatible');
      const verdict = checkWorkflowCompatibility(current, differingCandidate);
      expect(verdict.compatible).toBe(false);
      expect((verdict as { reasons: readonly string[] }).reasons).toContain(
        'workflow-version-incompatible',
      );
    });

    it('reports workflow-version-incompatible plus artifact-revision-mismatch under the strict default policy', async () => {
      const current = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
      const candidate = await manifestFromSource({ name: 'checkout', version: '2.0.0' });

      expect(checkWorkflowCompatibility(current, candidate)).toStrictEqual({
        compatible: false,
        reasons: ['workflow-version-incompatible', 'artifact-revision-mismatch'],
      });
    });

    it('suppresses only artifact-revision-mismatch under a lenient policy, keeping workflow-version-incompatible', async () => {
      const current = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
      const candidate = await manifestFromSource({ name: 'checkout', version: '2.0.0' });

      expect(
        checkWorkflowCompatibility(current, candidate, { requireExactRevision: false }),
      ).toStrictEqual({
        compatible: false,
        reasons: ['workflow-version-incompatible'],
      });
    });
  });

  describe('artifact-revision-mismatch policy', () => {
    it('blocks a description-only change under the strict default policy', async () => {
      const current = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
      const candidate = await manifestFromSource({
        name: 'checkout',
        version: '1.0.0',
        description: 'now with a description',
      });

      expect(current.contractHash).toBe(candidate.contractHash);
      expect(current.revision).not.toBe(candidate.revision);

      expect(checkWorkflowCompatibility(current, candidate)).toStrictEqual({
        compatible: false,
        reasons: ['artifact-revision-mismatch'],
      });
    });

    it('tolerates a description-only change under a lenient policy', async () => {
      const current = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
      const candidate = await manifestFromSource({
        name: 'checkout',
        version: '1.0.0',
        description: 'now with a description',
      });

      expect(
        checkWorkflowCompatibility(current, candidate, { requireExactRevision: false }),
      ).toStrictEqual({ compatible: true });
    });

    it('falls back to the strict default when policy is an empty object', async () => {
      const current = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
      const candidate = await manifestFromSource({
        name: 'checkout',
        version: '1.0.0',
        description: 'now with a description',
      });

      expect(checkWorkflowCompatibility(current, candidate, {})).toStrictEqual({
        compatible: false,
        reasons: ['artifact-revision-mismatch'],
      });
    });

    it('never suppresses a higher-priority reason (contract-hash-mismatch) under a lenient policy', async () => {
      const current = await manifestFromContract({
        name: 'checkout',
        workflowVersion: '1.0.0',
        inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
      });
      const candidate = await manifestFromContract({
        name: 'checkout',
        workflowVersion: '1.0.0',
        description: 'now with a description',
        inputSchema: { type: 'object', properties: { amount: { type: 'string' } } },
      });

      expect(
        checkWorkflowCompatibility(current, candidate, { requireExactRevision: false }),
      ).toStrictEqual({
        compatible: false,
        reasons: ['contract-hash-mismatch'],
      });
    });
  });

  it('reports every applicable reason in the issue-defined order, never short-circuited', async () => {
    const current = await manifestFromContract({
      name: 'checkout',
      workflowVersion: '1.0.0',
      inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
    });
    const rawCandidate = await manifestFromContract({
      name: 'checkout-v2',
      workflowVersion: '2.0.0',
      inputSchema: { type: 'object', properties: { amount: { type: 'string' } } },
    });
    const candidate = withUnsupportedManifestVersion(rawCandidate);

    const expectedOrder: readonly WorkflowCompatibilityReason[] = [
      'name-mismatch',
      'manifest-version-unsupported',
      'contract-hash-mismatch',
      'workflow-version-incompatible',
      'artifact-revision-mismatch',
    ];

    expect(checkWorkflowCompatibility(current, candidate)).toStrictEqual({
      compatible: false,
      reasons: expectedOrder,
    });
  });

  it('is symmetric: checkWorkflowCompatibility(a, b, policy) equals checkWorkflowCompatibility(b, a, policy)', async () => {
    const checkout1 = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
    const checkout1WithDescription = await manifestFromSource({
      name: 'checkout',
      version: '1.0.0',
      description: 'described',
    });
    const checkout2 = await manifestFromSource({ name: 'checkout', version: '2.0.0' });
    const refund1 = await manifestFromSource({ name: 'refund', version: '1.0.0' });
    const [fixtureA, fixtureB] = await Promise.all([
      manifestFromContract(
        (semanticallyDifferentContracts as Array<{ a: WorkflowContract }>)[0]!.a,
      ),
      manifestFromContract(
        (semanticallyDifferentContracts as Array<{ b: WorkflowContract }>)[0]!.b,
      ),
    ]);

    const pairs: ReadonlyArray<readonly [WorkflowRevisionManifest, WorkflowRevisionManifest]> = [
      [checkout1, checkout1],
      [checkout1, checkout1WithDescription],
      [checkout1, checkout2],
      [checkout1, refund1],
      [fixtureA, fixtureB],
      [checkout1, withUnsupportedManifestVersion(checkout1)],
    ];

    for (const [a, b] of pairs) {
      for (const policy of [
        DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
        { requireExactRevision: false },
      ]) {
        expect(checkWorkflowCompatibility(a, b, policy)).toStrictEqual(
          checkWorkflowCompatibility(b, a, policy),
        );
      }
    }
  });

  it('uses DEFAULT_WORKFLOW_COMPATIBILITY_POLICY when no policy argument is supplied', async () => {
    const current = await manifestFromSource({ name: 'checkout', version: '1.0.0' });
    const candidate = await manifestFromSource({
      name: 'checkout',
      version: '1.0.0',
      description: 'described',
    });

    expect(checkWorkflowCompatibility(current, candidate)).toStrictEqual(
      checkWorkflowCompatibility(current, candidate, DEFAULT_WORKFLOW_COMPATIBILITY_POLICY),
    );
  });

  it('freezes DEFAULT_WORKFLOW_COMPATIBILITY_POLICY so a caller cannot mutate the shared default', () => {
    expect(Object.isFrozen(DEFAULT_WORKFLOW_COMPATIBILITY_POLICY)).toBe(true);
  });
});
