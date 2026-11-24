import { describe, expect, it } from 'bun:test';

import { encode } from '../core/codec/index.ts';
import { decodeVersion } from './deployment-records.ts';
import type { WorkerManifest } from './manifest/types.ts';

function manifest(overrides: Partial<WorkerManifest['deployment']> = {}): WorkerManifest {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: {
      name: 'billing',
      buildId: 'build-a',
      artifactDigest: 'sha256:build-a',
      ...overrides,
    },
    workflows: {},
    capabilities: {},
  };
}

function record(overrides: Record<string, unknown> = {}, deployment = {}) {
  return {
    deploymentName: 'billing',
    buildId: 'build-a',
    artifactDigest: 'sha256:build-a',
    manifestDigest: 'sha256:manifest-a',
    firstSeenAt: 1,
    state: 'ready',
    manifest: manifest(deployment),
    ...overrides,
  };
}

describe('decodeVersion', () => {
  it('reads a stored version and drops the retired execution counter', () => {
    const decoded = decodeVersion(encode({ ...record(), executionReferences: 7 }));

    expect(decoded).toMatchObject({
      deploymentName: 'billing',
      buildId: 'build-a',
      state: 'ready',
    });
    expect(decoded).not.toHaveProperty('executionReferences');
  });

  it('rejects a record with a missing or mistyped field', () => {
    expect(() => decodeVersion(encode(record({ state: 'paused' })))).toThrow(
      'Invalid worker deployment version record.',
    );
    expect(() => decodeVersion(encode(record({ manifest: null })))).toThrow(
      'Invalid worker deployment version record.',
    );
  });

  it.each([
    ['deployment name', { name: 'shipping' }],
    ['build id', { buildId: 'build-b' }],
    ['artifact digest', { artifactDigest: 'sha256:other' }],
  ])('rejects a record whose manifest disagrees with its key on the %s', (_label, deployment) => {
    expect(() => decodeVersion(encode(record({}, deployment)))).toThrow(
      'Worker deployment version manifest identity disagrees with its storage key.',
    );
  });
});
