/**
 * COR-230 ("Session and Attempt Lease Model") — cancellation delivery
 * guarantees and outcomes.
 *
 * Covers acceptance criteria 9-13 and 15:
 *
 *   9.  A queued-origin cancellation commits straight to a cancelled
 *       terminal record; no worker is ever contacted.
 *   10. A leased-origin cancellation records durable intent (`Leased -->
 *       Cancelling`) BEFORE any control is sent to the worker.
 *   11. The `cancel` control (and, on the worker side — see
 *       `worker/index.test.ts`'s stale-attemptToken regression — the SDK's
 *       `AbortController` lookup) is fenced by `attemptToken`.
 *   12. Completion and cancellation have exactly one conditional terminal
 *       winner — proven here as explicit, ordered barriers (not races):
 *       whichever commits first wins, and the loser's own commit
 *       necessarily fails its precondition afterward.
 *   13. A cooperatively cancelled attempt resolves with the ledger's
 *       distinct `cancelled` disposition, never folded into an ordinary
 *       `resolved`/`failed` record.
 *   15. A leased-origin cancellation with no cooperative response settles,
 *       once its grace period elapses, as cancelled with `uncertain: true`.
 *
 * Every timing-sensitive test uses Bun's fake clock so the cancellation
 * grace period and the reconciliation scan's `now` are exactly controlled.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import {
  beginCompletion,
  claimQueued,
  commitCancellation,
  createQueued,
  recordCancellationIntent,
} from '../core/task-ledger/task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskRecord,
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
import { cancelTask } from './runtime/task-dispatch.ts';
import { scanExpiredTasks } from './runtime/task-reconciliation.ts';
import { handleWorkerWebSocketMessage } from './runtime/websocket-worker.ts';

type FakeWs = {
  data: WebSocketData;
  sentMessages: string[];
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
    close() {},
    unsubscribe() {},
    terminate() {},
  };
}

const NOOP_CLEANUP = (_operationId: string) => {};

/** Test-only override for `ServerContext.cancellationGracePeriodMs`, which is otherwise `readonly`. */
function setCancellationGracePeriod(context: unknown, milliseconds: number): void {
  (context as { cancellationGracePeriodMs: number }).cancellationGracePeriodMs = milliseconds;
}

function registerMessageJson(workerId: string, activities: string[]): string {
  return JSON.stringify({
    type: 'register',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId,
    manifest: manifestForActivities(activities),
    concurrency: 3,
  });
}

async function readRecord(
  storage: MemoryStorage,
  operationId: string,
): Promise<RemoteTaskRecord | null> {
  return decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
}

function freshQueued(now: number, operationId: string): RemoteTaskQueued {
  const created = createQueued(
    null,
    {
      recordVersion: 1,
      operationId,
      workflowType: 'test',
      activityName: 'charge',
      queue: 'default',
      input: null,
      headers: {},
      visibilityTimeoutMilliseconds: 10_000,
      createdAt: now,
    },
    now,
  );
  if (!created.ok) throw new Error(`Expected createQueued to succeed: ${created.reason}`);
  return created.nextRecord;
}

function leaseIt(
  queued: RemoteTaskQueued,
  now: number,
  workerSessionId: string,
  attemptToken: string,
): RemoteTaskLeased {
  const claimed = claimQueued(
    queued,
    {
      expectedGeneration: queued.generation,
      attemptToken,
      workerSessionId,
      leaseDurationMilliseconds: 10_000,
    },
    now,
  );
  if (!claimed.ok) throw new Error(`Expected claimQueued to succeed: ${claimed.reason}`);
  return claimed.nextRecord;
}

