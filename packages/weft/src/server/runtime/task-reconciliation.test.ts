/**
 * Unit tests for reassignOrExpireTask's residual branches not exercised by
 * the end-to-end worker-disconnect/visibility-expiry coverage in
 * src/server/index.test.ts: a lost CAS logging its failure and returning
 * without scheduling a redispatch, and createRequeuedTaskDispatch actually
 * carrying workflowId/headers through to the redispatched TaskDispatch.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { recordCancellationIntent } from '../../core/task-ledger/task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskCancelling,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskTerminalResolved,
} from '../../core/task-ledger/task-ledger.ts';
import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  restoreRealTimers,
  useFakeTimers,
  waitForCondition,
} from '../../testing/fake-timers.test-support.ts';
import { manifestForActivities } from '../../worker/registry-fixtures.test-support.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import {
  reassignOrExpireTask,
  reconcileOrphanedRecords,
  scanExpiredTasks,
  taskDispatchFromLedgerRecord,
} from './task-reconciliation.ts';

const NOOP_CLEANUP = (): void => {};

/** Storage that loses every compare-and-swap, modeling a sustained persistence failure. */
class LosesCasStorage extends MemoryStorage {
  override async conditionalBatch(
    _conditions: ConditionalBatchCondition[],
    _operations: BatchOperation[],
  ): Promise<boolean> {
    return false;
  }
}

function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-queued',
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 0,
    state: 'queued',
    attempt: 1,
    availableAt: now,
    firstQueuedAt: now,
    lastQueuedAt: now,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

function leasedFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'test.charge',
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

function terminalFixture(
  overrides: Partial<RemoteTaskTerminalResolved> = {},
): RemoteTaskTerminalResolved {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-terminal',
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 3,
    state: 'terminal',
    disposition: 'resolved',
    attempt: 1,
    attemptToken: 'attempt-token',
    status: 'completed',
    resultDigest: 'digest-1',
    terminalAt: now,
    adopted: false,
    retentionGeneration: 0,
    ...overrides,
  };
}

/** A leased-origin cancelling record (COR-230, `Leased --> Cancelling`), built through
 * the real transition rather than hand-assembled, so it carries every field
 * `recordCancellationIntent` actually sets (cancellationDeadline included). */
function cancellingFixture(
  now: number,
  overrides: {
    operationId?: string;
    cancellationGracePeriodMilliseconds?: number;
  } = {},
): RemoteTaskCancelling {
  const leased = leasedFixture({
    operationId: overrides.operationId ?? 'op-cancelling',
    createdAt: now,
    firstQueuedAt: now,
    lastQueuedAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    leaseDeadline: now + 30_000,
  });
  const result = recordCancellationIntent(
    leased,
    {
      expectedGeneration: leased.generation,
      expectedAttempt: leased.attempt,
      cancellationReason: 'operator requested',
      cancellationToken: 'cancel-token',
      cancellationGracePeriodMilliseconds: overrides.cancellationGracePeriodMilliseconds ?? 5_000,
    },
    now,
  );
  if (!result.ok || result.nextRecord.state !== 'cancelling') {
    throw new Error('Expected recordCancellationIntent to produce a cancelling record');
  }
  return result.nextRecord;
}

describe('reassignOrExpireTask', () => {
  it('logs and returns without scheduling a redispatch when the CAS is lost', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = leasedFixture({ operationId: 'op-cas-loss' });
    await options.engine.storage.put(taskLedgerKey('op-cas-loss'), encodeRemoteTaskRecord(stored));

    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    // A stale attemptToken on the caller's record no longer matches what is
    // durably stored — requeueExpiredAttempt rejects with "attempt token
    // mismatch" and reassignOrExpireTask must log and bail out rather than
    // schedule a redispatch or dispatch an ActivityFailedEvent.
    await reassignOrExpireTask(context, options, 'op-cas-loss', {
      ...stored,
      attemptToken: 'stale-token',
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to requeue/expire task "op-cas-loss"'),
    );
    expect(context.pendingTimers.size).toBe(0);

    const persisted = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey('op-cas-loss')),
    );
    expect(persisted?.state).toBe('leased');
  });

  it('carries workflowId and headers through to the redispatched task', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const workerId = 'w-redispatch';
    context.registry.register({
      manifest: manifestForActivities(['test.charge']),
      acceptedManifestDigest: 'digest',
      id: workerId,
      queue: 'default',
      activities: ['test.charge'],
      concurrency: 5,
    });
    const sent: string[] = [];
    context.workerSockets.set(workerId, { send: (message: string) => sent.push(message) } as never);

    const stored = leasedFixture({
      operationId: 'op-redispatch-fields',
      workflowId: 'wf-redispatch',
      headers: { 'x-trace-id': 'trace-123' },
    });
    await options.engine.storage.put(
      taskLedgerKey('op-redispatch-fields'),
      encodeRemoteTaskRecord(stored),
    );

    await reassignOrExpireTask(
      context,
      options,
      'op-redispatch-fields',
      stored,
      'worker-disconnect',
    );

    await waitForCondition(() => sent.length > 0, {
      timeoutMs: 1000,
      intervalMs: 10,
      label: 'redispatched task message to be sent',
    });

    const taskMessage = JSON.parse(sent[0] ?? '{}') as {
      operationId?: string;
      headers?: Record<string, string>;
    };
    expect(taskMessage.operationId).toBe('op-redispatch-fields');
    expect(taskMessage.headers).toEqual({ 'x-trace-id': 'trace-123' });
    expect(context.workerAffinity.get('wf-redispatch')).toBe(workerId);
  });
});

