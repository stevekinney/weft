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
} from '../task-ledger.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { reassignOrExpireTask } from './task-reconciliation.ts';

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
