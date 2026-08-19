/**
 * Unit tests for reassignOrExpireTask's residual branches not exercised by
 * the end-to-end worker-disconnect/visibility-expiry coverage in
 * src/server/index.test.ts: a lost CAS logging its failure and returning
 * without scheduling a redispatch, and createRequeuedTaskDispatch actually
 * carrying workflowId/headers through to the redispatched TaskDispatch.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { manifestForActivities } from '../../worker/registry-fixtures.test-support.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
} from '../task-ledger.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import {
  reassignOrExpireTask,
  reconcileOrphanedRecords,
  taskDispatchFromLedgerRecord,
} from './task-reconciliation.ts';

const NOOP_CLEANUP = (): void => {};

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
