/**
 * Pins the dead-letter guard in `applyTaskResult` (`task-result-submission.ts`):
 * a result whose terminal ledger commit escalated to a dead letter must not be
 * signalled to the local task queue as a delivered completion, while an
 * ordinary applied result must be. The characterization suite asserts the
 * `200`/`disposition` response and the ledger and event side effects of the
 * dead-letter path, but never observes `taskQueue.complete()` itself, so
 * removing the guard would otherwise go unnoticed.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import {
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskLeased,
} from '../../core/task-ledger/task-ledger.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { principalFromApiKey } from '../principal.ts';
import {
  FailingTerminalCommitStorage,
  minimalServeOptions,
  minimalServerContext,
} from './server-context.test-support.ts';
import { handleTaskResultRequest } from './task-result-submission.ts';

const WORKER_PRINCIPAL = principalFromApiKey({
  subject: 'worker-key',
  scopes: ['workers:write'],
});

function leasedFixture(operationId: string): RemoteTaskLeased {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId,
    workflowType: 'testWorkflow',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-token',
    workerSessionId: 'longpoll-worker',
    attempt: 1,
    leaseDeadline: now + 30_000,
    firstQueuedAt: now,
    lastQueuedAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    retryCount: 0,
    requeueCount: 0,
  };
}

async function submitCompletedResult(storage: MemoryStorage, operationId: string) {
  // `handleTaskResultRequest` never consults the worker registry, so use a null one.
  const context = minimalServerContext({ registry: null as never });
  const options = minimalServeOptions(storage);
  await storage.put(taskLedgerKey(operationId), encodeRemoteTaskRecord(leasedFixture(operationId)));
  using completeSpy = spyOn(context.taskQueue, 'complete');

  const response = await handleTaskResultRequest(
    context,
    options,
    new Request('http://localhost/v1/tasks/default/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId,
        workerId: 'longpoll-worker',
        attemptToken: 'attempt-token',
        status: 'completed',
        value: { ok: true },
      }),
    }),
    new URL('http://localhost/v1/tasks/default/result'),
    WORKER_PRINCIPAL,
  );

  return {
    status: response?.status,
    body: await response?.json(),
    completeCallCount: completeSpy.mock.calls.length,
  };
}

describe('applyTaskResult dead-letter guard', () => {
  it('does not complete the local task queue entry when the result is dead-lettered', async () => {
    const operationId = 'op-dead-letter-skips-complete';

    const outcome = await submitCompletedResult(
      new FailingTerminalCommitStorage(operationId),
      operationId,
    );

    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ ok: true, disposition: 'dead-lettered' });
    expect(outcome.completeCallCount).toBe(0);
  });

  it('completes the local task queue entry exactly once when the result is applied', async () => {
    const operationId = 'op-applied-completes-queue';

    const outcome = await submitCompletedResult(new MemoryStorage(), operationId);

    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ ok: true, disposition: 'applied' });
    expect(outcome.completeCallCount).toBe(1);
  });
});