describe('Queued-origin cancellation commits without worker delivery (criterion 9)', () => {
  it('cancelTask resolves a queued record straight to cancelled, with no worker ever contacted', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();

    const queued = freshQueued(Date.now(), 'op-queued');
    await storage.put(taskLedgerKey('op-queued'), encodeRemoteTaskRecord(queued));

    const result = await cancelTask(context, options, 'op-queued');
    expect(result).toBe(true);

    const record = await readRecord(storage, 'op-queued');
    expect(record?.state).toBe('terminal');
    expect(record?.state === 'terminal' && record.disposition).toBe('cancelled');

    // No socket was ever registered on the context, and cancelTask never
    // throws or attempts to look one up for a queued-origin cancellation —
    // `context.workerSockets` stays empty throughout.
    expect(context.workerSockets.size).toBe(0);
  });

  it('cancelTask on an unknown operation returns false', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();

    expect(await cancelTask(context, options, 'never-existed')).toBe(false);
  });

  it('cancelTask on an already-cancelled terminal record is an idempotent no-op returning true', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();

    const cancelledTerminal: RemoteTaskRecord = {
      recordVersion: 1,
      operationId: 'op-already-cancelled',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
      headers: {},
      visibilityTimeoutMilliseconds: 30_000,
      createdAt: Date.now(),
      generation: 3,
      state: 'terminal',
      disposition: 'cancelled',
      attempt: 1,
      cancellationReason: 'user requested',
      resultDigest: 'cancelled-digest',
      terminalAt: Date.now(),
      adopted: false,
      retentionGeneration: 0,
    };
    await storage.put(
      taskLedgerKey(cancelledTerminal.operationId),
      encodeRemoteTaskRecord(cancelledTerminal),
    );

    expect(await cancelTask(context, options, cancelledTerminal.operationId)).toBe(true);
  });

  it('cancelTask on a resolved (non-cancelled) terminal record returns false — cannot cancel after the fact', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();

    const resolvedTerminal: RemoteTaskRecord = {
      recordVersion: 1,
      operationId: 'op-already-resolved',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
      headers: {},
      visibilityTimeoutMilliseconds: 30_000,
      createdAt: Date.now(),
      generation: 3,
      state: 'terminal',
      disposition: 'resolved',
      attempt: 1,
      attemptToken: 'attempt-1',
      status: 'completed',
      resultDigest: 'digest-1',
      terminalAt: Date.now(),
      adopted: false,
      retentionGeneration: 0,
    };
    await storage.put(
      taskLedgerKey(resolvedTerminal.operationId),
      encodeRemoteTaskRecord(resolvedTerminal),
    );

    expect(await cancelTask(context, options, resolvedTerminal.operationId)).toBe(false);
  });

  it('cancelTask on a completing record (result already pending commit) returns false — no live attempt left to cancel', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();

    const leased = leaseIt(
      freshQueued(Date.now(), 'op-completing'),
      Date.now(),
      'w-1',
      'attempt-1',
    );
    const completing = beginCompletion(leased, {
      attemptToken: 'attempt-1',
      pendingStatus: 'completed',
      pendingResultDigest: 'digest-1',
    });
    if (!completing.ok)
      throw new Error(`Expected beginCompletion to succeed: ${completing.reason}`);
    await storage.put(
      taskLedgerKey('op-completing'),
      encodeRemoteTaskRecord(completing.nextRecord),
    );

    expect(await cancelTask(context, options, 'op-completing')).toBe(false);
  });
});

describe('Leased-origin cancellation records durable intent before sending control (criterion 10, 11)', () => {
  async function setUpLeasedWithWorker(storage: MemoryStorage) {
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

    const queued = freshQueued(Date.now(), 'op-leased');
    const leased = leaseIt(queued, Date.now(), 'w-1', 'attempt-1');
    await storage.put(taskLedgerKey('op-leased'), encodeRemoteTaskRecord(leased));
    context.registry.assignTask('w-1', 'op-leased', 10_000, undefined, 'attempt-1');

    return { options, context, ws, leased };
  }

  it('commits Leased -> Cancelling durably, then sends cancel with the attempt token', async () => {
    const storage = new MemoryStorage();
    const { options, context, ws, leased } = await setUpLeasedWithWorker(storage);

    const result = await cancelTask(context, options, 'op-leased', 'operator requested');
    expect(result).toBe(true);

    // By the time the promise resolves, the durable write has already
    // committed — no need to poll for it.
    const record = await readRecord(storage, 'op-leased');
    expect(record?.state).toBe('cancelling');
    expect(record?.state === 'cancelling' && record.attemptToken).toBe(leased.attemptToken);
    expect(record?.state === 'cancelling' && record.cancellationReason).toBe('operator requested');

    const cancelMessage = ws.sentMessages
      .map(
        (raw) => JSON.parse(raw) as { type: string; operationId?: string; attemptToken?: string },
      )
      .find((message) => message.type === 'cancel');
    expect(cancelMessage).toBeDefined();
    expect(cancelMessage?.operationId).toBe('op-leased');
    expect(cancelMessage?.attemptToken).toBe(leased.attemptToken);
  });

  it('returns true even with no live worker socket — durable intent is the source of truth, delivery is best-effort', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();

    // A long-poll-style attempt: a leased record with no corresponding
    // WorkerRegistry in-flight entry or socket at all.
    const queued = freshQueued(Date.now(), 'op-longpoll');
    const leased = leaseIt(queued, Date.now(), 'longpoll-worker-1', 'attempt-1');
    await storage.put(taskLedgerKey('op-longpoll'), encodeRemoteTaskRecord(leased));

    const result = await cancelTask(context, options, 'op-longpoll');
    expect(result).toBe(true);

    const record = await readRecord(storage, 'op-longpoll');
    expect(record?.state).toBe('cancelling');
  });

  it('a second cancelTask call while already cancelling is an idempotent no-op success', async () => {
    const storage = new MemoryStorage();
    const { options, context, leased: _leased } = await setUpLeasedWithWorker(storage);

    expect(await cancelTask(context, options, 'op-leased')).toBe(true);
    const afterFirst = await readRecord(storage, 'op-leased');

    expect(await cancelTask(context, options, 'op-leased')).toBe(true);
    const afterSecond = await readRecord(storage, 'op-leased');

    // No second transition — generation unchanged.
    expect(afterSecond?.generation).toBe(afterFirst?.generation);
  });
});

