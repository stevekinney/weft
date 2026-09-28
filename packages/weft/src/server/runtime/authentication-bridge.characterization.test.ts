import { describe, expect, it, spyOn } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { createServerWebSocketHandlers } from './authentication-bridge.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import {
  endWorkerReconnectGracePeriods,
  runWorkerDisconnectRequeue,
} from './worker-disconnect-requeue.ts';

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

    // The ledger commit above only marks the record `queued`; the actual
    // re-enqueue onto `context.taskQueue` (which arms a pending-task
    // expiration timer, default TTL 5 minutes) happens later, off a separate
    // `scheduleDelayedDispatch` timer (task-dispatch.ts). Wait for it to
    // land before disposing, or a dispose that races ahead of it leaves the
    // timer armed on an already-disposed queue with nothing left to clear it.
    await waitForCondition(() => context.taskQueue.isTracked('op-disconnect'), {
      label: 'worker-disconnect redispatch re-enqueued',
    });
    // `minimalServerContext()` is a bare fixture with no server shutdown path
    // to clear this timer on its own, so dispose it directly.
    context.taskQueue[Symbol.dispose]();
  });

  // `server.stop()` closes worker sockets after its timer-clearing disposer
  // has already set `stopping`. The default grace period used to arm a
  // requeue timer that outlived the server and, two seconds later, durably
  // forfeited whatever attempt the shared ledger held by then — including
  // one a restarted server had already re-leased.
  it('arms no grace-period timer when a worker socket closes during server stop', async () => {
    const context = {
      ...minimalServerContext(),
      workerReconnectGracePeriodMs: 2_000,
      stopping: true,
    };
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

    // The stopping path runs the disconnect inline and skips the durable
    // forfeit, so it is synchronous end to end: its in-memory cleanup is
    // already complete here and nothing is left scheduled.
    expect(context.pendingWorkerRequeues.size).toBe(0);
    expect(context.workerSockets.has('worker-1')).toBe(false);
    expect(context.registry.isAssigned('op-disconnect')).toBe(false);
    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey('op-disconnect'))),
    ).toEqual(leased);
  });

  it('leaves an attempt re-leased elsewhere untouched when the worker that held the earlier one disconnects', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    context.registry.assignTask('worker-1', 'op-disconnect', 30_000, undefined, 'attempt-1');
    // Another server sharing this storage already requeued attempt 1 and
    // leased attempt 2 to its own worker.
    const releasedElsewhere = leasedFixture({
      attempt: 2,
      attemptToken: 'attempt-2',
      workerSessionId: 'peer-worker',
      generation: 3,
    });
    await options.engine.storage.put(
      taskLedgerKey('op-disconnect'),
      encodeRemoteTaskRecord(releasedElsewhere),
    );

    using warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    // Resolves only once every durable requeue attempt it started has
    // settled, so the unchanged record below is final, not a race.
    await runWorkerDisconnectRequeue(context, options, 'worker-1', () => {});

    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey('op-disconnect'))),
    ).toEqual(releasedElsewhere);
    expect(warnSpy).toHaveBeenCalledWith(
      '[weft] Task "op-disconnect" was re-leased to another attempt — skipping reassignment',
    );
  });

  it('leaves every lease durable when a stopping server forfeits a disconnected worker', async () => {
    const context = { ...minimalServerContext(), stopping: true };
    const options = minimalServeOptions();
    context.registry.assignTask('worker-1', 'op-disconnect', 30_000, undefined, 'attempt-1');
    const leased = leasedFixture();
    await options.engine.storage.put(
      taskLedgerKey('op-disconnect'),
      encodeRemoteTaskRecord(leased),
    );

    // Resolves only once every durable requeue attempt it started has
    // settled, so the unchanged record below is final, not a race.
    await runWorkerDisconnectRequeue(context, options, 'worker-1', () => {});

    expect(context.registry.isAssigned('op-disconnect')).toBe(false);
    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey('op-disconnect'))),
    ).toEqual(leased);
  });

  // A worker that disconnected before the stop began is still inside its
  // grace window: its `workerSockets` entry stays until the window ends.
  // Stop used to cancel that window's timer without ending it, so
  // `shutdownAllWorkers` kept polling the already-closed socket for its
  // whole 30s default timeout.
  it('ends a pending reconnect grace window when the server stops', async () => {
    const context = { ...minimalServerContext(), workerReconnectGracePeriodMs: 2_000 };
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
    expect(context.pendingWorkerRequeues.has('worker-1')).toBe(true);
    expect(context.workerSockets.has('worker-1')).toBe(true);

    // What `server.stop()`'s timer-clearing disposer does, in order.
    context.stopping = true;
    endWorkerReconnectGracePeriods(context, options, () => {});

    expect(context.pendingWorkerRequeues.size).toBe(0);
    expect(context.workerSockets.has('worker-1')).toBe(false);
    expect(context.registry.isAssigned('op-disconnect')).toBe(false);
    expect(
      decodeRemoteTaskRecord(await options.engine.storage.get(taskLedgerKey('op-disconnect'))),
    ).toEqual(leased);
  });
});
