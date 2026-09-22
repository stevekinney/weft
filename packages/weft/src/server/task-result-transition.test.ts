/**
 * COR-240 "Protocol and Outbox" — durable-ledger transition tests for the
 * result-application contract that `taskResultAck`'s `applied | duplicate |
 * dead-lettered` disposition rests on.
 *
 * These are unit tests of `commitTaskLedgerCompletion` (the two-step
 * `Leased -> Completing -> Terminal` commit shared by both transports) and
 * `applyWorkerTaskResult` (the shared result-application implementation on
 * top of it) against a real `MemoryStorage`, driven directly rather than
 * through a live WebSocket or HTTP transport — the transport-specific
 * authorization guards (`onTaskResultMessage`'s registry checks,
 * `isLongPollCompletionAuthorized`) are covered in their own transport
 * test files (`websocket-worker.characterization.test.ts`,
 * `task-polling.characterization.test.ts`); this file covers what happens
 * once a submission reaches the ledger.
 *
 * Fixture coverage (COR-240's required fixture list):
 *   - restart after commit / duplicate-after-restart: "a committed duplicate
 *     returns duplicate after process restart"
 *   - conflicting duplicate: "conflicting content under one attempt token"
 *   - unknown operation: "a result for an unknown operation..."
 *   - queued successor: "a result for a queued or newer attempt..."
 *   - stale same-worker attempt: "a stale attempt cannot mutate..."
 *   - visibility-timeout race: "visibility scanning cannot requeue..."
 *   - recoverable completed-result dead letter: "...retains the canonical
 *     value or a recoverable content-addressed reference"
 * The remaining required fixtures live where their behavior actually lives:
 * "socket loss before acknowledgement" and "forced disposal" are worker-side
 * outbox behavior (`src/worker/index.test.ts`), and "queue-path mismatch" is
 * an HTTP long-poll transport concern (`task-polling.characterization.test.ts`).
 */

import { describe, expect, it, spyOn } from 'bun:test';

import type { TaskResultDeadLetteredEvent } from '../core/events.ts';
import { commitTaskLedgerTransition } from '../core/task-ledger/task-ledger-runtime.ts';
import {
  beginCompletion,
  requeueExpiredAttempt,
} from '../core/task-ledger/task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskDeadLettered,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
} from '../core/task-ledger/task-ledger.ts';
import { storageConditionalBatch } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { sha256Hex } from '../worker/manifest/content-digest.ts';
import {
  FailingTerminalCommitStorage,
  minimalServeOptions,
} from './runtime/server-context.test-support.ts';
import { commitTaskLedgerCompletion } from './runtime/task-ledger-completion.ts';
import { applyWorkerTaskResult } from './runtime/task-result-application.ts';

function leasedFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
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
    attemptToken: 'attempt-1',
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

function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
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

async function writeRecord(
  storage: MemoryStorage,
  record: RemoteTaskLeased | RemoteTaskQueued | RemoteTaskDeadLettered,
): Promise<void> {
  await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));
}

async function digestFor(input: {
  status: 'completed' | 'failed';
  value?: unknown;
  error?: string;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      status: input.status,
      value: input.value ?? null,
      error: input.error ?? null,
    }),
  );
}

