/**
 * COR-230 ("Session and Attempt Lease Model") — the wire-level split between
 * a worker-session `heartbeat` and an attempt-fenced `activityHeartbeat`,
 * driven through the real `handleWorkerWebSocketMessage` handler, PLUS
 * (acceptance criterion 5) the long-poll transport's HTTP heartbeat
 * endpoint, driven through the real `handleTaskHeartbeatRequest` handler —
 * proving both transports share the exact same `renewAttemptLease` /
 * `authorizeTaskResultForCurrentAttempt` seam rather than two
 * implementations that could drift.
 *
 * Every test here uses Bun's fake clock (`useFakeTimers`/`jest.setSystemTime`)
 * so `Date.now()` inside the ledger transitions is exactly controlled —
 * there is no reliance on real wall-clock gaps to prove ordering.
 * `task-lease.test.ts` covers the pure ledger/registry primitives this
 * exercises; this file covers the message/request handler wiring them
 * together, for both transports.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import {
  ATTEMPT_DEADLINE_MULTIPLIER,
  claimQueued,
  createQueued,
  recordCancellationIntent,
  requeueExpiredAttempt,
} from '../core/task-ledger/task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
} from '../core/task-ledger/task-ledger.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  restoreRealTimers,
  useFakeTimers,
  waitForCondition,
} from '../testing/fake-timers.test-support.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../worker/protocol.ts';
import { manifestForActivities } from '../worker/registry-fixtures.test-support.ts';
import type { WebSocketData } from './json-rpc-websocket-runtime.ts';
import {
  minimalServeOptions,
  minimalServerContext,
} from './runtime/server-context.test-support.ts';
import { handleTaskHeartbeatRequest, handleTaskResultRequest } from './runtime/task-polling.ts';
import { scanExpiredTasks } from './runtime/task-reconciliation.ts';
import { handleWorkerWebSocketMessage } from './runtime/websocket-worker.ts';

type FakeWs = {
  data: WebSocketData;
  sentMessages: string[];
  closeCode?: number;
  closeReason?: string;
  readyState: number;
  send(msg: string): void;
  close(code: number, reason: string): void;
  unsubscribe(topic: string): void;
  terminate(): void;
};

function createFakeWs(): FakeWs {
  return {
    data: { pathname: '/v1/tasks/default/stream', connectionType: 'worker', queue: 'default' },
    sentMessages: [],
    readyState: WebSocket.OPEN,
    send(msg) {
      this.sentMessages.push(msg);
    },
    close(code, reason) {
      this.closeCode = code;
      this.closeReason = reason;
    },
    unsubscribe() {},
    terminate() {},
  };
}

const NOOP_CLEANUP = (_operationId: string) => {};

function registerMessageJson(workerId: string, activities: string[]): string {
  return JSON.stringify({
    type: 'register',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId,
    manifest: manifestForActivities(activities),
    concurrency: 3,
  });
}

async function readLeasedRecord(
  storage: MemoryStorage,
  operationId: string,
): Promise<RemoteTaskLeased> {
  const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
  if (record === null || record.state !== 'leased') {
    throw new Error(
      `Expected a leased ledger record for "${operationId}", got: ${record?.state ?? 'absent'}`,
    );
  }
  return record;
}

describe('Worker-session heartbeat vs. activity heartbeat (COR-230)', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  /**
   * Registration awaits an async manifest-digest computation with no timer
   * of its own — it settles on real microtask/IO scheduling, not on
   * anything `advanceTimersByTime` can push forward. Every test therefore
   * registers under REAL timers first, and only switches to the fake clock
   * once registration has actually completed — from that point on, every
   * `Date.now()` inside the ledger transitions is exactly controlled.
   */
  async function setUp(visibilityTimeout = 10_000) {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    const ws = createFakeWs();

    handleWorkerWebSocketMessage(
      context,
      options,
      ws as never,
      registerMessageJson('w-1', ['charge']),
      NOOP_CLEANUP,
    );
    await waitForCondition(() => context.registry.getWorker('w-1') !== undefined, {
      label: 'worker registered',
    });

    // Safely in the future relative to real wall-clock "now" at test-run
    // time, so a value captured under real timers during registration (like
    // `WorkerInfo.lastHeartbeat`) never reads as "later than" a subsequent
    // fake-clock timestamp.
    useFakeTimers(2_000_000_000_000);

    context.registry.assignTask('w-1', 'op-1', visibilityTimeout, undefined, 'attempt-1');
    const claimed: RemoteTaskLeased = {
      recordVersion: 1,
      operationId: 'op-1',
      workflowType: 'test',
      activityName: 'charge',
      queue: 'default',
      input: null,
      headers: {},
      visibilityTimeoutMilliseconds: visibilityTimeout,
      createdAt: Date.now(),
      generation: 1,
      state: 'leased',
      attemptToken: 'attempt-1',
      workerSessionId: 'w-1',
      attempt: 1,
      leaseDeadline: Date.now() + visibilityTimeout,
      attemptDeadline: Date.now() + ATTEMPT_DEADLINE_MULTIPLIER * visibilityTimeout,
      firstQueuedAt: Date.now(),
      lastQueuedAt: Date.now(),
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      retryCount: 0,
      requeueCount: 0,
    };
    await storage.put(taskLedgerKey('op-1'), encodeRemoteTaskRecord(claimed));

    return { storage, options, context, ws, claimed };
  }

  it('acceptance criterion 1: a bare session heartbeat renews the registry but not the attempt lease', async () => {
    const { storage, options, context, ws, claimed } = await setUp();

    const lastHeartbeatBefore = context.registry.getWorker('w-1')?.lastHeartbeat;
    useFakeTimers(Date.now() + 2_000);

    handleWorkerWebSocketMessage(
      context,
      options,
      ws as never,
      JSON.stringify({ type: 'heartbeat', workerId: 'w-1' }),
      NOOP_CLEANUP,
    );

    expect(context.registry.getWorker('w-1')?.lastHeartbeat).toBeGreaterThan(lastHeartbeatBefore!);

    // No async work is even scheduled for a bare heartbeat — the ledger
    // record must be untouched immediately, with no need to wait for
    // anything to "not happen".
    const record = await readLeasedRecord(storage, 'op-1');
    expect(record.leaseDeadline).toBe(claimed.leaseDeadline);
    expect(record.generation).toBe(claimed.generation);
  });

  it('acceptance criterion 2: activityHeartbeat validates operationId and attemptToken, then renews the lease', async () => {
    const { storage, options, context, ws, claimed } = await setUp();

    const heartbeatSentAt = Date.now() + 2_000;
    useFakeTimers(heartbeatSentAt);
    handleWorkerWebSocketMessage(
      context,
      options,
      ws as never,
      JSON.stringify({
        type: 'activityHeartbeat',
        workerId: 'w-1',
        operationId: 'op-1',
        attemptToken: 'attempt-1',
      }),
      NOOP_CLEANUP,
    );

    await waitForCondition(
      async () => {
        const record = await readLeasedRecord(storage, 'op-1');
        return record.leaseDeadline > claimed.leaseDeadline;
      },
      { label: 'activityHeartbeat extended the lease' },
    );

    const record = await readLeasedRecord(storage, 'op-1');
    // Bounded, not exact: `waitForCondition`'s fake-timer polling loop may
    // have advanced the clock a little further while waiting for the
    // condition to flip, so the commit's own `now` can be slightly later
    // than `heartbeatSentAt` — it can never be earlier.
    expect(record.leaseDeadline).toBeGreaterThanOrEqual(
      heartbeatSentAt + record.visibilityTimeoutMilliseconds,
    );
    expect(
      ws.sentMessages.some((raw) => (JSON.parse(raw) as { type: string }).type === 'protocolError'),
    ).toBe(false);
  });

  it('acceptance criterion 3: a stale attemptToken is rejected and cannot modify the current attempt', async () => {
    const { storage, options, context, ws, claimed } = await setUp();

    handleWorkerWebSocketMessage(
      context,
      options,
      ws as never,
      JSON.stringify({
        type: 'activityHeartbeat',
        workerId: 'w-1',
        operationId: 'op-1',
        attemptToken: 'stale-attempt-token',
      }),
      NOOP_CLEANUP,
    );

    await waitForCondition(
      () =>
        ws.sentMessages.some(
          (raw) => (JSON.parse(raw) as { type: string }).type === 'protocolError',
        ),
      { label: 'stale attemptToken rejected' },
    );

    const protocolError = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; message?: string })
      .find((message) => message.type === 'protocolError');
    expect(protocolError?.message).toContain('stale attempt token');

    const record = await readLeasedRecord(storage, 'op-1');
    expect(record.leaseDeadline).toBe(claimed.leaseDeadline);
  });

  it('acceptance criterion 3: an activityHeartbeat for an operation this worker does not hold is rejected', async () => {
    const { options, context, ws } = await setUp();

    handleWorkerWebSocketMessage(
      context,
      options,
      ws as never,
      JSON.stringify({
        type: 'activityHeartbeat',
        workerId: 'w-1',
        operationId: 'op-never-assigned',
        attemptToken: 'attempt-1',
      }),
      NOOP_CLEANUP,
    );

    await waitForCondition(
      () =>
        ws.sentMessages.some(
          (raw) => (JSON.parse(raw) as { type: string }).type === 'protocolError',
        ),
      { label: 'unassigned operation rejected' },
    );
    const protocolError = ws.sentMessages
      .map((raw) => JSON.parse(raw) as { type: string; message?: string })
      .find((message) => message.type === 'protocolError');
    expect(protocolError?.message).toContain('not assigned to worker');
  });

  it('acceptance criterion 6: repeated activityHeartbeats plateau at the absolute attempt deadline', async () => {
    const { storage, options, context, ws, claimed } = await setUp(1_000);
    const attemptDeadline = claimed.attemptDeadline!;

    for (let i = 0; i < ATTEMPT_DEADLINE_MULTIPLIER + 3; i++) {
      useFakeTimers(Date.now() + 1_000);
      handleWorkerWebSocketMessage(
        context,
        options,
        ws as never,
        JSON.stringify({
          type: 'activityHeartbeat',
          workerId: 'w-1',
          operationId: 'op-1',
          attemptToken: 'attempt-1',
        }),
        NOOP_CLEANUP,
      );
      await waitForCondition(
        async () => {
          const record = await readLeasedRecord(storage, 'op-1');
          return record.generation > i + 1;
        },
        {
          label: `heartbeat ${String(i)} committed`,
        },
      );
    }

    const record = await readLeasedRecord(storage, 'op-1');
    expect(record.leaseDeadline).toBe(attemptDeadline);
  });

  it('heartbeat-versus-requeue barrier: an activityHeartbeat that commits before the reconciliation scan runs prevents reassignment', async () => {
    const { storage, options, context, ws, claimed } = await setUp(1_000);

    // Advance to just past the original lease deadline.
    useFakeTimers(claimed.leaseDeadline + 10);

    // The heartbeat commits FIRST — explicit barrier via `await
    // waitForCondition`, not a race against the scan.
    handleWorkerWebSocketMessage(
      context,
      options,
      ws as never,
      JSON.stringify({
        type: 'activityHeartbeat',
        workerId: 'w-1',
        operationId: 'op-1',
        attemptToken: 'attempt-1',
      }),
      NOOP_CLEANUP,
    );
    await waitForCondition(
      async () => {
        const record = await readLeasedRecord(storage, 'op-1');
        return record.leaseDeadline > claimed.leaseDeadline;
      },
      { label: 'heartbeat committed before the scan' },
    );
    const extended = await readLeasedRecord(storage, 'op-1');

    // Track the ORIGINAL (now stale) deadline in the heap, simulating the
    // exact scenario a heartbeat-extended-past-a-stale-heap-entry race
    // produces, and drive the scan to completion at that same instant.
    context.deadlineTracker.add({ operationId: 'op-1', deadline: claimed.leaseDeadline });
    await scanExpiredTasks(context, options, NOOP_CLEANUP, claimed.leaseDeadline);

    const afterScan = await readLeasedRecord(storage, 'op-1');
    expect(afterScan.attempt).toBe(extended.attempt);
    expect(afterScan.leaseDeadline).toBe(extended.leaseDeadline);
    expect(context.registry.isAssigned('op-1')).toBe(true);
  });

  it('heartbeat-versus-requeue barrier: with NO heartbeat, the reconciliation scan reassigns once the deadline passes', async () => {
    const { storage, options, context, claimed } = await setUp(1_000);

    useFakeTimers(claimed.leaseDeadline + 10);
    context.deadlineTracker.add({ operationId: 'op-1', deadline: claimed.leaseDeadline });
    await scanExpiredTasks(context, options, NOOP_CLEANUP, claimed.leaseDeadline + 10);

    // No retry policy was configured, so a reassignment lands back in
    // `queued` (redispatch-pending) rather than `leased` — either way, its
    // `attempt` has incremented, which is the proof a reassignment actually
    // happened.
    const afterScan = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-1')));
    expect(afterScan?.attempt).toBe(claimed.attempt + 1);
    expect(afterScan?.state).toBe('queued');
  });
});

