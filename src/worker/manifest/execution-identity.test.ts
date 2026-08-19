import { describe, expect, it } from 'bun:test';

import { buildWorkerExecutionIdentity, executionIdentitySatisfies } from './execution-identity.ts';
import { singleWorkflowManifest } from './fixtures.test-support.ts';
import type { WorkerExecutionIdentity } from './types.ts';

const source = {
  manifest: singleWorkflowManifest(),
  manifestDigest: 'sha256:deadbeef',
  workerId: 'worker-1',
  workflowType: 'checkout',
  activityName: 'charge',
} as const;

const identity: WorkerExecutionIdentity = {
  workerId: 'worker-1',
  manifestDigest: 'sha256:deadbeef',
  protocolVersion: 2,
  sdkVersion: '0.18.0',
  runtimeName: 'bun',
  runtimeVersion: '1.3.14',
  deploymentName: 'billing',
  buildId: 'b3',
  artifactDigest: 'sha256:41d0',
  workflowType: 'checkout',
  workflowRevision: 'rev-8',
  activityName: 'charge',
  activityContractHash: 'sha256:bb',
};

describe('buildWorkerExecutionIdentity', () => {
  it('derives every field from the accepted manifest and session', () => {
    expect(buildWorkerExecutionIdentity(source)).toEqual(identity);
  });

  it('returns undefined when the manifest does not advertise the workflow', () => {
    expect(
      buildWorkerExecutionIdentity({ ...source, workflowType: 'not-advertised' }),
    ).toBeUndefined();
  });

  it('returns undefined when the workflow does not advertise the activity', () => {
    expect(
      buildWorkerExecutionIdentity({ ...source, activityName: 'not-advertised' }),
    ).toBeUndefined();
  });

  it('distinguishes two workflows that share revision, activity name, and contract hash', () => {
    const sharedActivity = { contractHash: 'sha256:bb', implementationRevision: 'r1' };
    const manifest = singleWorkflowManifest({
      workflows: {
        welcome: {
          workflowVersion: '1.0.0',
          workflowRevision: 'rev-8',
          contractHash: 'sha256:aa',
          activities: { send: sharedActivity },
        },
        farewell: {
          workflowVersion: '1.0.0',
          workflowRevision: 'rev-8',
          contractHash: 'sha256:aa',
          activities: { send: sharedActivity },
        },
      },
    });

    const welcome = buildWorkerExecutionIdentity({
      ...source,
      manifest,
      workflowType: 'welcome',
      activityName: 'send',
    });
    const farewell = buildWorkerExecutionIdentity({
      ...source,
      manifest,
      workflowType: 'farewell',
      activityName: 'send',
    });

    expect(welcome).not.toEqual(farewell);
    expect(welcome?.workflowType).toBe('welcome');
    expect(farewell?.workflowType).toBe('farewell');
  });
});

describe('executionIdentitySatisfies', () => {
  it('accepts an empty requirement, which pins nothing', () => {
    expect(executionIdentitySatisfies({}, identity)).toBe(true);
  });

  it('accepts a requirement whose every pinned field matches', () => {
    expect(
      executionIdentitySatisfies(
        {
          deploymentName: 'billing',
          buildId: 'b3',
          artifactDigest: 'sha256:41d0',
          workflowRevision: 'rev-8',
          activityContractHash: 'sha256:bb',
        },
        identity,
      ),
    ).toBe(true);
  });

  it.each([
    ['deploymentName', { deploymentName: 'other' }],
    ['buildId', { buildId: 'b4' }],
    ['artifactDigest', { artifactDigest: 'sha256:other' }],
    ['workflowRevision', { workflowRevision: 'rev-9' }],
    ['activityContractHash', { activityContractHash: 'sha256:other' }],
  ])('rejects a mismatched %s', (_field, requirement) => {
    expect(executionIdentitySatisfies(requirement, identity)).toBe(false);
  });

  it('treats an omitted field as "policy may choose", not as a demand for an empty string', () => {
    const emptyDeployment: WorkerExecutionIdentity = { ...identity, deploymentName: '' };

    expect(executionIdentitySatisfies({}, emptyDeployment)).toBe(true);
    expect(executionIdentitySatisfies({ deploymentName: '' }, identity)).toBe(false);
  });
});