describe('commitTaskLedgerCompletion — duplicate and dead-lettered idempotency (COR-240)', () => {
  it('a committed duplicate returns duplicate after process restart', async () => {
    const storage = new MemoryStorage();
    const leased = leasedFixture({ operationId: 'op-duplicate-restart' });
    await writeRecord(storage, leased);

    const first = await commitTaskLedgerCompletion(storage, {
      operationId: leased.operationId,
      attemptToken: leased.attemptToken,
      status: 'completed',
      value: { total: 42 },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected the first commit to succeed');
    expect(first.disposition).toBe('applied');
    const terminalAfterFirst = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey(leased.operationId)),
    );
    expect(terminalAfterFirst?.state).toBe('terminal');

    // "Restart": the same durable storage instance is reused (a fresh process
    // attaching to the same data), and the worker's outbox — never having
    // received a taskResultAck — resends the identical result.
    const afterRestart = await commitTaskLedgerCompletion(storage, {
      operationId: leased.operationId,
      attemptToken: leased.attemptToken,
      status: 'completed',
      value: { total: 42 },
    });
    expect(afterRestart.ok).toBe(true);
    if (!afterRestart.ok) throw new Error('expected the duplicate resubmission to succeed');
    expect(afterRestart.disposition).toBe('duplicate');
    // No new write: the terminal record is unchanged (same generation).
    const terminalAfterRestart = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey(leased.operationId)),
    );
    expect(terminalAfterRestart).toEqual(terminalAfterFirst);
  });

  it('rejects conflicting content resubmitted under the same attempt token against a terminal record', async () => {
    const storage = new MemoryStorage();
    const leased = leasedFixture({ operationId: 'op-conflicting-terminal' });
    await writeRecord(storage, leased);

    const first = await commitTaskLedgerCompletion(storage, {
      operationId: leased.operationId,
      attemptToken: leased.attemptToken,
      status: 'completed',
      value: 'original-value',
    });
    expect(first.ok).toBe(true);

    const conflicting = await commitTaskLedgerCompletion(storage, {
      operationId: leased.operationId,
      attemptToken: leased.attemptToken,
      status: 'completed',
      value: 'a-completely-different-value',
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('expected conflicting content to be rejected');
    expect(conflicting.reason).toContain('conflicting content');
    expect(conflicting.reason).toContain(leased.attemptToken);

    // The original terminal record is untouched.
    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(leased.operationId)));
    expect(record?.state).toBe('terminal');
  });

  it('rejects conflicting content resubmitted under the same attempt token against a dead-lettered record', async () => {
    const storage = new MemoryStorage();
    const digest = await digestFor({ status: 'completed', value: 'first' });
    const deadLettered: RemoteTaskDeadLettered = {
      ...leasedFixture({ operationId: 'op-conflicting-dead-letter' }),
      state: 'deadLettered',
      pendingStatus: 'completed',
      pendingResultDigest: digest,
      value: 'first',
      deadLetteredAt: Date.now(),
      persistenceFailureReason: 'simulated persistence failure',
    };
    await writeRecord(storage, deadLettered);

    const matching = await commitTaskLedgerCompletion(storage, {
      operationId: deadLettered.operationId,
      attemptToken: deadLettered.attemptToken,
      status: 'completed',
      value: 'first',
    });
    expect(matching.ok).toBe(true);
    if (!matching.ok) throw new Error('expected the matching resubmission to succeed');
    expect(matching.disposition).toBe('dead-lettered');
    expect(matching.deadLettered).toEqual(deadLettered);

    const conflicting = await commitTaskLedgerCompletion(storage, {
      operationId: deadLettered.operationId,
      attemptToken: deadLettered.attemptToken,
      status: 'completed',
      value: 'a-different-value',
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('expected conflicting content to be rejected');
    expect(conflicting.reason).toContain('conflicting content');
  });
});