describe('Exactly one conditional terminal winner (criterion 12)', () => {
  it('an ordinary completion that lands FIRST wins; the cooperative cancellation that arrives after loses its own commit', () => {
    const now = 1_000_000;
    const queued = freshQueued(now, 'op-race-1');
    const leased = leaseIt(queued, now, 'w-1', 'attempt-1');
    const cancelling = recordCancellationIntent(
      leased,
      {
        expectedGeneration: leased.generation,
        expectedAttempt: leased.attempt,
        cancellationReason: 'operator requested',
        cancellationToken: 'cancel-token-1',
        cancellationGracePeriodMilliseconds: 30_000,
      },
      now,
    );
    if (!cancelling.ok || cancelling.nextRecord.state !== 'cancelling') {
      throw new Error('Expected recordCancellationIntent to produce a cancelling record');
    }

    // The activity finishes for real DESPITE the pending cancellation —
    // this is the ordinary completion path, widened (COR-230) to also
    // accept a `cancelling` predecessor.
    const begun = beginCompletion(cancelling.nextRecord, {
      attemptToken: 'attempt-1',
      pendingStatus: 'completed',
      pendingResultDigest: 'digest-1',
    });
    expect(begun.ok).toBe(true);

    // The worker's cooperative "I was cancelled" response, modeled as
    // arriving AFTER the real completion already committed — its own
    // commit must now fail: `commitCancellation` requires state
    // `cancelling`, but the record has already moved to `completing`.
    const lateCancellation = commitCancellation(
      begun.ok ? begun.nextRecord : null,
      { attemptToken: 'attempt-1' },
      now + 1,
    );
    expect(lateCancellation).toEqual({ ok: false, reason: 'expected task state "cancelling"' });
  });

  it('a cooperative cancellation that lands FIRST wins; an ordinary result that arrives after loses its own commit', () => {
    const now = 1_000_000;
    const queued = freshQueued(now, 'op-race-2');
    const leased = leaseIt(queued, now, 'w-1', 'attempt-1');
    const cancelling = recordCancellationIntent(
      leased,
      {
        expectedGeneration: leased.generation,
        expectedAttempt: leased.attempt,
        cancellationReason: 'operator requested',
        cancellationToken: 'cancel-token-2',
        cancellationGracePeriodMilliseconds: 30_000,
      },
      now,
    );
    if (!cancelling.ok || cancelling.nextRecord.state !== 'cancelling') {
      throw new Error('Expected recordCancellationIntent to produce a cancelling record');
    }

    const committedCancellation = commitCancellation(
      cancelling.nextRecord,
      { attemptToken: 'attempt-1' },
      now + 1,
    );
    expect(committedCancellation.ok).toBe(true);

    // A genuine (or stale) ordinary completion arriving after must lose —
    // the record has already left `cancelling`/`leased` entirely.
    const lateCompletion = beginCompletion(
      committedCancellation.ok ? committedCancellation.nextRecord : null,
      { attemptToken: 'attempt-1', pendingStatus: 'completed', pendingResultDigest: 'digest-2' },
    );
    expect(lateCompletion).toEqual({
      ok: false,
      reason: 'expected task state "leased" or "cancelling"',
    });
  });
});