describe('Long-poll activity heartbeat — same shared seam as WebSocket (COR-230, criterion 5)', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  function freshQueued(now: number, visibilityTimeout: number): RemoteTaskQueued {
    const created = createQueued(
      null,
      {
        recordVersion: 1,
        operationId: 'op-lp-1',
        workflowType: 'test',
        activityName: 'charge',
        queue: 'default',
        input: null,
        headers: {},
        visibilityTimeoutMilliseconds: visibilityTimeout,
        createdAt: now,
      },
      now,
    );
    if (!created.ok) throw new Error(`Expected createQueued to succeed: ${created.reason}`);
    return created.nextRecord;
  }

  async function setUpLongPoll(visibilityTimeout = 10_000) {
    useFakeTimers(2_000_000_000_000);
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext({ registry: null as never });

    const queued = freshQueued(Date.now(), visibilityTimeout);
    const claimed = claimQueued(
      queued,
      {
        expectedGeneration: queued.generation,
        attemptToken: 'lp-attempt-1',
        workerSessionId: 'longpoll-w1',
        leaseDurationMilliseconds: visibilityTimeout,
      },
      Date.now(),
    );
    if (!claimed.ok) throw new Error(`Expected claimQueued to succeed: ${claimed.reason}`);
    await storage.put(taskLedgerKey('op-lp-1'), encodeRemoteTaskRecord(claimed.nextRecord));

    return { storage, options, context, claimed: claimed.nextRecord };
  }

  function heartbeatRequest(body: Record<string, unknown>): { request: Request; url: URL } {
    const request = new Request('http://localhost/v1/tasks/default/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { request, url: new URL(request.url) };
  }

  it('acceptance criterion 2: a valid heartbeat (operationId + attemptToken) renews the lease through renewAttemptLease', async () => {
    const { storage, options, context, claimed } = await setUpLongPoll();

    useFakeTimers(Date.now() + 2_000);
    const { request, url } = heartbeatRequest({
      operationId: 'op-lp-1',
      workerId: 'longpoll-w1',
      attemptToken: 'lp-attempt-1',
    });
    const response = await handleTaskHeartbeatRequest(context, options, request, url);
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      ok: boolean;
      cancelled: boolean;
      leaseDeadline?: number;
    };
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(false);
    expect(typeof body.leaseDeadline).toBe('number');

    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-lp-1')));
    if (record?.state !== 'leased') throw new Error('Expected a leased record');
    expect(record.leaseDeadline).toBeGreaterThan(claimed.leaseDeadline);
  });

  it('acceptance criterion 3: a stale attemptToken is rejected (403) and cannot modify the current attempt', async () => {
    const { storage, options, context, claimed } = await setUpLongPoll();

    const { request, url } = heartbeatRequest({
      operationId: 'op-lp-1',
      workerId: 'longpoll-w1',
      attemptToken: 'stale-attempt-token',
    });
    const response = await handleTaskHeartbeatRequest(context, options, request, url);
    expect(response?.status).toBe(403);

    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-lp-1')));
    if (record?.state !== 'leased') throw new Error('Expected a leased record');
    expect(record.leaseDeadline).toBe(claimed.leaseDeadline);
  });

  it('acceptance criterion 4: an out-of-order heartbeat never shortens the lease (same renewAttemptLease monotonicity as WebSocket)', async () => {
    const { storage, options, context, claimed } = await setUpLongPoll();

    // A newer heartbeat commits first.
    useFakeTimers(Date.now() + 5_000);
    await handleTaskHeartbeatRequest(
      context,
      options,
      heartbeatRequest({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w1',
        attemptToken: 'lp-attempt-1',
      }).request,
      heartbeatRequest({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w1',
        attemptToken: 'lp-attempt-1',
      }).url,
    );
    const afterNewer = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-lp-1')));
    if (afterNewer?.state !== 'leased') throw new Error('Expected a leased record');

    // An OLDER (reordered) heartbeat arrives after.
    useFakeTimers(Date.now() - 3_000);
    const { request, url } = heartbeatRequest({
      operationId: 'op-lp-1',
      workerId: 'longpoll-w1',
      attemptToken: 'lp-attempt-1',
    });
    await handleTaskHeartbeatRequest(context, options, request, url);

    const afterStale = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-lp-1')));
    if (afterStale?.state !== 'leased') throw new Error('Expected a leased record');
    expect(afterStale.leaseDeadline).toBe(afterNewer.leaseDeadline);
    expect(afterStale.leaseDeadline).toBeGreaterThanOrEqual(claimed.leaseDeadline);
  });

  it('acceptance criterion 6: repeated heartbeats plateau at the absolute attempt deadline, exactly like WebSocket', async () => {
    const { storage, options, context, claimed } = await setUpLongPoll(1_000);
    const attemptDeadline = claimed.attemptDeadline!;

    for (let i = 0; i < ATTEMPT_DEADLINE_MULTIPLIER + 3; i++) {
      useFakeTimers(Date.now() + 1_000);
      const { request, url } = heartbeatRequest({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w1',
        attemptToken: 'lp-attempt-1',
      });
      await handleTaskHeartbeatRequest(context, options, request, url);
    }

    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-lp-1')));
    if (record?.state !== 'leased') throw new Error('Expected a leased record');
    expect(record.leaseDeadline).toBe(attemptDeadline);
  });

  it('acceptance criteria 5 and 11: a cancelling record answers the heartbeat with cancelled: true instead of renewing, fenced by attemptToken', async () => {
    const { storage, options, context, claimed } = await setUpLongPoll();

    const cancelling = recordCancellationIntent(
      claimed,
      {
        expectedGeneration: claimed.generation,
        expectedAttempt: claimed.attempt,
        cancellationReason: 'operator requested',
        cancellationToken: 'cancel-token-1',
        cancellationGracePeriodMilliseconds: 30_000,
      },
      Date.now(),
    );
    if (!cancelling.ok || cancelling.nextRecord.state !== 'cancelling') {
      throw new Error('Expected a cancelling record');
    }
    await storage.put(taskLedgerKey('op-lp-1'), encodeRemoteTaskRecord(cancelling.nextRecord));

    // A stale-attemptToken heartbeat is still rejected outright — the
    // cancellation signal only piggybacks onto a heartbeat that is itself
    // authorized for the CURRENT attempt (criterion 11).
    const staleResponse = await handleTaskHeartbeatRequest(
      context,
      options,
      heartbeatRequest({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w1',
        attemptToken: 'wrong-attempt-token',
      }).request,
      heartbeatRequest({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w1',
        attemptToken: 'wrong-attempt-token',
      }).url,
    );
    expect(staleResponse?.status).toBe(403);

    const { request, url } = heartbeatRequest({
      operationId: 'op-lp-1',
      workerId: 'longpoll-w1',
      attemptToken: 'lp-attempt-1',
    });
    const response = await handleTaskHeartbeatRequest(context, options, request, url);
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { ok: boolean; cancelled: boolean };
    expect(body).toEqual({ ok: true, cancelled: true });

    // Cancelling is never renewed by a heartbeat, for either transport.
    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-lp-1')));
    expect(record?.state).toBe('cancelling');
    expect(record?.state === 'cancelling' && record.leaseDeadline).toBe(
      cancelling.nextRecord.leaseDeadline,
    );
  });

  it('COR-220 criterion 3, long-poll analogue: once the lease expires and a new claim reclaims the operation, the OLD attemptToken is rejected on both /result and /heartbeat, and the NEW one succeeds', async () => {
    const { storage, options, context, claimed } = await setUpLongPoll(1_000);

    // The lease expires with no result or heartbeat from the first claim.
    useFakeTimers(claimed.leaseDeadline + 1);
    const requeued = requeueExpiredAttempt(
      claimed,
      { attemptToken: 'lp-attempt-1', requeueReason: 'visibility-timeout' },
      Date.now(),
    );
    if (!requeued.ok || requeued.nextRecord.state !== 'queued') {
      throw new Error(`Expected the expired attempt to requeue: ${JSON.stringify(requeued)}`);
    }
    await storage.put(taskLedgerKey('op-lp-1'), encodeRemoteTaskRecord(requeued.nextRecord));

    // A fresh long-poll claim reclaims the SAME operation with a rotated
    // token — the exact ledger-level effect a real second poll produces via
    // `markTaskClaimedByLongPollWorker` (proven end-to-end elsewhere); driven
    // here through the same pure `claimQueued` transition `setUpLongPoll`
    // itself used for the first claim, consistent with this file's
    // hand-built-ledger-record convention.
    const reclaimed = claimQueued(
      requeued.nextRecord,
      {
        expectedGeneration: requeued.nextRecord.generation,
        attemptToken: 'lp-attempt-2',
        workerSessionId: 'longpoll-w2',
        leaseDurationMilliseconds: 1_000,
      },
      Date.now(),
    );
    if (!reclaimed.ok) throw new Error(`Expected the reclaim to succeed: ${reclaimed.reason}`);
    await storage.put(taskLedgerKey('op-lp-1'), encodeRemoteTaskRecord(reclaimed.nextRecord));

    // The old attempt's heartbeat is rejected — same workerId is not even in
    // play here (long-poll has no persistent session), just the fenced token.
    const staleHeartbeat = await handleTaskHeartbeatRequest(
      context,
      options,
      heartbeatRequest({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w1',
        attemptToken: 'lp-attempt-1',
      }).request,
      heartbeatRequest({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w1',
        attemptToken: 'lp-attempt-1',
      }).url,
    );
    expect(staleHeartbeat?.status).toBe(403);

    // The old attempt's result is rejected too.
    const staleResult = await handleTaskResultRequest(
      context,
      options,
      new Request('http://localhost/v1/tasks/default/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: 'op-lp-1',
          workerId: 'longpoll-w1',
          attemptToken: 'lp-attempt-1',
          status: 'completed',
          value: 'stale',
        }),
      }),
      new URL('http://localhost/v1/tasks/default/result'),
    );
    expect(staleResult?.status).toBe(403);

    // The record is untouched by either stale attempt — still the reclaimed
    // attempt, unchanged.
    const afterStaleAttempts = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-lp-1')));
    if (afterStaleAttempts?.state !== 'leased') throw new Error('Expected a leased record');
    expect(afterStaleAttempts.attemptToken).toBe('lp-attempt-2');

    // The new attempt's heartbeat and result both succeed.
    const freshHeartbeat = await handleTaskHeartbeatRequest(
      context,
      options,
      heartbeatRequest({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w2',
        attemptToken: 'lp-attempt-2',
      }).request,
      heartbeatRequest({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w2',
        attemptToken: 'lp-attempt-2',
      }).url,
    );
    expect(freshHeartbeat?.status).toBe(200);

    const freshResult = await handleTaskResultRequest(
      context,
      options,
      new Request('http://localhost/v1/tasks/default/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: 'op-lp-1',
          workerId: 'longpoll-w2',
          attemptToken: 'lp-attempt-2',
          status: 'completed',
          value: 'fresh',
        }),
      }),
      new URL('http://localhost/v1/tasks/default/result'),
    );
    expect(freshResult?.status).toBe(200);
  });

  it('returns 413 when the raw heartbeat body exceeds the configured request limit', async () => {
    const { context } = await setUpLongPoll();
    const options = { ...minimalServeOptions(new MemoryStorage()), maxRequestBodyBytes: 32 };
    const request = new Request('http://localhost/v1/tasks/default/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w1',
        attemptToken: 'x'.repeat(64),
      }),
    });
    const response = await handleTaskHeartbeatRequest(
      context,
      options,
      request,
      new URL(request.url),
    );
    expect(response?.status).toBe(413);
  });

  it('returns 400 for an invalid JSON heartbeat body', async () => {
    const { options, context } = await setUpLongPoll();
    const request = new Request('http://localhost/v1/tasks/default/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    const response = await handleTaskHeartbeatRequest(
      context,
      options,
      request,
      new URL(request.url),
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: 'Invalid JSON body' });
  });

  it('returns 400 when operationId is missing from the heartbeat body', async () => {
    const { options, context } = await setUpLongPoll();
    const { request, url } = heartbeatRequest({
      workerId: 'longpoll-w1',
      attemptToken: 'lp-attempt-1',
    });
    const response = await handleTaskHeartbeatRequest(context, options, request, url);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: 'Missing required field: operationId',
    });
  });

  it('returns 400 when attemptToken is missing from the heartbeat body', async () => {
    const { options, context } = await setUpLongPoll();
    const { request, url } = heartbeatRequest({ operationId: 'op-lp-1', workerId: 'longpoll-w1' });
    const response = await handleTaskHeartbeatRequest(context, options, request, url);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: 'attemptToken must be a non-empty string',
    });
  });

  it("returns 403 when the ledger record's queue does not match the heartbeat request's queue", async () => {
    const { options, context } = await setUpLongPoll();
    const request = new Request('http://localhost/v1/tasks/other-queue/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: 'op-lp-1',
        workerId: 'longpoll-w1',
        attemptToken: 'lp-attempt-1',
      }),
    });
    const response = await handleTaskHeartbeatRequest(
      context,
      options,
      request,
      new URL(request.url),
    );
    expect(response?.status).toBe(403);
  });

  it('answers ok/not-cancelled as a harmless no-op when the attempt already resolved before the heartbeat arrived', async () => {
    const { storage, options, context, claimed } = await setUpLongPoll();

    // The attempt already resolved (terminal, disposition "resolved") by
    // the time this resent heartbeat arrives — authorization still succeeds
    // by matching attemptToken alone (terminal records drop session
    // identity), but there is nothing left to renew or answer "cancelled"
    // for.
    const resolved = {
      recordVersion: 1 as const,
      operationId: claimed.operationId,
      workflowType: claimed.workflowType,
      activityName: claimed.activityName,
      queue: claimed.queue,
      input: claimed.input,
      headers: claimed.headers,
      visibilityTimeoutMilliseconds: claimed.visibilityTimeoutMilliseconds,
      createdAt: claimed.createdAt,
      generation: claimed.generation,
      state: 'terminal' as const,
      disposition: 'resolved' as const,
      attempt: claimed.attempt,
      attemptToken: claimed.attemptToken,
      status: 'completed' as const,
      resultDigest: 'digest-1',
      terminalAt: Date.now(),
      adopted: false,
      retentionGeneration: 0,
    };
    await storage.put(taskLedgerKey('op-lp-1'), encodeRemoteTaskRecord(resolved));

    const { request, url } = heartbeatRequest({
      operationId: 'op-lp-1',
      workerId: 'longpoll-w1',
      attemptToken: 'lp-attempt-1',
    });
    const response = await handleTaskHeartbeatRequest(context, options, request, url);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, cancelled: false });
  });

  it('re-reads the current record and answers accurately when the lease renewal loses the race', async () => {
    class LosesCasStorage extends MemoryStorage {
      override async conditionalBatch(): Promise<boolean> {
        return false;
      }
    }
    const storage = new LosesCasStorage();
    const context = minimalServerContext({ registry: null as never });
    const queued = freshQueued(Date.now(), 10_000);
    const claimed = claimQueued(
      queued,
      {
        expectedGeneration: queued.generation,
        attemptToken: 'lp-attempt-1',
        workerSessionId: 'longpoll-w1',
        leaseDurationMilliseconds: 10_000,
      },
      Date.now(),
    );
    if (!claimed.ok) throw new Error(`Expected claimQueued to succeed: ${claimed.reason}`);
    await storage.put(taskLedgerKey('op-lp-1'), encodeRemoteTaskRecord(claimed.nextRecord));
    const options = minimalServeOptions(storage);

    const { request, url } = heartbeatRequest({
      operationId: 'op-lp-1',
      workerId: 'longpoll-w1',
      attemptToken: 'lp-attempt-1',
    });
    const response = await handleTaskHeartbeatRequest(context, options, request, url);

    // The renewal transition itself lost the CAS (every conditionalBatch
    // fails), but the handler still answers successfully by re-reading the
    // record fresh rather than propagating the internal transition failure
    // — and the fresh read shows the record is still leased, not cancelled.
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, cancelled: false });

    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-lp-1')));
    if (record?.state !== 'leased') throw new Error('Expected a leased record');
    expect(record.leaseDeadline).toBe(claimed.nextRecord.leaseDeadline);
  });
});
