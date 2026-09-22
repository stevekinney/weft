/**
 * COR-1283: `commitUncertainCancellation` — forces a settlement for a
 * `cancelling` attempt whose worker never cooperatively resolved before the
 * cancellation deadline. Never previously unit-tested directly.
 */
import { describe, expect, it } from 'bun:test';

import type { WorkerExecutionIdentity } from '../../worker/manifest/types.ts';
import { commitUncertainCancellation } from './task-ledger-transitions-cancellation.ts';
import type { RemoteTaskCancelling, RemoteTaskLeased } from './task-ledger-types.ts';

const EXECUTION_IDENTITY: WorkerExecutionIdentity = {
  workerId: 'worker-1',
  manifestDigest: 'sha256:abc',
  protocolVersion: 6,
  sdkVersion: '0.18.0',
  runtimeName: 'bun',
  runtimeVersion: '1.3.14',
  deploymentName: 'billing',
  buildId: 'build-1',
  artifactDigest: 'sha256:def',
  workflowType: 'checkout',
  workflowRevision: 'sha256:111',
  activityName: 'charge',
  activityContractHash: 'sha256:222',
};

function baseFields() {
  return {
    recordVersion: 1 as const,
    operationId: 'op-1',
    workflowType: 'checkout',
    workflowExecutionToken: 'token-1',
    activityName: 'charge',
    queue: 'default',
    input: { amount: 100 },
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
  };
}

function leasedFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  return {
    ...baseFields(),
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-1',
    workerSessionId: 'session-1',
    executionIdentity: EXECUTION_IDENTITY,
    attempt: 1,
    leaseDeadline: 31_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
    startedAt: 2_000,
    lastHeartbeatAt: 2_000,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function cancellingFixture(overrides: Partial<RemoteTaskCancelling> = {}): RemoteTaskCancelling {
  const { state: _state, ...leased } = leasedFixture();
  return {
    ...leased,
    generation: 2,
    state: 'cancelling',
    cancellationReason: 'user requested',
    cancellationRequestedAt: 3_000,
    cancellationDeadline: 33_000,
    ...overrides,
  };
}

describe('commitUncertainCancellation', () => {
  it('rejects when the record is null', () => {
    const result = commitUncertainCancellation(null, { attemptToken: 'attempt-1' }, 40_000);
    expect(result).toEqual({ ok: false, reason: 'expected task state "cancelling"' });
  });

  it('rejects when the record is not in the "cancelling" state', () => {
    const result = commitUncertainCancellation(
      leasedFixture(),
      { attemptToken: 'attempt-1' },
      40_000,
    );
    expect(result).toEqual({ ok: false, reason: 'expected task state "cancelling"' });
  });

  it('rejects on an attempt token mismatch', () => {
    const result = commitUncertainCancellation(
      cancellingFixture(),
      { attemptToken: 'stale-token' },
      40_000,
    );
    expect(result).toEqual({ ok: false, reason: 'attempt token mismatch' });
  });

  it('rejects when the cancellation deadline has not yet elapsed', () => {
    const result = commitUncertainCancellation(
      cancellingFixture(),
      { attemptToken: 'attempt-1' },
      10_000,
    );
    expect(result).toEqual({ ok: false, reason: 'cancellation deadline has not yet elapsed' });
  });

  it('force-settles as an uncertain terminal cancellation once the deadline has elapsed', () => {
    const result = commitUncertainCancellation(
      cancellingFixture(),
      { attemptToken: 'attempt-1' },
      40_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the forced settlement to succeed');
    expect(result.nextRecord.state).toBe('terminal');
    expect(result.nextRecord.disposition).toBe('cancelled');
    expect(result.nextRecord.uncertain).toBe(true);
    expect(result.nextRecord.terminalAt).toBe(40_000);
    expect(result.nextRecord.generation).toBe(3);
  });
});
