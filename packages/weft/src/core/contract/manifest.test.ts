import { describe, expect, it } from 'bun:test';

import { buildWorkflowContract } from './build.ts';
import { buildWorkflowRevisionManifest } from './manifest.ts';
import { WORKFLOW_REVISION_MANIFEST_VERSION } from './types.ts';

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

describe('buildWorkflowRevisionManifest', () => {
  it('sets manifestVersion, name, workflowVersion, contractHash, and the normalized contract', async () => {
    const contract = buildWorkflowContract({ name: 'checkout', version: '2.1.0' });
    const manifest = await buildWorkflowRevisionManifest(contract);

    expect(manifest.manifestVersion).toBe(WORKFLOW_REVISION_MANIFEST_VERSION);
    expect(manifest.name).toBe('checkout');
    expect(manifest.workflowVersion).toBe('2.1.0');
    expect(manifest.contractHash).toMatch(HASH_PATTERN);
    expect(manifest.contract.name).toBe('checkout');
  });

  it('derives a stable, deterministic revision when none is supplied', async () => {
    const contract = buildWorkflowContract({ name: 'checkout', version: '2.1.0' });
    const [first, second] = await Promise.all([
      buildWorkflowRevisionManifest(contract),
      buildWorkflowRevisionManifest(contract),
    ]);
    expect(first.revision).toBe(second.revision);
    expect(first.revision).toMatch(HASH_PATTERN);
  });

  it('accepts and preserves an explicitly supplied revision', async () => {
    const contract = buildWorkflowContract({ name: 'checkout', version: '2.1.0' });
    const manifest = await buildWorkflowRevisionManifest(contract, {
      revision: 'deploy-2026.09.01',
    });
    expect(manifest.revision).toBe('deploy-2026.09.01');
  });

  it('rejects an empty supplied revision', async () => {
    const contract = buildWorkflowContract({ name: 'checkout' });
    await expect(buildWorkflowRevisionManifest(contract, { revision: '' })).rejects.toThrow(
      /must not be an empty string/,
    );
  });

  it('rejects an oversized supplied revision', async () => {
    const contract = buildWorkflowContract({ name: 'checkout' });
    await expect(
      buildWorkflowRevisionManifest(contract, { revision: 'x'.repeat(600) }),
    ).rejects.toThrow(/exceeding the maximum identifier size/);
  });

  it('revision changes when description changes, even though contractHash does not', async () => {
    const withoutDescription = buildWorkflowContract({ name: 'checkout', version: '1.0.0' });
    const withDescription = buildWorkflowContract({
      name: 'checkout',
      version: '1.0.0',
      description: 'now documented',
    });
    const [left, right] = await Promise.all([
      buildWorkflowRevisionManifest(withoutDescription),
      buildWorkflowRevisionManifest(withDescription),
    ]);
    expect(left.contractHash).toBe(right.contractHash);
    expect(left.revision).not.toBe(right.revision);
  });
});