describe('taskDispatchFromLedgerRecord', () => {
  it('carries priority, fairShareKey, and sticky routing intent through from the ledger record', () => {
    const record = leasedFixture({
      priority: 7,
      fairShareKey: 'tenant-a',
      workflowId: 'wf-sticky',
      stickyWorkflowId: 'wf-sticky',
    });

    const dispatch = taskDispatchFromLedgerRecord(record);

    expect(dispatch.priority).toBe(7);
    expect(dispatch.fairShareKey).toBe('tenant-a');
    expect(dispatch.sticky).toBe(true);
    expect(dispatch.workflowId).toBe('wf-sticky');
  });
});

describe('reconcileOrphanedRecords — queued redispatch', () => {
  it('redispatches an available queued record found during a full-ledger reconciliation scan', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = queuedFixture({
      operationId: 'op-orphan-queued',
      availableAt: Date.now(),
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    await waitForCondition(() => context.taskQueue.isTracked(stored.operationId), {
      timeoutMs: 1000,
      intervalMs: 10,
      label: 'orphaned queued task to reach the long-poll queue',
    });
  });

  it('skips a queued record already tracked in-memory instead of redispatching it again', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = queuedFixture({
      operationId: 'op-orphan-already-tracked',
      availableAt: Date.now(),
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );
    context.taskQueue.enqueue('default', {
      operationId: stored.operationId,
      activityName: stored.activityName,
      input: stored.input,
      attempt: stored.attempt,
    });

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    // No redispatch scheduled — scheduleDelayedDispatch always registers a
    // pendingTimers entry, so an empty set proves the early return fired.
    expect(context.pendingTimers.size).toBe(0);
  });
});

describe('reconcileOrphanedRecords — terminal retention (WFT-24)', () => {
  it('reaps an adopted terminal record once it is older than taskRetentionWindowMs', async () => {
    const context = minimalServerContext();
    const options = {
      ...minimalServeOptions(),
      taskRetentionWindowMs: 1_000,
    };
    const stored = terminalFixture({
      operationId: 'op-old-adopted',
      adopted: true,
      adoptedAt: Date.now() - 5_000,
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    expect(await options.engine.storage.get(taskLedgerKey(stored.operationId))).toBeNull();
  });

  it('leaves an unadopted terminal record alone regardless of age', async () => {
    const context = minimalServerContext();
    const options = {
      ...minimalServeOptions(),
      taskRetentionWindowMs: 1_000,
    };
    const stored = terminalFixture({
      operationId: 'op-old-unadopted',
      adopted: false,
      terminalAt: Date.now() - 5_000,
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey(stored.operationId))),
    ).not.toBeNull();
  });

  it('leaves an adopted terminal record alone when it has not aged past the retention window', async () => {
    const context = minimalServerContext();
    const options = {
      ...minimalServeOptions(),
      taskRetentionWindowMs: 60_000,
    };
    const stored = terminalFixture({
      operationId: 'op-fresh-adopted',
      adopted: true,
      adoptedAt: Date.now(),
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey(stored.operationId))),
    ).not.toBeNull();
  });

  it('never reaps when taskRetentionWindowMs is unset — retention is opt-in', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const stored = terminalFixture({
      operationId: 'op-no-retention-configured',
      adopted: true,
      adoptedAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey(stored.operationId))),
    ).not.toBeNull();
  });

  it('stops scanning once context.stopping is set, issuing no further deletes', async () => {
    const context = minimalServerContext();
    context.stopping = true;
    const options = {
      ...minimalServeOptions(),
      taskRetentionWindowMs: 1_000,
    };
    const stored = terminalFixture({
      operationId: 'op-during-shutdown',
      adopted: true,
      adoptedAt: Date.now() - 5_000,
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey(stored.operationId))),
    ).not.toBeNull();
  });

  it('logs and leaves the record in place when the retention delete loses the CAS', async () => {
    const context = minimalServerContext();
    const options = {
      ...minimalServeOptions(new LosesCasStorage()),
      taskRetentionWindowMs: 1_000,
    };
    const stored = terminalFixture({
      operationId: 'op-reap-cas-loss',
      adopted: true,
      adoptedAt: Date.now() - 5_000,
    });
    await options.engine.storage.put(
      taskLedgerKey(stored.operationId),
      encodeRemoteTaskRecord(stored),
    );

    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to reap retained terminal task "op-reap-cas-loss"'),
    );
    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey(stored.operationId))),
    ).not.toBeNull();
  });
});

