import { describe, expect, it } from 'bun:test';

import type { WorkerExecutionIdentity } from '../worker/manifest/types.ts';
import {
  beginCompletion,
  canClearDeadLetteredTask,
  canDeleteRetainedTerminalTask,
  claimQueued,
  commitCancellation,
  commitDeadLetter,
  commitTerminalResult,
  createQueued,
  markWorkflowResultAdopted,
  recordCancellationIntent,
  renewAttemptLease,
  requeueExpiredAttempt,
} from './task-ledger-transitions.ts';
import type {
  RemoteTaskCancelling,
  RemoteTaskCompleting,
  RemoteTaskDeadLettered,
  RemoteTaskLeased,
  RemoteTaskQueued,
  RemoteTaskTerminal,
} from './task-ledger-types.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  isRemoteTaskRecord,
} from './task-ledger.ts';

const EXECUTION_IDENTITY: WorkerExecutionIdentity = {
  workerId: 'worker-1',
  manifestDigest: 'sha256:abc',
  protocolVersion: 3,
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

function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
  return {
    ...baseFields(),
    generation: 0,
    state: 'queued',
    attempt: 1,
    availableAt: 1_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
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

function completingFixture(overrides: Partial<RemoteTaskCompleting> = {}): RemoteTaskCompleting {
  const { state: _state, ...leased } = leasedFixture();
  return {
    ...leased,
    generation: 2,
    state: 'completing',
    pendingStatus: 'completed',
    pendingResultDigest: 'digest-1',
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
    ...overrides,
  };
}

function terminalFixture(overrides: Partial<RemoteTaskTerminal> = {}): RemoteTaskTerminal {
  return {
    ...baseFields(),
    generation: 3,
    state: 'terminal',
    disposition: 'resolved',
    attempt: 1,
    attemptToken: 'attempt-1',
    status: 'completed',
    resultDigest: 'digest-1',
    terminalAt: 4_000,
    adopted: false,
    retentionGeneration: 0,
    ...overrides,
  } as RemoteTaskTerminal;
}

function deadLetteredFixture(
  overrides: Partial<RemoteTaskDeadLettered> = {},
): RemoteTaskDeadLettered {
  return {
    ...baseFields(),
    generation: 3,
    state: 'deadLettered',
    attemptToken: 'attempt-1',
    attempt: 1,
    pendingStatus: 'completed',
    pendingResultDigest: 'digest-1',
    retryCount: 0,
    requeueCount: 0,
    deadLetteredAt: 4_000,
    persistenceFailureReason: 'lost the compare-and-swap race',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Create queued
// ---------------------------------------------------------------------------

describe('createQueued', () => {
  it('creates a queued record when no current record exists', () => {
    const result = createQueued(null, { ...baseFields() }, 1_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.state).toBe('queued');
    expect(result.nextRecord.attempt).toBe(1);
    expect(result.nextRecord.generation).toBe(0);
    expect(result.nextRecord.availableAt).toBe(1_000);
    expect(result.nextRecord.retryCount).toBe(0);
    expect(result.nextRecord.requeueCount).toBe(0);
  });

  it('honors an explicit delayed availableAt', () => {
    const result = createQueued(null, { ...baseFields(), availableAt: 5_000 }, 1_000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextRecord.availableAt).toBe(5_000);
  });

  it('rejects when a current task record already exists', () => {
    const result = createQueued(queuedFixture(), { ...baseFields() }, 1_000);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Claim queued
// ---------------------------------------------------------------------------

describe('claimQueued', () => {
  const claimInput = {
    expectedGeneration: 0,
    attemptToken: 'attempt-1',
    workerSessionId: 'session-1',
    executionIdentity: EXECUTION_IDENTITY,
    leaseDurationMilliseconds: 30_000,
  };

  it('claims a due queued task and starts a lease', () => {
    const result = claimQueued(queuedFixture(), claimInput, 1_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.state).toBe('leased');
    expect(result.nextRecord.generation).toBe(1);
    expect(result.nextRecord.leaseDeadline).toBe(31_000);
    expect(result.nextRecord.startedAt).toBe(1_000);
  });

  it('preserves a prior startedAt across a reclaim after requeue', () => {
    const result = claimQueued(queuedFixture({ startedAt: 500 }), claimInput, 1_000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextRecord.startedAt).toBe(500);
  });

  it('rejects when the task is not queued', () => {
    expect(claimQueued(leasedFixture(), claimInput, 1_000).ok).toBe(false);
    expect(claimQueued(null, claimInput, 1_000).ok).toBe(false);
  });

  it('rejects a generation mismatch', () => {
    const result = claimQueued(queuedFixture(), { ...claimInput, expectedGeneration: 99 }, 1_000);
    expect(result.ok).toBe(false);
  });

  it('rejects a claim before availableAt', () => {
    const result = claimQueued(queuedFixture({ availableAt: 5_000 }), claimInput, 1_000);
    expect(result.ok).toBe(false);
  });

  it('does not leak queued-only fields (availableAt, lastDispatchedAt) onto the leased record', () => {
    const result = claimQueued(queuedFixture({ lastDispatchedAt: 900 }), claimInput, 1_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('availableAt' in result.nextRecord).toBe(false);
      expect('lastDispatchedAt' in result.nextRecord).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Renew attempt lease
// ---------------------------------------------------------------------------

describe('renewAttemptLease', () => {
  const renewInput = {
    attemptToken: 'attempt-1',
    workerSessionId: 'session-1',
    leaseDurationMilliseconds: 30_000,
  };

  it('extends the lease deadline and heartbeat on a matching attempt', () => {
    const result = renewAttemptLease(leasedFixture(), renewInput, 40_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.leaseDeadline).toBe(70_000);
    expect(result.nextRecord.lastHeartbeatAt).toBe(40_000);
    expect(result.nextRecord.generation).toBe(2);
  });

  it('rejects a stale attempt token', () => {
    const result = renewAttemptLease(
      leasedFixture(),
      { ...renewInput, attemptToken: 'stale' },
      40_000,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a worker session mismatch', () => {
    const result = renewAttemptLease(
      leasedFixture(),
      { ...renewInput, workerSessionId: 'other-session' },
      40_000,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects when the task is not leased', () => {
    expect(renewAttemptLease(queuedFixture(), renewInput, 40_000).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Begin completion
// ---------------------------------------------------------------------------

describe('beginCompletion', () => {
  const beginInput = {
    attemptToken: 'attempt-1',
    pendingStatus: 'completed' as const,
    pendingResultDigest: 'digest-1',
  };

  it('transitions a leased task into completing', () => {
    const result = beginCompletion(leasedFixture(), beginInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.state).toBe('completing');
    expect(result.nextRecord.pendingResultDigest).toBe('digest-1');
  });

  it('rejects a stale attempt token', () => {
    const result = beginCompletion(leasedFixture(), { ...beginInput, attemptToken: 'stale' });
    expect(result.ok).toBe(false);
  });

  it('rejects when the task is not leased', () => {
    expect(beginCompletion(queuedFixture(), beginInput).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Commit terminal result
// ---------------------------------------------------------------------------

describe('commitTerminalResult', () => {
  const commitInput = { attemptToken: 'attempt-1', resultDigest: 'digest-1' };

  it('commits a resolved terminal record on matching attempt and digest', () => {
    const result = commitTerminalResult(completingFixture(), commitInput, 5_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.state).toBe('terminal');
    if (result.nextRecord.state === 'terminal' && result.nextRecord.disposition === 'resolved') {
      expect(result.nextRecord.status).toBe('completed');
      expect(result.nextRecord.adopted).toBe(false);
    }
  });

  it('rejects a stale attempt token', () => {
    const result = commitTerminalResult(
      completingFixture(),
      { ...commitInput, attemptToken: 'stale' },
      5_000,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a result digest mismatch (a stale heartbeat/result loses to the winner)', () => {
    const result = commitTerminalResult(
      completingFixture(),
      { ...commitInput, resultDigest: 'wrong-digest' },
      5_000,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects when the task is not completing', () => {
    expect(commitTerminalResult(leasedFixture(), commitInput, 5_000).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Requeue expired attempt
// ---------------------------------------------------------------------------

describe('requeueExpiredAttempt', () => {
  const requeueInput = { attemptToken: 'attempt-1', requeueReason: 'visibility-timeout' };

  it('requeues with exponential backoff when attempts remain', () => {
    const leased = leasedFixture({
      leaseDeadline: 10_000,
      retryPolicy: {
        maxAttempts: 5,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
    });
    const result = requeueExpiredAttempt(leased, requeueInput, 10_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.state).toBe('queued');
    if (result.nextRecord.state === 'queued') {
      expect(result.nextRecord.attempt).toBe(2);
      // calculateBackoff is 1-indexed against (nextAttempt - 1): the delay
      // before attempt 2 is calculateBackoff(1) = initialBackoff, matching
      // reassignOrExpireTask's convention in task-reconciliation.ts.
      expect(result.nextRecord.availableAt).toBe(11_000);
      expect(result.nextRecord.requeueCount).toBe(1);
      expect(result.nextRecord.startedAt).toBe(leased.startedAt);
      expect(result.nextRecord.lastRequeueReason).toBe('visibility-timeout');
    }
  });

  it('grows the backoff exponentially on a second requeue', () => {
    const leased = leasedFixture({
      attempt: 2,
      leaseDeadline: 20_000,
      retryPolicy: {
        maxAttempts: 5,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
    });
    const result = requeueExpiredAttempt(leased, requeueInput, 20_000);
    expect(result.ok).toBe(true);
    if (result.ok && result.nextRecord.state === 'queued') {
      expect(result.nextRecord.attempt).toBe(3);
      // calculateBackoff(2) = initialBackoff * multiplier = 2s.
      expect(result.nextRecord.availableAt).toBe(22_000);
    }
  });

  it('requeues immediately when no retry policy is set', () => {
    const leased = leasedFixture({ leaseDeadline: 10_000 });
    const result = requeueExpiredAttempt(leased, requeueInput, 10_000);
    expect(result.ok).toBe(true);
    if (result.ok && result.nextRecord.state === 'queued') {
      expect(result.nextRecord.availableAt).toBe(10_000);
    }
  });

  it('exhausts to a retryExhausted terminal record when maxAttempts is reached', () => {
    const leased = leasedFixture({
      attempt: 5,
      leaseDeadline: 10_000,
      retryPolicy: {
        maxAttempts: 5,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
    });
    const result = requeueExpiredAttempt(leased, requeueInput, 10_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextRecord.state).toBe('terminal');
      if (
        result.nextRecord.state === 'terminal' &&
        result.nextRecord.disposition === 'retryExhausted'
      ) {
        expect(result.nextRecord.error).toContain('exhausted all 5 retry attempts');
      }
    }
  });

  it('rejects when the task is not leased', () => {
    expect(requeueExpiredAttempt(queuedFixture(), requeueInput, 10_000).ok).toBe(false);
    expect(requeueExpiredAttempt(null, requeueInput, 10_000).ok).toBe(false);
  });

  it('rejects a lease that has not expired', () => {
    const result = requeueExpiredAttempt(
      leasedFixture({ leaseDeadline: 99_000 }),
      requeueInput,
      10_000,
    );
    expect(result.ok).toBe(false);
  });

  it('requeues a live, unexpired lease when skipDeadlineCheck is set (worker disconnect)', () => {
    const leased = leasedFixture({ leaseDeadline: 99_000 });
    const result = requeueExpiredAttempt(
      leased,
      { ...requeueInput, requeueReason: 'worker-disconnect', skipDeadlineCheck: true },
      10_000,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.nextRecord.state === 'queued') {
      expect(result.nextRecord.lastRequeueReason).toBe('worker-disconnect');
    }
  });

  it('still enforces the attempt-token match when skipDeadlineCheck is set', () => {
    const result = requeueExpiredAttempt(
      leasedFixture({ leaseDeadline: 99_000 }),
      { ...requeueInput, attemptToken: 'stale', skipDeadlineCheck: true },
      10_000,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a stale attempt token', () => {
    const result = requeueExpiredAttempt(
      leasedFixture({ leaseDeadline: 10_000 }),
      { ...requeueInput, attemptToken: 'stale' },
      10_000,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Record cancellation intent
// ---------------------------------------------------------------------------

describe('recordCancellationIntent', () => {
  it('cancels a queued task directly to terminal, bypassing cancelling', () => {
    const result = recordCancellationIntent(
      queuedFixture(),
      { expectedGeneration: 0, expectedAttempt: 1, cancellationReason: 'user requested' },
      2_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.state).toBe('terminal');
    if (result.nextRecord.state === 'terminal' && result.nextRecord.disposition === 'cancelled') {
      expect('attemptToken' in result.nextRecord).toBe(false);
    }
  });

  it('moves a leased task to cancelling, carrying the attempt token forward', () => {
    const result = recordCancellationIntent(
      leasedFixture(),
      { expectedGeneration: 1, expectedAttempt: 1, cancellationReason: 'user requested' },
      2_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.state).toBe('cancelling');
    if (result.nextRecord.state === 'cancelling') {
      expect(result.nextRecord.attemptToken).toBe('attempt-1');
    }
  });

  it('rejects a generation mismatch', () => {
    const result = recordCancellationIntent(
      queuedFixture(),
      { expectedGeneration: 99, expectedAttempt: 1, cancellationReason: 'x' },
      2_000,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an attempt mismatch', () => {
    const result = recordCancellationIntent(
      queuedFixture(),
      { expectedGeneration: 0, expectedAttempt: 99, cancellationReason: 'x' },
      2_000,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a task that is already terminal', () => {
    const result = recordCancellationIntent(
      terminalFixture(),
      { expectedGeneration: 3, expectedAttempt: 1, cancellationReason: 'x' },
      2_000,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Commit cancellation
// ---------------------------------------------------------------------------

describe('commitCancellation', () => {
  it('commits a cancelled terminal record on a matching attempt token', () => {
    const result = commitCancellation(cancellingFixture(), { attemptToken: 'attempt-1' }, 4_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.state).toBe('terminal');
    expect(result.nextRecord.disposition).toBe('cancelled');
    expect(result.nextRecord.adopted).toBe(false);
  });

  it('rejects a stale attempt token (bounded takeover loses to the real cancel)', () => {
    const result = commitCancellation(cancellingFixture(), { attemptToken: 'stale' }, 4_000);
    expect(result.ok).toBe(false);
  });

  it('rejects when the task is not cancelling', () => {
    expect(commitCancellation(leasedFixture(), { attemptToken: 'attempt-1' }, 4_000).ok).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Mark workflow result adopted
// ---------------------------------------------------------------------------

describe('markWorkflowResultAdopted', () => {
  it('marks a terminal record adopted on a matching digest', () => {
    const result = markWorkflowResultAdopted(
      terminalFixture(),
      { expectedResultDigest: 'digest-1' },
      6_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.adopted).toBe(true);
    expect(result.nextRecord.adoptedAt).toBe(6_000);
  });

  it('matches uniformly across every terminal disposition, not just resolved', () => {
    const cancelled = terminalFixture({
      disposition: 'cancelled',
      cancellationReason: 'x',
      resultDigest: 'cancel-digest',
    });
    const result = markWorkflowResultAdopted(
      cancelled,
      { expectedResultDigest: 'cancel-digest' },
      6_000,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a digest mismatch', () => {
    const result = markWorkflowResultAdopted(
      terminalFixture(),
      { expectedResultDigest: 'wrong' },
      6_000,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a non-terminal task', () => {
    const result = markWorkflowResultAdopted(
      queuedFixture(),
      { expectedResultDigest: 'digest-1' },
      6_000,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. Delete retained terminal task
// ---------------------------------------------------------------------------

describe('canDeleteRetainedTerminalTask', () => {
  it('allows deletion of an adopted terminal record with a matching retention generation', () => {
    const adopted = terminalFixture({ adopted: true, retentionGeneration: 2 });
    expect(canDeleteRetainedTerminalTask(adopted, { expectedRetentionGeneration: 2 })).toEqual({
      ok: true,
    });
  });

  it('rejects deletion of an unadopted terminal record', () => {
    const result = canDeleteRetainedTerminalTask(terminalFixture(), {
      expectedRetentionGeneration: 0,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a retention generation mismatch (late cleanup loses safely)', () => {
    const adopted = terminalFixture({ adopted: true, retentionGeneration: 2 });
    const result = canDeleteRetainedTerminalTask(adopted, { expectedRetentionGeneration: 1 });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-terminal task', () => {
    const result = canDeleteRetainedTerminalTask(queuedFixture(), {
      expectedRetentionGeneration: 0,
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. Commit dead letter (WFT-24)
// ---------------------------------------------------------------------------

describe('commitDeadLetter', () => {
  const deadLetterInput = {
    attemptToken: 'attempt-1',
    resultDigest: 'digest-1',
    persistenceFailureReason:
      'lost the compare-and-swap race on operation "op-1" after 3 attempt(s)',
  };

  it('dead-letters a completing record on matching attempt and digest', () => {
    const result = commitDeadLetter(completingFixture(), deadLetterInput, 5_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.state).toBe('deadLettered');
    expect(result.nextRecord.pendingStatus).toBe('completed');
    expect(result.nextRecord.pendingResultDigest).toBe('digest-1');
    expect(result.nextRecord.deadLetteredAt).toBe(5_000);
    expect(result.nextRecord.persistenceFailureReason).toBe(
      deadLetterInput.persistenceFailureReason,
    );
  });

  it('carries value and error through when provided', () => {
    const result = commitDeadLetter(
      completingFixture(),
      { ...deadLetterInput, value: { total: 42 }, error: 'boom' },
      5_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRecord.value).toEqual({ total: 42 });
    expect(result.nextRecord.error).toBe('boom');
  });

  it('rejects a stale attempt token', () => {
    const result = commitDeadLetter(
      completingFixture(),
      { ...deadLetterInput, attemptToken: 'stale' },
      5_000,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a result digest mismatch — a concurrent legitimate resolution must not be clobbered', () => {
    const result = commitDeadLetter(
      completingFixture(),
      { ...deadLetterInput, resultDigest: 'wrong-digest' },
      5_000,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects when the task is not completing', () => {
    expect(commitDeadLetter(leasedFixture(), deadLetterInput, 5_000).ok).toBe(false);
  });

  it('rejects when the task was already resolved terminal in the interim', () => {
    expect(commitDeadLetter(terminalFixture(), deadLetterInput, 5_000).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. Clear dead letter (WFT-24)
// ---------------------------------------------------------------------------

describe('canClearDeadLetteredTask', () => {
  it('allows clearing a dead-lettered record', () => {
    expect(canClearDeadLetteredTask(deadLetteredFixture())).toEqual({ ok: true });
  });

  it('rejects a record that is not dead-lettered', () => {
    expect(canClearDeadLetteredTask(terminalFixture()).ok).toBe(false);
    expect(canClearDeadLetteredTask(leasedFixture()).ok).toBe(false);
    expect(canClearDeadLetteredTask(queuedFixture()).ok).toBe(false);
  });

  it('rejects when no record exists', () => {
    expect(canClearDeadLetteredTask(null).ok).toBe(false);
  });
});

describe('synthesized resultDigest round-trips through the codec', () => {
  // commitCancellation, requeueExpiredAttempt's exhaustion branch, and
  // recordCancellationIntent's queued-origin branch each synthesize
  // resultDigest by concatenating operationId and attemptToken — every
  // record produced from otherwise-valid, max-length inputs must still pass
  // decodeRemoteTaskRecord(encodeRemoteTaskRecord(...)).
  const maxLengthId = 'x'.repeat(512);

  it('round-trips a cancelled-from-leased terminal record with max-length identifiers', () => {
    const cancelling = cancellingFixture({
      operationId: maxLengthId,
      attemptToken: maxLengthId,
    });
    const result = commitCancellation(cancelling, { attemptToken: maxLengthId }, 4_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isRemoteTaskRecord(result.nextRecord)).toBe(true);
    expect(decodeRemoteTaskRecord(encodeRemoteTaskRecord(result.nextRecord))).toEqual(
      result.nextRecord,
    );
  });

  it('round-trips a cancelled-from-queued terminal record with a max-length operationId', () => {
    const queued = queuedFixture({ operationId: maxLengthId });
    const result = recordCancellationIntent(
      queued,
      { expectedGeneration: 0, expectedAttempt: 1, cancellationReason: 'user requested' },
      2_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isRemoteTaskRecord(result.nextRecord)).toBe(true);
    expect(decodeRemoteTaskRecord(encodeRemoteTaskRecord(result.nextRecord))).toEqual(
      result.nextRecord,
    );
  });

  it('round-trips a retry-exhausted terminal record with max-length identifiers', () => {
    const leased = leasedFixture({
      operationId: maxLengthId,
      attemptToken: maxLengthId,
      attempt: 5,
      leaseDeadline: 10_000,
      retryPolicy: {
        maxAttempts: 5,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
    });
    const result = requeueExpiredAttempt(
      leased,
      { attemptToken: maxLengthId, requeueReason: 'visibility-timeout' },
      10_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isRemoteTaskRecord(result.nextRecord)).toBe(true);
    expect(decodeRemoteTaskRecord(encodeRemoteTaskRecord(result.nextRecord))).toEqual(
      result.nextRecord,
    );
  });
});
