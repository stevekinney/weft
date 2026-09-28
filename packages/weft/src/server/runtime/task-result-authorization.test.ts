/**
 * Direct unit coverage of the single "does this `taskResult` submission
 * belong to the operation's current attempt" decision shared by the
 * WebSocket and long-poll transports (COR-233).
 *
 * COR-237 residual: before this file, `authorizeTaskResultForCurrentAttempt`
 * collapsed two genuinely different situations into one `'no-current-attempt'`
 * reason — "no ledger record has ever existed for this operation" (unknown)
 * and "a record exists but is not the current attempt" (stale, e.g. still
 * `queued`) — so nothing downstream could tell them apart. These tests pin
 * both `CurrentAttemptLookup`-building functions (`currentAttemptFromLedgerRecord`,
 * used identically by both transports; `currentAttemptFromInFlightTask`, used
 * by WebSocket's fast/heartbeat paths) and the shared decision function
 * itself, so a future change that re-collapses the vocabulary — or a
 * transport that stops going through this shared seam — fails here.
 */

import { describe, expect, it } from 'bun:test';

import type {
  RemoteTaskCancelling,
  RemoteTaskDeadLettered,
  RemoteTaskLeased,
  RemoteTaskQueued,
  RemoteTaskTerminal,
} from '../../core/task-ledger/task-ledger.ts';
import type { InFlightTask } from '../../worker/registry.ts';
import {
  authorizeTaskResultForCurrentAttempt,
  currentAttemptFromInFlightTask,
  currentAttemptFromLedgerRecord,
} from './task-result-authorization.ts';

function leasedRecord(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: now + 30_000,
    firstQueuedAt: now,
    lastQueuedAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function queuedRecord(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 2,
    state: 'queued',
    attempt: 2,
    availableAt: now,
    firstQueuedAt: now,
    lastQueuedAt: now,
    retryCount: 1,
    requeueCount: 1,
    ...overrides,
  };
}

function cancellingRecord(overrides: Partial<RemoteTaskCancelling> = {}): RemoteTaskCancelling {
  const now = Date.now();
  return {
    ...leasedRecord(),
    state: 'cancelling',
    cancellationReason: 'workflow cancelled',
    cancellationRequestedAt: now,
    cancellationDeadline: now + 5_000,
    ...overrides,
  };
}

function terminalBaseFields() {
  const now = Date.now();
  return {
    recordVersion: 1 as const,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 3,
    state: 'terminal' as const,
    attempt: 1,
    resultDigest: 'digest',
    terminalAt: now,
    adopted: false,
    retentionGeneration: 0,
  };
}

function terminalResolvedRecord(overrides: Partial<RemoteTaskTerminal> = {}): RemoteTaskTerminal {
  return {
    ...terminalBaseFields(),
    disposition: 'resolved',
    attemptToken: 'attempt-token',
    status: 'completed',
    ...overrides,
  } as RemoteTaskTerminal;
}

/** A `terminal` record cancelled directly from `Queued` — the one case where a resolved record carries no `attemptToken` at all. */
function terminalCancelledFromQueuedRecord(): RemoteTaskTerminal {
  return {
    ...terminalBaseFields(),
    disposition: 'cancelled',
    cancellationReason: 'cancelled before any attempt',
    // No `attemptToken`: cancelled directly from `Queued`, no attempt ever existed.
  };
}

function deadLetteredRecord(
  overrides: Partial<RemoteTaskDeadLettered> = {},
): RemoteTaskDeadLettered {
  const now = Date.now();
  return {
    ...leasedRecord(),
    state: 'deadLettered',
    pendingStatus: 'completed',
    pendingResultDigest: 'digest',
    deadLetteredAt: now,
    persistenceFailureReason: 'simulated failure',
    ...overrides,
  };
}

function inFlightTask(overrides: Partial<InFlightTask> = {}): InFlightTask {
  return {
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    input: null,
    headers: {},
    queue: 'default',
    workerId: 'worker-1',
    attemptToken: 'attempt-token',
    visibilityTimeout: 30_000,
    deadline: Date.now() + 30_000,
    attempt: 1,
    ...overrides,
  } as InFlightTask;
}

describe('currentAttemptFromLedgerRecord — unknown vs. stale (COR-237)', () => {
  it('classifies a null record (never dispatched) as unknown, not stale', () => {
    expect(currentAttemptFromLedgerRecord(null)).toBe('unknown');
  });

  it('classifies a queued record (record exists, no current attempt) as stale, not unknown', () => {
    expect(currentAttemptFromLedgerRecord(queuedRecord())).toBe('stale');
  });

  it('classifies a terminal record cancelled directly from queued (no attemptToken) as stale', () => {
    expect(currentAttemptFromLedgerRecord(terminalCancelledFromQueuedRecord())).toBe('stale');
  });

  it('classifies a leased record as a live current attempt, never unknown or stale', () => {
    const record = leasedRecord({ workerSessionId: 'worker-9', attemptToken: 'tok-9' });
    expect(currentAttemptFromLedgerRecord(record)).toEqual({
      workerSessionId: 'worker-9',
      attemptToken: 'tok-9',
    });
  });

  it('classifies a cancelling record as a live current attempt (not stale) — the worker still holds the lease', () => {
    const record = cancellingRecord({ workerSessionId: 'worker-9', attemptToken: 'tok-9' });
    expect(currentAttemptFromLedgerRecord(record)).toEqual({
      workerSessionId: 'worker-9',
      attemptToken: 'tok-9',
    });
  });

  it('classifies a resolved terminal record by attempt token alone (session identity already dropped)', () => {
    const record = terminalResolvedRecord({ attemptToken: 'tok-9' });
    expect(currentAttemptFromLedgerRecord(record)).toEqual({ attemptToken: 'tok-9' });
  });

  it('classifies a dead-lettered record by attempt token alone', () => {
    const record = deadLetteredRecord({ attemptToken: 'tok-9' });
    expect(currentAttemptFromLedgerRecord(record)).toEqual({ attemptToken: 'tok-9' });
  });
});