describe('scanExpiredTasks — cancelling records (COR-230, criterion 15)', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('re-tracks the heap entry when a fresh read shows the cancellation deadline has not actually passed', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const now = 1_000_000;
    useFakeTimers(now);

    // The heap entry's own deadline (`now`) already expired, but the
    // durably stored record's real cancellationDeadline is later — a fresh
    // read racing ahead of a stale heap entry, per the function's own
    // comment. Re-tracking (not dropping) it is what lets the later,
    // correct deadline still fire the forced settlement on time.
    const cancelling = cancellingFixture(now, { cancellationGracePeriodMilliseconds: 10_000 });
    await options.engine.storage.put(
      taskLedgerKey(cancelling.operationId),
      encodeRemoteTaskRecord(cancelling),
    );
    context.deadlineTracker.add({ operationId: cancelling.operationId, deadline: now });

    await scanExpiredTasks(context, options, NOOP_CLEANUP, now);

    expect(context.deadlineTracker.peekDeadline()).toBe(cancelling.cancellationDeadline);
    const persisted = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(cancelling.operationId)),
    );
    expect(persisted?.state).toBe('cancelling');
  });

  it('leaves the record cancelling when the forced settlement loses the race', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions(new LosesCasStorage());
    const now = 1_000_000;
    useFakeTimers(now);

    const cancelling = cancellingFixture(now, { cancellationGracePeriodMilliseconds: 0 });
    await options.engine.storage.put(
      taskLedgerKey(cancelling.operationId),
      encodeRemoteTaskRecord(cancelling),
    );
    context.deadlineTracker.add({ operationId: cancelling.operationId, deadline: now });

    // No throw, no unhandled rejection — the lost-race branch is a silent
    // "something else already resolved this record" continue.
    await scanExpiredTasks(context, options, NOOP_CLEANUP, now);

    const persisted = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(cancelling.operationId)),
    );
    expect(persisted?.state).toBe('cancelling');
  });
});

describe('reconcileOrphanedRecords — cancelling records (COR-230, criterion 15)', () => {
  it('skips a cancelling record another in-flight path is already processing', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const now = Date.now();
    const cancelling = cancellingFixture(now, { operationId: 'op-cancel-claimed' });
    await options.engine.storage.put(
      taskLedgerKey(cancelling.operationId),
      encodeRemoteTaskRecord(cancelling),
    );
    context.processingOperations.add(cancelling.operationId);

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    // Untouched: still claimed by the other path, still cancelling.
    expect(context.processingOperations.has(cancelling.operationId)).toBe(true);
    const persisted = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(cancelling.operationId)),
    );
    expect(persisted?.state).toBe('cancelling');
  });

  it("re-tracks a cancelling record's deadline when the full-ledger sweep finds it not yet due", async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const now = Date.now();
    const cancelling = cancellingFixture(now, {
      operationId: 'op-cancel-not-due',
      cancellationGracePeriodMilliseconds: 60_000,
    });
    await options.engine.storage.put(
      taskLedgerKey(cancelling.operationId),
      encodeRemoteTaskRecord(cancelling),
    );

    await reconcileOrphanedRecords(context, options, NOOP_CLEANUP);

    expect(context.deadlineTracker.peekDeadline()).toBe(cancelling.cancellationDeadline);
    const persisted = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(cancelling.operationId)),
    );
    expect(persisted?.state).toBe('cancelling');
  });

  it('force-settles a due cancelling record found by the full-ledger sweep and cleans up', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    // Already past its (zero-grace-period) deadline by construction.
    const cancelling = cancellingFixture(Date.now() - 5_000, {
      operationId: 'op-cancel-due-sweep',
      cancellationGracePeriodMilliseconds: 0,
    });
    await options.engine.storage.put(
      taskLedgerKey(cancelling.operationId),
      encodeRemoteTaskRecord(cancelling),
    );
    const cleanedUpWorkflows: string[] = [];

    await reconcileOrphanedRecords(context, options, (workflowId) =>
      cleanedUpWorkflows.push(workflowId),
    );

    expect(context.processingOperations.has(cancelling.operationId)).toBe(false);
    // cleanupWorkflowIndex is called with the operationId here (matching
    // every other call site in this file), not workflowId.
    expect(cleanedUpWorkflows).toEqual([cancelling.operationId]);
    const persisted = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(cancelling.operationId)),
    );
    expect(persisted?.state).toBe('terminal');
    expect(persisted?.state === 'terminal' && persisted.disposition).toBe('cancelled');
    expect(
      persisted?.state === 'terminal' &&
        persisted.disposition === 'cancelled' &&
        persisted.uncertain,
    ).toBe(true);
  });
});
