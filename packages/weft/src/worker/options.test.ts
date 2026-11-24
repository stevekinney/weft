import { describe, expect, it } from 'bun:test';

import { buildWorkerManifest, type RemoteWorkerOptions } from './options.ts';

const baseOptions: RemoteWorkerOptions = {
  serverUrl: 'ws://localhost:7233/v1/tasks/default/stream',
  workflows: {},
  deploymentName: 'test-deployment',
  buildId: 'test-build',
};

describe('buildWorkerManifest runtime identity', () => {
  it('reports a non-empty placeholder identity when the caller declares none, never an inspected host', () => {
    // Regression (COR-1784): the durable task ledger refuses an execution identity with an
    // empty runtime field, so the default must be a non-empty value.
    expect(buildWorkerManifest(baseOptions).runtime).toEqual({
      name: 'unknown',
      version: 'unknown',
    });
  });

  it('reports the runtime name and version the caller declares', () => {
    expect(
      buildWorkerManifest({ ...baseOptions, runtimeName: 'node', runtimeVersion: '24.1.0' })
        .runtime,
    ).toEqual({ name: 'node', version: '24.1.0' });
  });
});
