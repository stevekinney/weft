import { describe, expect, it, spyOn } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { createServerWebSocketHandlers } from './authentication-bridge.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';

import type { RemoteTaskLeased } from '../../core/task-ledger/task-ledger-types.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
} from '../../core/task-ledger/task-ledger.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';

type FakeWorkerSocket = {
  data: WebSocketData;
};

function createWorkerSocket(workerId: string): FakeWorkerSocket {
  return {
    data: {
      connectionType: 'worker',
      pathname: '/v1/tasks/default/stream',
      queue: 'default',
      workerId,
    },
  };
}

function leasedFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  return {
    recordVersion: 1,
    operationId: 'op-disconnect',
    workflowType: 'checkout',
    workflowExecutionToken: 'token-1',
    activityName: 'charge',
    queue: 'default',
    input: { amount: 100 },
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-1',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: Date.now() + 60_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
    startedAt: 2_000,
    lastHeartbeatAt: 2_000,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

describe('createServerWebSocketHandlers', () => {
  it('ignores stale worker close events after the worker already reconnected', () => {
    const context = minimalServerContext();
    const handlers = createServerWebSocketHandlers(context, minimalServeOptions(), () => {});
    const staleSocket = createWorkerSocket('worker-1');
    const freshSocket = createWorkerSocket('worker-1');
    context.workerSockets.set('worker-1', freshSocket as never);

    using warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    handlers.close(staleSocket as never);

    expect(warnSpy).toHaveBeenCalledWith(
      '[weft] Ignoring stale socket close for worker "worker-1" — already reconnected',
    );
    expect(context.workerSockets.get('worker-1') as unknown).toBe(freshSocket);
    expect(context.pendingWorkerRequeues.size).toBe(0);
  });

  it('requeues a live, unexpired lease when its worker disconnects', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const socket = createWorkerSocket('worker-1');
    context.workerSockets.set('worker-1', socket as never);

    context.registry.assignTask('worker-1', 'op-disconnect', 30_000, undefined, 'attempt-1');
    const leased = leasedFixture();
    await options.engine.storage.put(
      taskLedgerKey('op-disconnect'),
      encodeRemoteTaskRecord(leased),
    );

    const handlers = createServerWebSocketHandlers(context, options, () => {});
    handlers.close(socket as never);

    // The reassignment runs in a fire-and-forget async task per in-flight
    // task, now several awaits deep (COR-205's attempt-record disposition
    // update reads the prior attempt's record before writing its update,
    // atomically alongside the ledger requeue) — poll for the durable
    // effect rather than hardcoding a microtask-flush count that would
    // silently under-wait again the next time this chain grows by one hop.
    await waitForCondition(
      async () => {
        const record = decodeRemoteTaskRecord(
          await options.engine.storage.get(taskLedgerKey('op-disconnect')),
        );
        return record?.state === 'queued';
      },
      { label: 'worker-disconnect requeue committed' },
    );

    const record = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey('op-disconnect')),
    );
    expect(record?.state).toBe('queued');
    if (record?.state === 'queued') {
      expect(record.attempt).toBe(2);
      expect(record.lastRequeueReason).toBe('worker-disconnect');
    }
  });
});