describe('currentAttemptFromInFlightTask', () => {
  it('classifies an untracked operation as stale — the ephemeral registry has no ledger to prove genuine non-existence', () => {
    expect(currentAttemptFromInFlightTask(undefined)).toBe('stale');
  });

  it('classifies a tracked in-flight task as a live current attempt', () => {
    const task = inFlightTask({ workerId: 'worker-9', attemptToken: 'tok-9' });
    expect(currentAttemptFromInFlightTask(task)).toEqual({
      workerSessionId: 'worker-9',
      attemptToken: 'tok-9',
    });
  });
});

describe('authorizeTaskResultForCurrentAttempt — machine-distinguishable reason vocabulary (COR-237)', () => {
  it("rejects 'unknown' as 'unknown-operation'", () => {
    expect(authorizeTaskResultForCurrentAttempt('unknown', 'worker-1', 'tok')).toEqual({
      ok: false,
      reason: 'unknown-operation',
    });
  });

  it("rejects 'stale' as 'stale-attempt' — a genuinely distinct reason from 'unknown-operation'", () => {
    const result = authorizeTaskResultForCurrentAttempt('stale', 'worker-1', 'tok');
    expect(result).toEqual({ ok: false, reason: 'stale-attempt' });
    expect(result).not.toEqual(authorizeTaskResultForCurrentAttempt('unknown', 'worker-1', 'tok'));
  });

  it("rejects a workerId mismatch against a live attempt as 'worker-mismatch', before comparing the attempt token", () => {
    const current = { workerSessionId: 'worker-1', attemptToken: 'tok-current' };
    expect(authorizeTaskResultForCurrentAttempt(current, 'worker-2', 'tok-current')).toEqual({
      ok: false,
      reason: 'worker-mismatch',
    });
    // Even a matching token from the wrong worker is worker-mismatch, not attempt-token-mismatch.
    expect(authorizeTaskResultForCurrentAttempt(current, undefined, 'tok-current')).toEqual({
      ok: false,
      reason: 'worker-mismatch',
    });
  });

  it("rejects a wrong attempt token against the right worker as 'attempt-token-mismatch'", () => {
    const current = { workerSessionId: 'worker-1', attemptToken: 'tok-current' };
    expect(authorizeTaskResultForCurrentAttempt(current, 'worker-1', 'tok-stale')).toEqual({
      ok: false,
      reason: 'attempt-token-mismatch',
    });
  });

  it('rejects a wrong attempt token against a resolved record (no workerSessionId) as attempt-token-mismatch', () => {
    const current = { attemptToken: 'tok-current' };
    expect(authorizeTaskResultForCurrentAttempt(current, 'anyone', 'tok-stale')).toEqual({
      ok: false,
      reason: 'attempt-token-mismatch',
    });
  });

  it('authorizes a matching live attempt', () => {
    const current = { workerSessionId: 'worker-1', attemptToken: 'tok-current' };
    expect(authorizeTaskResultForCurrentAttempt(current, 'worker-1', 'tok-current')).toEqual({
      ok: true,
    });
  });

  it('authorizes a matching resumed/resolved attempt with no live session to check', () => {
    const current = { attemptToken: 'tok-current' };
    expect(authorizeTaskResultForCurrentAttempt(current, 'anyone', 'tok-current')).toEqual({
      ok: true,
    });
  });

  it('every rejection reason in the vocabulary is pairwise distinct', () => {
    const reasons = [
      authorizeTaskResultForCurrentAttempt('unknown', 'w', 't'),
      authorizeTaskResultForCurrentAttempt('stale', 'w', 't'),
      authorizeTaskResultForCurrentAttempt(
        { workerSessionId: 'other', attemptToken: 't' },
        'w',
        't',
      ),
      authorizeTaskResultForCurrentAttempt(
        { workerSessionId: 'w', attemptToken: 'other-token' },
        'w',
        't',
      ),
    ].map((result) => (result.ok ? null : result.reason));
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe('end-to-end: an unknown operation and a stale attempt are distinguishable through the exact seam both transports call', () => {
  it("a taskResult for an operation the ledger has never seen classifies as 'unknown-operation'", () => {
    const authorization = authorizeTaskResultForCurrentAttempt(
      currentAttemptFromLedgerRecord(null),
      'worker-1',
      'any-token',
    );
    expect(authorization).toEqual({ ok: false, reason: 'unknown-operation' });
  });

  it("a taskResult for an operation whose ledger record has moved back to queued classifies as 'stale-attempt'", () => {
    const authorization = authorizeTaskResultForCurrentAttempt(
      currentAttemptFromLedgerRecord(queuedRecord({ operationId: 'op-requeued' })),
      'worker-1',
      'stale-token',
    );
    expect(authorization).toEqual({ ok: false, reason: 'stale-attempt' });
  });
});