describe('Cancelled disposition is distinct from generic failure (criterion 13)', () => {
  it('commitCancellation produces disposition "cancelled", never "resolved"', () => {
    const now = 1_000_000;
    const queued = freshQueued(now, 'op-disposition');
    const leased = leaseIt(queued, now, 'w-1', 'attempt-1');
    const cancelling = recordCancellationIntent(
      leased,
      {
        expectedGeneration: leased.generation,
        expectedAttempt: leased.attempt,
        cancellationReason: 'operator requested',
        cancellationToken: 'cancel-token-3',
        cancellationGracePeriodMilliseconds: 30_000,
      },
      now,
    );
    if (!cancelling.ok || cancelling.nextRecord.state !== 'cancelling') {
      throw new Error('Expected a cancelling record');
    }
    const committed = commitCancellation(
      cancelling.nextRecord,
      { attemptToken: 'attempt-1' },
      now + 1,
    );
    if (!committed.ok) throw new Error('Expected commitCancellation to succeed');

    expect(committed.nextRecord.state).toBe('terminal');
    expect(committed.nextRecord.disposition).toBe('cancelled');
    expect(committed.nextRecord).not.toHaveProperty('status');
    expect(committed.nextRecord.uncertain).toBeUndefined();
  });
});

describe('Non-cooperative cancellation settles within the deadline, marked uncertain (criterion 15)', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('scanExpiredTasks force-settles a cancelling record whose grace period elapsed with no cooperative result', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    setCancellationGracePeriod(context, 5_000);

    const ws = createFakeWs();
    handleWorkerWebSocketMessage(
      context,
      options,
      ws as never,
      registerMessageJson('w-uncoop', ['charge']),
      NOOP_CLEANUP,
    );
    await waitForCondition(() => context.registry.getWorker('w-uncoop') !== undefined, {
      label: 'worker registered',
    });

    useFakeTimers(Date.now());
    const startedAt = Date.now();
    const queued = freshQueued(startedAt, 'op-uncooperative');
    const leased = leaseIt(queued, startedAt, 'w-uncoop', 'attempt-1');
    await storage.put(taskLedgerKey('op-uncooperative'), encodeRemoteTaskRecord(leased));
    context.registry.assignTask('w-uncoop', 'op-uncooperative', 10_000, undefined, 'attempt-1');

    const cancelled = await cancelTask(context, options, 'op-uncooperative', 'operator requested');
    expect(cancelled).toBe(true);
    const cancelling = await readRecord(storage, 'op-uncooperative');
    if (cancelling?.state !== 'cancelling') throw new Error('Expected a cancelling record');
    expect(cancelling.cancellationDeadline).toBe(startedAt + 5_000);

    // The worker never responds. Advance past the grace period and drive
    // the scan — no polling, one explicit barrier.
    useFakeTimers(cancelling.cancellationDeadline + 10);
    await scanExpiredTasks(context, options, NOOP_CLEANUP, cancelling.cancellationDeadline + 10);

    const settled = await readRecord(storage, 'op-uncooperative');
    expect(settled?.state).toBe('terminal');
    expect(settled?.state === 'terminal' && settled.disposition).toBe('cancelled');
    expect(
      settled?.state === 'terminal' && settled.disposition === 'cancelled' && settled.uncertain,
    ).toBe(true);
    expect(context.registry.isAssigned('op-uncooperative')).toBe(false);
  });

  it('does not force-settle before the grace period elapses', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();

    const now = 1_000_000;
    useFakeTimers(now);
    const queued = freshQueued(now, 'op-still-waiting');
    const leased = leaseIt(queued, now, 'w-1', 'attempt-1');
    const cancelling = recordCancellationIntent(
      leased,
      {
        expectedGeneration: leased.generation,
        expectedAttempt: leased.attempt,
        cancellationReason: 'operator requested',
        cancellationToken: 'cancel-token-4',
        cancellationGracePeriodMilliseconds: 5_000,
      },
      now,
    );
    if (!cancelling.ok || cancelling.nextRecord.state !== 'cancelling') {
      throw new Error('Expected a cancelling record');
    }
    await storage.put(
      taskLedgerKey('op-still-waiting'),
      encodeRemoteTaskRecord(cancelling.nextRecord),
    );
    context.deadlineTracker.add({
      operationId: 'op-still-waiting',
      deadline: cancelling.nextRecord.cancellationDeadline,
    });

    // Still within the grace period.
    useFakeTimers(now + 1_000);
    await scanExpiredTasks(context, options, NOOP_CLEANUP, now + 1_000);

    const record = await readRecord(storage, 'op-still-waiting');
    expect(record?.state).toBe('cancelling');
  });
});
