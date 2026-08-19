import { describe, expect, it } from 'bun:test';

import {
  computeWorkerManifestDigest,
  digestCanonicalWorkerManifest,
  WORKER_MANIFEST_DIGEST_ALGORITHM,
} from './digest.ts';
import { emptyManifest, singleWorkflowManifest } from './fixtures.test-support.ts';
import { canonicalWorkerManifestJson } from './normalize.ts';

describe('computeWorkerManifestDigest', () => {
  it('tags the digest with its algorithm', async () => {
    const digest = await computeWorkerManifestDigest(emptyManifest());

    expect(digest.startsWith(`${WORKER_MANIFEST_DIGEST_ALGORITHM}:`)).toBe(true);
  });

  it('produces a 64-character SHA-256 hex body', async () => {
    const digest = await computeWorkerManifestDigest(emptyManifest());
    const [, hex] = digest.split(':');

    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls', async () => {
    const first = await computeWorkerManifestDigest(singleWorkflowManifest());
    const second = await computeWorkerManifestDigest(singleWorkflowManifest());

    expect(first).toBe(second);
  });

  it('ignores key insertion order', async () => {
    const left = await computeWorkerManifestDigest(emptyManifest({ capabilities: { a: 1, b: 2 } }));
    const right = await computeWorkerManifestDigest(
      emptyManifest({ capabilities: { b: 2, a: 1 } }),
    );

    expect(left).toBe(right);
  });

  it('changes when the artifact digest changes', async () => {
    const base = await computeWorkerManifestDigest(emptyManifest());
    const changed = await computeWorkerManifestDigest(
      emptyManifest({
        deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:different' },
      }),
    );

    expect(base).not.toBe(changed);
  });

  it('changes when an activity contract changes', async () => {
    const base = await computeWorkerManifestDigest(singleWorkflowManifest());
    const changed = await computeWorkerManifestDigest(
      singleWorkflowManifest({
        workflows: {
          checkout: {
            workflowVersion: '1.0.0',
            workflowRevision: 'rev-8',
            contractHash: 'sha256:aa',
            activities: {
              charge: { contractHash: 'sha256:changed', implementationRevision: 'r1' },
            },
          },
        },
      }),
    );

    expect(base).not.toBe(changed);
  });
});

describe('digestCanonicalWorkerManifest', () => {
  it('matches the digest computed from the manifest itself', async () => {
    const manifest = singleWorkflowManifest();
    const fromCanonical = await digestCanonicalWorkerManifest(
      canonicalWorkerManifestJson(manifest),
    );
    const fromManifest = await computeWorkerManifestDigest(manifest);

    expect(fromCanonical).toBe(fromManifest);
  });

  it('matches a known SHA-256 vector for the canonical bytes', async () => {
    // Pinned against an independent digest of the same string so a change to
    // the hashing path is caught even if canonical serialization also changes.
    const canonical = canonicalWorkerManifestJson(emptyManifest());
    const expected = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)),
    );
    const expectedHex = [...expected].map((byte) => byte.toString(16).padStart(2, '0')).join('');

    expect(await digestCanonicalWorkerManifest(canonical)).toBe(`sha256:${expectedHex}`);
  });

  it('zero-pads bytes below 0x10 rather than emitting a short hex body', async () => {
    // Digest many distinct inputs so at least one leading-zero byte occurs;
    // any unpadded byte would shorten the body below 64 characters.
    for (let index = 0; index < 64; index++) {
      const digest = await digestCanonicalWorkerManifest(`probe-${String(index)}`);
      expect(digest).toHaveLength('sha256:'.length + 64);
    }
  });
});
