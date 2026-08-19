import { describe, expect, it } from 'bun:test';

import type { WorkerAdmissionPolicy, WorkerAdmissionRequest } from './worker-admission-policy.ts';

function request(overrides: Partial<WorkerAdmissionRequest> = {}): WorkerAdmissionRequest {
  return {
    principal: undefined,
    workerId: 'worker-1',
    queue: 'default',
    manifest: {
      manifestVersion: 1,
      protocolVersion: 3,
      sdkVersion: '0.18.0',
      runtime: { name: 'bun', version: '1.3.14' },
      deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
      workflows: {},
      capabilities: {},
    },
    ...overrides,
  };
}

describe('WorkerAdmissionPolicy', () => {
  it('can accept a request based on the manifest', () => {
    const onlyBilling: WorkerAdmissionPolicy = ({ manifest }) =>
      manifest.deployment.name === 'billing'
        ? { status: 'accepted' }
        : { status: 'rejected', reason: 'only the billing deployment may register' };

    expect(onlyBilling(request())).toEqual({ status: 'accepted' });
  });

  it('can reject a request with a reason', () => {
    const onlyBilling: WorkerAdmissionPolicy = ({ manifest }) =>
      manifest.deployment.name === 'billing'
        ? { status: 'accepted' }
        : { status: 'rejected', reason: 'only the billing deployment may register' };

    const shipping = request({
      manifest: {
        ...request().manifest,
        deployment: { name: 'shipping', buildId: 'b1', artifactDigest: 'sha256:aa' },
      },
    });

    expect(onlyBilling(shipping)).toEqual({
      status: 'rejected',
      reason: 'only the billing deployment may register',
    });
  });
});