describe('commitTaskLedgerCompletion — stale, unknown, and superseded attempts (COR-240)', () => {
  it('a stale attempt cannot mutate the current (newer) attempt', async () => {
    const storage = new MemoryStorage();
    // The current lease is attempt 2, holding a fresh attempt token.
    const leased = leasedFixture({
      operationId: 'op-stale-attempt',
      attempt: 2,
      attemptToken: 'attempt-2',
    });
    await writeRecord(storage, leased);

    const staleResult = await commitTaskLedgerCompletion(storage, {
      operationId: leased.operationId,
      // Echoes attempt 1's token — a worker that never learned the task was
      // re-dispatched under a fresh token.
      attemptToken: 'attempt-1',
      status: 'completed',
      value: 'stale-value',
    });
    expect(staleResult.ok).toBe(false);
    if (staleResult.ok) throw new Error('expected the stale attempt to be rejected');
    expect(staleResult.reason).toContain('attempt token mismatch');
    expect(staleResult.deadLettered).toBeUndefined();

    // The current attempt's lease is completely unaffected.
    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(leased.operationId)));
    expect(record).toEqual(leased);
  });

  it('a result for an unknown operation cannot create a resolved or dead-letter record', async () => {
    const storage = new MemoryStorage();

    const result = await commitTaskLedgerCompletion(storage, {
      operationId: 'op-never-dispatched',
      attemptToken: 'any-token',
      status: 'completed',
      value: 'value',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the unknown operation to be rejected');
    expect(result.reason).toContain('leased');
    expect(result.deadLettered).toBeUndefined();

    // No record was created at all — not resolved, not dead-lettered.
    const record = await storage.get(taskLedgerKey('op-never-dispatched'));
    expect(record).toBeNull();
  });

  it('a result for a queued successor attempt is rejected without creating multiple durable states', async () => {
    const storage = new MemoryStorage();
    // The original attempt already timed out and was requeued for retry —
    // the record has moved on to `queued`, holding no attempt token at all.
    const queued = queuedFixture({ operationId: 'op-queued-successor' });
    await writeRecord(storage, queued);

    const staleResult = await commitTaskLedgerCompletion(storage, {
      operationId: queued.operationId,
      attemptToken: 'attempt-1',
      status: 'completed',
      value: 'late-value',
    });
    expect(staleResult.ok).toBe(false);
    if (staleResult.ok) throw new Error('expected the queued-successor result to be rejected');
    expect(staleResult.reason).toContain('leased');
    expect(staleResult.deadLettered).toBeUndefined();

    // The queued record is the sole durable state — no second record, no
    // dead letter, nothing partially applied.
    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(queued.operationId)));
    expect(record).toEqual(queued);
  });

  it('a result for a newer in-progress attempt (leased under a different token) is rejected the same way', async () => {
    const storage = new MemoryStorage();
    const leased = leasedFixture({
      operationId: 'op-newer-attempt-in-progress',
      attempt: 3,
      attemptToken: 'attempt-3',
    });
    await writeRecord(storage, leased);

    const staleResult = await commitTaskLedgerCompletion(storage, {
      operationId: leased.operationId,
      attemptToken: 'attempt-2',
      status: 'completed',
      value: 'late-value',
    });
    expect(staleResult.ok).toBe(false);
    if (staleResult.ok) throw new Error('expected the superseded attempt to be rejected');
    expect(staleResult.reason).toContain('attempt token mismatch');

    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(leased.operationId)));
    expect(record).toEqual(leased);
  });
});

describe('visibility scanning cannot requeue an attempt while its result is durably applying (COR-240)', () => {
  it('a scanner requeue loses the CAS once completion has landed, and cannot land afterward either', async () => {
    const storage = new MemoryStorage();
    const leased = leasedFixture({ operationId: 'op-visibility-race', attemptToken: 'attempt-1' });
    const key = taskLedgerKey(leased.operationId);
    await writeRecord(storage, leased);

    // Snapshot the bytes a visibility scanner would have read while the
    // record was still `leased` and its deadline had just expired.
    const staleLeasedBytes = await storage.get(key);
    expect(staleLeasedBytes).not.toBeNull();

    // The worker's completion begins first: `leased` -> `completing`. This is
    // the durable write `commitTaskLedgerCompletion` makes before the second
    // (terminal) write — deliberately observable here rather than collapsed
    // into one call, to prove the race window it exists to close.
    const resultDigest = await digestFor({ status: 'completed', value: 'v' });
    const begun = await commitTaskLedgerTransition(
      storage,
      leased.operationId,
      (current) =>
        beginCompletion(current, {
          attemptToken: leased.attemptToken,
          pendingStatus: 'completed',
          pendingResultDigest: resultDigest,
        }),
      1,
    );
    expect(begun.ok).toBe(true);

    // (a) A scanner holding the STALE `leased` bytes cannot land its requeue
    // — even though `requeueExpiredAttempt` itself would happily compute a
    // next record from those stale bytes, the storage-level compare-and-swap
    // rejects it because the current bytes have already moved to `completing`.
    const nowFarInTheFuture = Date.now() + 1_000_000;
    const staleRecord = decodeRemoteTaskRecord(staleLeasedBytes);
    const requeueFromStale = requeueExpiredAttempt(
      staleRecord,
      { attemptToken: leased.attemptToken, requeueReason: 'visibility-timeout' },
      nowFarInTheFuture,
    );
    expect(requeueFromStale.ok).toBe(true);
    if (!requeueFromStale.ok) throw new Error('expected a valid next record from the stale bytes');
    const staleCasSucceeded = await storageConditionalBatch(
      storage,
      [{ key, expectedValue: staleLeasedBytes }],
      [{ type: 'put', key, value: encodeRemoteTaskRecord(requeueFromStale.nextRecord) }],
    );
    expect(staleCasSucceeded).toBe(false);

    // (b) The real scanner path — a fresh read followed by the precondition
    // check — also correctly rejects, since the fresh record is `completing`,
    // not `leased`.
    const scannerAttempt = await commitTaskLedgerTransition(
      storage,
      leased.operationId,
      (current, now) =>
        requeueExpiredAttempt(
          current,
          { attemptToken: leased.attemptToken, requeueReason: 'visibility-timeout' },
          now,
        ),
      1,
    );
    expect(scannerAttempt.ok).toBe(false);
    if (scannerAttempt.ok) throw new Error('expected the scanner requeue to be rejected');
    expect(scannerAttempt.reason).toContain('leased');

    // The record is still `completing` — neither requeue attempt mutated it.
    const midState = decodeRemoteTaskRecord(await storage.get(key));
    expect(midState?.state).toBe('completing');

    // (c) The worker's completion finishes normally afterward — the race
    // never stranded it.
    const finished = await commitTaskLedgerCompletion(storage, {
      operationId: leased.operationId,
      attemptToken: leased.attemptToken,
      status: 'completed',
      value: 'v',
    });
    expect(finished.ok).toBe(true);
    if (!finished.ok) throw new Error('expected the completion to finish successfully');
    expect(finished.disposition).toBe('applied');
    const finalState = decodeRemoteTaskRecord(await storage.get(key));
    expect(finalState?.state).toBe('terminal');
  });
});

