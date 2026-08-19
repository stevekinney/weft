import { describe, expect, it } from 'bun:test';

import { emptyManifest, singleWorkflowManifest } from './fixtures.test-support.ts';
import { canonicalWorkerManifestJson, normalizeWorkerManifest } from './normalize.ts';
import type { WorkerManifest } from './types.ts';

describe('normalizeWorkerManifest', () => {
  it('sorts capability keys', () => {
    const normalized = normalizeWorkerManifest(
      emptyManifest({ capabilities: { zeta: 1, alpha: 2, mid: 3 } }),
    );

    expect(Object.keys(normalized.capabilities)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('sorts workflow and activity keys', () => {
    const normalized = normalizeWorkerManifest(
      emptyManifest({
        workflows: {
          zulu: {
            workflowVersion: '1.0.0',
            workflowRevision: 'r',
            contractHash: 'h',
            activities: {
              second: { contractHash: 'b', implementationRevision: 'r2' },
              first: { contractHash: 'a', implementationRevision: 'r1' },
            },
          },
          alpha: {
            workflowVersion: '1.0.0',
            workflowRevision: 'r',
            contractHash: 'h',
            activities: {},
          },
        },
      }),
    );

    expect(Object.keys(normalized.workflows)).toEqual(['alpha', 'zulu']);
    expect(Object.keys(normalized.workflows['zulu']!.activities)).toEqual(['first', 'second']);
  });

  it('preserves a workflow literally named __proto__ as an ordinary entry', () => {
    const normalized = normalizeWorkerManifest(
      emptyManifest({
        workflows: {
          ['__proto__']: {
            workflowVersion: '1.0.0',
            workflowRevision: 'r',
            contractHash: 'h',
            activities: {},
          },
        },
      }),
    );

    expect(Object.keys(normalized.workflows)).toEqual(['__proto__']);
    expect(normalized.workflows['__proto__']?.contractHash).toBe('h');
  });

  it('does not mutate its input', () => {
    const source = emptyManifest({ capabilities: { zeta: 1, alpha: 2 } });
    normalizeWorkerManifest(source);

    expect(Object.keys(source.capabilities)).toEqual(['zeta', 'alpha']);
  });

  it('copies every declared field through unchanged', () => {
    const normalized = normalizeWorkerManifest(singleWorkflowManifest());

    expect(normalized).toEqual(
      expect.objectContaining({
        manifestVersion: 1,
        protocolVersion: 2,
        sdkVersion: '0.18.0',
        runtime: { name: 'bun', version: '1.3.14' },
        deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
      }),
    );
    expect(normalized.workflows['checkout']?.activities['charge']).toEqual({
      contractHash: 'sha256:bb',
      implementationRevision: 'r1',
    });
  });
});

describe('canonicalWorkerManifestJson', () => {
  it('is identical for manifests differing only in key insertion order', () => {
    const left = canonicalWorkerManifestJson(emptyManifest({ capabilities: { a: 1, b: 2 } }));
    const right = canonicalWorkerManifestJson(emptyManifest({ capabilities: { b: 2, a: 1 } }));

    expect(left).toBe(right);
  });

  it('is identical for workflow and activity keys in either order', () => {
    const activities = {
      charge: { contractHash: 'sha256:bb', implementationRevision: 'r1' },
      refund: { contractHash: 'sha256:cc', implementationRevision: 'r2' },
    };
    const workflow = { workflowVersion: '1.0.0', workflowRevision: 'rev-8', contractHash: 'h' };

    const left = canonicalWorkerManifestJson(
      emptyManifest({ workflows: { checkout: { ...workflow, activities } } }),
    );
    const right = canonicalWorkerManifestJson(
      emptyManifest({
        workflows: {
          checkout: {
            ...workflow,
            activities: { refund: activities.refund, charge: activities.charge },
          },
        },
      }),
    );

    expect(left).toBe(right);
  });

  it('differs when any content field differs', () => {
    const base = canonicalWorkerManifestJson(emptyManifest());
    const changed = canonicalWorkerManifestJson(
      emptyManifest({
        deployment: { name: 'billing', buildId: 'b4', artifactDigest: 'sha256:41d0' },
      }),
    );

    expect(base).not.toBe(changed);
  });

  it('emits parseable JSON that round-trips to the same content', () => {
    const manifest = singleWorkflowManifest({ capabilities: { gpu: true, slots: 4 } });
    const canonical = canonicalWorkerManifestJson(manifest);

    expect(JSON.parse(canonical)).toEqual(JSON.parse(JSON.stringify(manifest)));
  });

  it('sorts keys inside nested capability objects and preserves array order', () => {
    const canonical = canonicalWorkerManifestJson(
      emptyManifest({ capabilities: { nested: { z: 1, a: [3, 1, 2] } } }),
    );

    expect(canonical).toContain('"nested":{"a":[3,1,2],"z":1}');
  });

  it('serializes null, boolean, number, and string capability values', () => {
    const canonical = canonicalWorkerManifestJson(
      emptyManifest({
        capabilities: { nothing: null, yes: true, count: 4, label: 'gpu' },
      }),
    );

    expect(canonical).toContain('"count":4');
    expect(canonical).toContain('"label":"gpu"');
    expect(canonical).toContain('"nothing":null');
    expect(canonical).toContain('"yes":true');
  });

  it('escapes keys that contain quotes', () => {
    const canonical = canonicalWorkerManifestJson(
      emptyManifest({ capabilities: { ['odd"key']: 1 } }),
    );

    expect(JSON.parse(canonical).capabilities['odd"key']).toBe(1);
  });

  it('serializes a manifest whose workflow has no activities', () => {
    const manifest: WorkerManifest = emptyManifest({
      workflows: {
        empty: {
          workflowVersion: '1.0.0',
          workflowRevision: 'r',
          contractHash: 'h',
          activities: {},
        },
      },
    });

    expect(canonicalWorkerManifestJson(manifest)).toContain('"activities":{}');
  });
});