describe('applyWorkerTaskResult — dead-lettered disposition (COR-240)', () => {
  it('storage retry exhaustion creates a durable dead letter and returns dead-lettered', async () => {
    const storage = new FailingTerminalCommitStorage('op-retry-exhaustion');
    const leased = leasedFixture({ operationId: 'op-retry-exhaustion' });
    await writeRecord(storage, leased);
    const options = minimalServeOptions(storage);
    const dispatchEventSpy = spyOn(options.engine, 'dispatchEvent');

    const applied = await applyWorkerTaskResult(
      options,
      undefined,
      {
        operationId: leased.operationId,
        attemptToken: leased.attemptToken,
        status: 'completed',
        value: 'v',
      },
      leased.workerSessionId,
    );

    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('expected a dead-lettered result to still be an ok ack');
    expect(applied.disposition).toBe('dead-lettered');

    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(leased.operationId)));
    expect(record?.state).toBe('deadLettered');
    expect(dispatchEventSpy).toHaveBeenCalledTimes(1);
    const event = dispatchEventSpy.mock.calls[0]?.[0] as TaskResultDeadLetteredEvent;
    expect(event.type).toBe('task:dead-lettered');
    expect(event.operationId).toBe(leased.operationId);
  });

  it('a completed-result dead letter retains the canonical value and a recoverable content-addressed reference', async () => {
    const storage = new FailingTerminalCommitStorage('op-recoverable-dead-letter');
    const leased = leasedFixture({ operationId: 'op-recoverable-dead-letter' });
    await writeRecord(storage, leased);
    const options = minimalServeOptions(storage);
    const canonicalValue = { orderId: 'order-42', items: ['widget', 'gadget'], total: 19.99 };

    const applied = await applyWorkerTaskResult(
      options,
      undefined,
      {
        operationId: leased.operationId,
        attemptToken: leased.attemptToken,
        status: 'completed',
        value: canonicalValue,
      },
      leased.workerSessionId,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('expected the result to be dead-lettered, not rejected');
    expect(applied.disposition).toBe('dead-lettered');

    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(leased.operationId)));
    if (record?.state !== 'deadLettered') {
      throw new Error('expected a deadLettered ledger record');
    }
    // The canonical value survives the dead letter directly...
    expect(record.value).toEqual(canonicalValue);
    // ...and is also independently recoverable by content digest, so a
    // consumer that only has the digest (not the inline value) can still
    // verify — or, in a storage backend that externalizes large values,
    // fetch — the exact result this dead letter represents.
    const expectedDigest = await digestFor({ status: 'completed', value: canonicalValue });
    expect(record.pendingResultDigest).toBe(expectedDigest);
  });
});

describe('applyWorkerTaskResult — hard rejection (not dead-lettered)', () => {
  it("surfaces commitTaskLedgerCompletion's hard rejection reason for an unknown operation, without dead-lettering", async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);

    const applied = await applyWorkerTaskResult(
      options,
      undefined,
      {
        operationId: 'op-never-dispatched',
        attemptToken: 'any-token',
        status: 'completed',
        value: 'value',
      },
      'worker-1',
    );

    expect(applied.ok).toBe(false);
    if (applied.ok) throw new Error('expected a hard rejection, not an ack');
    expect(applied.reason).toContain('leased');
  });
});
