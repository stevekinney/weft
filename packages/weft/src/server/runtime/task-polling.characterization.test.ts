/**
 * Characterization tests for handleTaskResultRequest.
 *
 * These tests assert the HTTP response shapes the function returns for every
 * valid and invalid input combination so the refactor cannot silently change
 * those contract shapes. Migrated off the retired `op:queued:`/`op:inflight:`/
 * `op:resolved:`/`op:dead-letter:` keys onto the durable `task-ledger:` record
 * (WFT-22) — fixtures now write real ledger records instead of the deleted
 * `markInflight`. A completion for an operation with no ledger record returns
 * 403 instead of a tolerant 200 no-op (see `isLongPollCompletionAuthorized`'s
 * doc comment). A terminal-commit persistence failure that escalates to a
 * dead letter (WFT-24) returns 200 with `disposition: 'dead-lettered'`
 * (COR-240) rather than either a tolerant 200 or a 403 — see
 * `task-ledger-completion.ts`'s doc comment for the disposition contract.
 * Every success response now also reports its `disposition` (COR-240).
 */

import { describe, expect, it, spyOn } from 'bun:test';

import type { TaskResultDeadLetteredEvent } from '../../core/events.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  isRemoteTaskTerminalResolved,
  taskLedgerKey,
  type RemoteTaskLeased,
  type RemoteTaskTerminalResolved,
} from '../../core/task-ledger/task-ledger.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { principalFromApiKey } from '../principal.ts';
import {
  FailingTerminalCommitStorage,
  minimalServeOptions,
  minimalServerContext,
} from './server-context.test-support.ts';
import { dispatchTaskImpl } from './task-dispatch.ts';
import { handleTaskPollRequest, handleTaskResultRequest } from './task-polling.ts';
import { taskResultPayloadSizeError } from './task-result-resolution.ts';

/** handleTaskResultRequest never consults the worker registry, so use a null one. */
function createMinimalContext() {
  return minimalServerContext({ registry: null as never });
}

const createMinimalOptions = minimalServeOptions;
const WORKER_PRINCIPAL = principalFromApiKey({
  subject: 'worker-key',
  scopes: ['workers:write'],
});

function makePostRequest(body: unknown): Request {
  return new Request('http://localhost/v1/tasks/op-123/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The `:queue` path segment must match each fixture's ledger record `queue`
// field (COR-240) — every fixture in this file uses the shared `queue:
// 'default'` default from `leasedFixture()`, so the default URL segment
// here is `default`, not an operation-specific slug.
function makeUrl(path = '/v1/tasks/default/result'): URL {
  return new URL(`http://localhost${path}`);
}

function setPayloadSizeLimit(context: unknown, maxBytes: number): void {
  (context as { payloadSizeMaxBytes: number | null }).payloadSizeMaxBytes = maxBytes;
}

/**
 * Build a `leased` ledger record directly (WFT-22), matching the
 * `leasedFixture()` pattern in `task-ledger.test.ts` / `task-ledger-transitions.test.ts`.
 * These `handleTaskResultRequest` tests are narrow completion-path unit
 * tests — they don't care how the record got into `leased` state, only that
 * `commitTaskLedgerCompletion` sees a real one, so a hand-built record is
 * preferred here over driving a full dispatch/claim flow.
 */
function leasedFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-1',
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
    ...overrides,
  };
}

async function writeLeasedRecord(
  storage: MemoryStorage,
  overrides: Partial<RemoteTaskLeased> = {},
): Promise<RemoteTaskLeased> {
  const record = leasedFixture(overrides);
  await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));
  return record;
}

/**
 * Read a task's resolved terminal ledger record (WFT-22). Unlike the
 * retired `op:resolved:` record, this narrows with `isRemoteTaskTerminalResolved`
 * rather than an `as` cast, and it never asserts a `value` field — the
 * ledger's terminal record doesn't persist the completed payload (see
 * `state-worker-harness.parity.test.ts`'s `readTerminalRecord` doc comment;
 * delivering the value into a workflow continuation is WFT-24 territory).
 */
async function readResolvedTerminalRecord(
  storage: MemoryStorage,
  operationId: string,
): Promise<RemoteTaskTerminalResolved> {
  const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
  if (!isRemoteTaskTerminalResolved(record)) {
    throw new Error(
      `Expected operation "${operationId}" to have a resolved terminal ledger record`,
    );
  }
  return record;
}

describe('handleTaskResultRequest', () => {
  it('returns the payload-size diagnostic for an oversized completion value', () => {
    const error = taskResultPayloadSizeError(
      {
        status: 'completed',
        value: { blob: 'x'.repeat(200) },
      },
      64,
    );

    expect(error?.message).toContain('activity result exceeds');
  });

  it('returns null for non-POST requests', async () => {
    const context = createMinimalContext();
    const options = createMinimalOptions();
    const request = new Request('http://localhost/v1/tasks/op-1/result', { method: 'GET' });
    const result = await handleTaskResultRequest(context, options, request, makeUrl());
    expect(result).toBeNull();
  });

  it('returns 503 when startup task-ledger recovery failed', async () => {
    const rejection = Promise.reject(new Error('recovery scan failed'));
    rejection.catch(() => {});
    const context = { ...createMinimalContext(), taskLedgerRecovery: { ready: rejection } };
    const options = createMinimalOptions();
    const request = makePostRequest({ operationId: 'op-1', status: 'completed', value: 1 });

    const response = await handleTaskResultRequest(context, options, request, makeUrl());

    expect(response?.status).toBe(503);
    const body = (await response?.json()) as { error?: string };
    expect(body.error).toContain('Startup task-ledger recovery failed');
    expect(body.error).toContain('recovery scan failed');
  });

  it('returns null when path does not match task result pattern', async () => {
    const context = createMinimalContext();
    const options = createMinimalOptions();
    const request = makePostRequest({ operationId: 'op-1', status: 'completed' });
    const result = await handleTaskResultRequest(
      context,
      options,
      request,
      makeUrl('/v1/tasks/result'),
    );
    expect(result).toBeNull();
  });

  it('returns 400 for invalid JSON body', async () => {
    const context = createMinimalContext();
    const options = createMinimalOptions();
    const request = new Request('http://localhost/v1/tasks/op-1/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    const response = await handleTaskResultRequest(context, options, request, makeUrl());
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body).toMatchObject({ error: 'Invalid JSON body' });
  });

  it('returns 413 when the raw task result body exceeds the configured request limit', async () => {
    const context = createMinimalContext();
    const options = {
      ...createMinimalOptions(),
      maxRequestBodyBytes: 32,
    };
    const request = makePostRequest({
      operationId: 'op-1',
      status: 'completed',
      value: 'x'.repeat(64),
    });

    const response = await handleTaskResultRequest(context, options, request, makeUrl());

    expect(response?.status).toBe(413);
    expect(response?.json()).resolves.toEqual({ error: 'Payload Too Large' });
  });

  it('returns 400 when operationId is missing', async () => {
    const context = createMinimalContext();
    const options = createMinimalOptions();
    const request = makePostRequest({ status: 'completed' });
    const response = await handleTaskResultRequest(context, options, request, makeUrl());
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.error).toMatch(/operationId/);
  });

  it('returns 400 when status is missing', async () => {
    const context = createMinimalContext();
    const options = createMinimalOptions();
    const request = makePostRequest({ operationId: 'op-1' });
    const response = await handleTaskResultRequest(context, options, request, makeUrl());
    expect(response?.status).toBe(400);
  });

  it('returns 400 for invalid status value', async () => {
    const context = createMinimalContext();
    const options = createMinimalOptions();
    const request = makePostRequest({ operationId: 'op-1', status: 'pending' });
    const response = await handleTaskResultRequest(context, options, request, makeUrl());
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.error).toMatch(/completed.*failed|failed.*completed/);
  });

  it('returns 200 ok for a valid completed result', async () => {
    const context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-1' });
    const request = makePostRequest({
      operationId: 'op-1',
      workerId: 'longpoll-worker',
      attemptToken: 'attempt-token',
      status: 'completed',
      value: 42,
    });
    const response = await handleTaskResultRequest(context, options, request, makeUrl());
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ ok: true, disposition: 'applied' });
  });

  it("rejects a result posted against a :queue path segment that does not match the record's queue (COR-240)", async () => {
    const context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-queue-mismatch', queue: 'default' });
    const request = makePostRequest({
      operationId: 'op-queue-mismatch',
      workerId: 'longpoll-worker',
      attemptToken: 'attempt-token',
      status: 'completed',
      value: 42,
    });

    // The record's own queue is "default"; the request arrives on a
    // different queue's result path. The rest of the body — worker,
    // attemptToken, status — is otherwise perfectly valid.
    const response = await handleTaskResultRequest(
      context,
      options,
      request,
      makeUrl('/v1/tasks/other-queue/result'),
      WORKER_PRINCIPAL,
    );

    expect(response?.status).toBe(403);
    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-queue-mismatch')));
    expect(record?.state).toBe('leased');
  });

  it('returns 200 ok for a valid failed result', async () => {
    const context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-2' });
    const request = makePostRequest({
      operationId: 'op-2',
      workerId: 'longpoll-worker',
      attemptToken: 'attempt-token',
      status: 'failed',
      error: 'Something went wrong',
    });
    const response = await handleTaskResultRequest(context, options, request, makeUrl());
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ ok: true, disposition: 'applied' });
  });

  it('rejects oversized completed results and resolves the long-poll task as failed', async () => {
    const storage = new MemoryStorage();
    const context = createMinimalContext();
    setPayloadSizeLimit(context, 64);
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-oversize-http' });

    const request = makePostRequest({
      operationId: 'op-oversize-http',
      workerId: 'longpoll-worker',
      attemptToken: 'attempt-token',
      status: 'completed',
      value: { blob: 'x'.repeat(200) },
    });

    const response = await handleTaskResultRequest(
      context,
      options,
      request,
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );

    expect(response?.status).toBe(413);
    const body = await response?.json();
    expect(body).toMatchObject({ code: 'PayloadSizeExceededError' });
    expect(body.error).toContain('activity result exceeds');

    // No `value` field is asserted here — the ledger's terminal record never
    // persists the completed payload (see readResolvedTerminalRecord's doc
    // comment); there is no equivalent of the retired `ResolvedRecord.value`.
    const resolved = await readResolvedTerminalRecord(storage, 'op-oversize-http');
    expect(resolved.status).toBe('failed');
    expect(resolved.error).toContain('activity result exceeds');
  });

  it('rejects oversized failure errors and resolves the long-poll task as failed', async () => {
    const storage = new MemoryStorage();
    const context = createMinimalContext();
    setPayloadSizeLimit(context, 64);
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-oversize-http-failure' });

    const request = makePostRequest({
      operationId: 'op-oversize-http-failure',
      workerId: 'longpoll-worker',
      attemptToken: 'attempt-token',
      status: 'failed',
      error: 'x'.repeat(200),
    });

    const response = await handleTaskResultRequest(
      context,
      options,
      request,
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );

    expect(response?.status).toBe(413);
    const body = await response?.json();
    expect(body.error).toContain('activity result exceeds');

    const resolved = await readResolvedTerminalRecord(storage, 'op-oversize-http-failure');
    expect(resolved.status).toBe('failed');
    expect(resolved.error).toContain('activity result exceeds');
    expect(resolved.error).not.toContain('x'.repeat(100));
  });

  it('measures failed-result payload size against the persisted error string', async () => {
    const storage = new MemoryStorage();
    const context = createMinimalContext();
    setPayloadSizeLimit(context, 10);
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-failure-size-boundary' });

    const response = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-failure-size-boundary',
        workerId: 'longpoll-worker',
        attemptToken: 'attempt-token',
        status: 'failed',
        error: '12345678',
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );

    expect(response?.status).toBe(200);
    const resolved = await readResolvedTerminalRecord(storage, 'op-failure-size-boundary');
    expect(resolved.status).toBe('failed');
    expect(resolved.error).toBe('12345678');
  });

  // Renamed again for COR-240: a sustained terminal-commit persistence
  // failure now surfaces as a 200 with `disposition: 'dead-lettered'` (COR-240
  // acceptance criterion 10), not a bare 403 — the point of the disposition
  // protocol is that the caller gets a definitive, actionable answer instead
  // of an ambiguous rejection. Operator visibility moved from a console.error
  // to the structured `TaskResultDeadLetteredEvent` dispatch, asserted below.
  it('dead-letters and returns 200 with disposition dead-lettered when the terminal ledger commit cannot be persisted', async () => {
    const storage = new FailingTerminalCommitStorage('op-resolved-write-fails');
    const context = createMinimalContext();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-resolved-write-fails' });
    const dispatchEventSpy = spyOn(options.engine, 'dispatchEvent');

    const response = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-resolved-write-fails',
        workerId: 'longpoll-worker',
        attemptToken: 'attempt-token',
        status: 'completed',
        value: { ok: true },
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ ok: true, disposition: 'dead-lettered' });

    // WFT-24: the sustained terminal-commit failure escalates to a
    // best-effort Completing --> DeadLettered write (FailingTerminalCommitStorage
    // only blocks writes whose next state is `terminal`, so the dead-letter
    // write — next state `deadLettered` — succeeds) instead of leaving the
    // record silently stuck in `completing` forever.
    const deadLettered = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey('op-resolved-write-fails')),
    );
    expect(deadLettered?.state).toBe('deadLettered');
    expect(dispatchEventSpy).toHaveBeenCalledTimes(1);
    const dispatchedEvent = dispatchEventSpy.mock.calls[0]?.[0] as TaskResultDeadLetteredEvent;
    expect(dispatchedEvent.type).toBe('task:dead-lettered');
    expect(dispatchedEvent.operationId).toBe('op-resolved-write-fails');
    expect(dispatchedEvent.errorMessage).toBe(
      'lost the compare-and-swap race on operation "op-resolved-write-fails" after 3 attempt(s)',
    );
  });

  it('dead-letters an oversized-result rejection whose persistence itself fails', async () => {
    const storage = new FailingTerminalCommitStorage('op-oversize-rejection-write-fails');
    const context = createMinimalContext();
    setPayloadSizeLimit(context, 64);
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-oversize-rejection-write-fails' });
    const dispatchEventSpy = spyOn(options.engine, 'dispatchEvent');

    const response = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-oversize-rejection-write-fails',
        workerId: 'longpoll-worker',
        attemptToken: 'attempt-token',
        status: 'completed',
        value: { blob: 'x'.repeat(200) },
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );

    // The 413 response reports the oversize rejection to the caller
    // regardless of how the ledger resolved the substitute "failed" result —
    // but that substitute result itself still dead-letters here (COR-240),
    // observable through the same structured event as any other dead letter.
    expect(response?.status).toBe(413);
    const deadLettered = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey('op-oversize-rejection-write-fails')),
    );
    expect(deadLettered?.state).toBe('deadLettered');
    expect(dispatchEventSpy).toHaveBeenCalledTimes(1);
    const dispatchedEvent = dispatchEventSpy.mock.calls[0]?.[0] as TaskResultDeadLetteredEvent;
    expect(dispatchedEvent.type).toBe('task:dead-lettered');
    expect(dispatchedEvent.operationId).toBe('op-oversize-rejection-write-fails');
  });

  it('removes the deadline tracker entry on success', async () => {
    const context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-tracked' });

    context.deadlineTracker.add({ operationId: 'op-tracked', deadline: Date.now() + 30_000 });
    expect(context.deadlineTracker.size).toBe(1);

    const request = makePostRequest({
      operationId: 'op-tracked',
      workerId: 'longpoll-worker',
      attemptToken: 'attempt-token',
      status: 'completed',
    });
    const response = await handleTaskResultRequest(
      context,
      options,
      request,
      makeUrl('/v1/tasks/default/result'),
    );

    expect(response?.status).toBe(200);
    expect(context.deadlineTracker.size).toBe(0);
  });

  it('returns 403 and logs when the ledger commit fails outright (not dead-lettered)', async () => {
    // Unlike FailingTerminalCommitStorage (which only blocks the terminal
    // write and so still succeeds via dead-lettering), this fails every
    // conditionalBatch — including beginCompletion's own CAS, before any
    // dead-letter attempt is even reachable — so applyTaskResult's
    // {ok: false} propagates all the way to a bare 403.
    class LosesCasStorage extends MemoryStorage {
      override async conditionalBatch(): Promise<boolean> {
        return false;
      }
    }
    const storage = new LosesCasStorage();
    const context = createMinimalContext();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-begin-completion-cas-loss' });

    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-begin-completion-cas-loss',
        workerId: 'longpoll-worker',
        attemptToken: 'attempt-token',
        status: 'completed',
        value: 'ok',
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: 'Forbidden' });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to commit task result for "op-begin-completion-cas-loss" through the durable ledger:',
      ),
      expect.any(String),
    );
    const record = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey('op-begin-completion-cas-loss')),
    );
    expect(record?.state).toBe('leased');
  });

  it('logs and still reports the oversize rejection when persisting the substitute failure result fails outright', async () => {
    // Same LosesCasStorage technique as above, but for the oversized-value
    // branch: the substitute "failed" result's own beginCompletion CAS
    // loses (never reaches dead-lettering), so applyWorkerTaskResult itself
    // returns {ok: false} and the caller-facing 413 comes from a path that
    // logged a persistence failure rather than one that dead-lettered.
    class LosesCasStorage extends MemoryStorage {
      override async conditionalBatch(): Promise<boolean> {
        return false;
      }
    }
    const storage = new LosesCasStorage();
    const context = createMinimalContext();
    setPayloadSizeLimit(context, 64);
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-oversize-rejection-cas-loss' });

    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-oversize-rejection-cas-loss',
        workerId: 'longpoll-worker',
        attemptToken: 'attempt-token',
        status: 'completed',
        value: { blob: 'x'.repeat(200) },
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );

    expect(response?.status).toBe(413);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to persist oversized task result rejection for task "op-oversize-rejection-cas-loss":',
      ),
      expect.any(String),
    );
    const record = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey('op-oversize-rejection-cas-loss')),
    );
    expect(record?.state).toBe('leased');
  });
});

// ---------------------------------------------------------------------------
// WFT-20: long-poll completion is STRICT on workflowRevision — a stored
// ledger record carrying one requires the POST body to echo it back exactly.
// ---------------------------------------------------------------------------
describe('handleTaskResultRequest revision authorization (WFT-20)', () => {
  it('rejects with 403 when the ledger record has a workflowRevision but the POST body omits it', async () => {
    const context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, {
      operationId: 'op-revision-missing',
      workflowRevision: 'revision-expected',
    });

    const request = makePostRequest({
      operationId: 'op-revision-missing',
      workerId: 'longpoll-worker',
      attemptToken: 'attempt-token',
      status: 'completed',
      value: 'done',
    });
    const response = await handleTaskResultRequest(
      context,
      options,
      request,
      makeUrl('/v1/tasks/default/result'),
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: 'Forbidden' });
  });

  it('rejects with 403 when the POST body echoes the wrong workflowRevision', async () => {
    const context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, {
      operationId: 'op-revision-wrong',
      workflowRevision: 'revision-expected',
    });

    const request = makePostRequest({
      operationId: 'op-revision-wrong',
      workerId: 'longpoll-worker',
      attemptToken: 'attempt-token',
      status: 'completed',
      value: 'done',
      workflowRevision: 'revision-wrong',
    });
    const response = await handleTaskResultRequest(
      context,
      options,
      request,
      makeUrl('/v1/tasks/default/result'),
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: 'Forbidden' });
  });

  it('accepts a 200 when the POST body echoes the matching workflowRevision', async () => {
    const context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, {
      operationId: 'op-revision-match',
      workflowRevision: 'revision-expected',
    });

    const request = makePostRequest({
      operationId: 'op-revision-match',
      workerId: 'longpoll-worker',
      attemptToken: 'attempt-token',
      status: 'completed',
      value: 'done',
      workflowRevision: 'revision-expected',
    });
    const response = await handleTaskResultRequest(
      context,
      options,
      request,
      makeUrl('/v1/tasks/default/result'),
    );

    expect(response?.status).toBe(200);
  });

  it('accepts a 200 with no workflowRevision echo when the ledger record has none', async () => {
    const context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-revision-none' });

    const request = makePostRequest({
      operationId: 'op-revision-none',
      workerId: 'longpoll-worker',
      attemptToken: 'attempt-token',
      status: 'completed',
      value: 'done',
    });
    const response = await handleTaskResultRequest(
      context,
      options,
      request,
      makeUrl('/v1/tasks/default/result'),
    );

    expect(response?.status).toBe(200);
  });
});

describe('handleTaskPollRequest', () => {
  it('requires the worker write scope when a principal is present', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const request = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=0', {
      method: 'GET',
    });
    const url = new URL(request.url);

    const response = await handleTaskPollRequest(
      context,
      options,
      request,
      url,
      principalFromApiKey({ subject: 'client-key', scopes: ['workflows:read'] }),
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 503 when startup task-ledger recovery failed', async () => {
    const rejection = Promise.reject(new Error('recovery scan failed'));
    rejection.catch(() => {});
    const context = { ...minimalServerContext(), taskLedgerRecovery: { ready: rejection } };
    const options = minimalServeOptions();
    const request = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=0', {
      method: 'GET',
    });
    const url = new URL(request.url);

    const response = await handleTaskPollRequest(context, options, request, url, WORKER_PRINCIPAL);

    expect(response?.status).toBe(503);
    const body = (await response?.json()) as { error?: string };
    expect(body.error).toContain('Startup task-ledger recovery failed');
    expect(body.error).toContain('recovery scan failed');
  });

  it('threads request.signal into poll so a disconnected client settles with 204', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const controller = new AbortController();

    // Long poll timeout: only the request signal can settle it within the test.
    const request = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=60000', {
      method: 'GET',
      signal: controller.signal,
    });
    const url = new URL(request.url);

    const responsePromise = handleTaskPollRequest(context, options, request, url);
    // Simulate the client disconnecting; the parked waiter must settle with null.
    controller.abort();

    const response = await responsePromise;
    // task === null branch: no task claimed, no worker dispatch.
    expect(response?.status).toBe(204);
  });

  it('returns the generated long-poll workerId with a claimed task', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    expect(
      await dispatchTaskImpl(context, options, {
        operationId: 'op-claim',
        activityName: 'charge',
        workflowType: 'testWorkflow',
        input: { amount: 42 },
      }),
    ).toBe(true);
    const request = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=0', {
      method: 'GET',
    });
    const url = new URL(request.url);

    const response = await handleTaskPollRequest(context, options, request, url, WORKER_PRINCIPAL);

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.workerId).toMatch(/^longpoll-/);
  });

  it('settles with 204 when the durable claim loses the race against a stale in-memory match', async () => {
    const storage = new MemoryStorage();
    const context = minimalServerContext();
    const options = minimalServeOptions(storage);
    expect(
      await dispatchTaskImpl(context, options, {
        operationId: 'op-stale-match',
        activityName: 'charge',
        workflowType: 'testWorkflow',
        input: { amount: 42 },
      }),
    ).toBe(true);

    // Simulate another actor already claiming/purging this operationId
    // between the in-memory TaskQueue match and the durable claim attempt —
    // the ledger record is gone by the time markTaskClaimedByLongPollWorker
    // runs, so the claim's precondition (`current !== null && state ===
    // 'queued'`) fails and the poll must not hand out a task the ledger no
    // longer agrees the worker holds.
    const existing = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-stale-match')));
    if (existing === null || existing.state !== 'queued') {
      throw new Error('Expected op-stale-match to have a queued ledger record');
    }
    await storage.delete(taskLedgerKey('op-stale-match'));

    const request = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=0', {
      method: 'GET',
    });
    const url = new URL(request.url);

    const response = await handleTaskPollRequest(context, options, request, url, WORKER_PRINCIPAL);

    expect(response?.status).toBe(204);
  });

  it('rejects task results that do not match the long-poll in-flight workerId', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    expect(
      await dispatchTaskImpl(context, options, {
        operationId: 'op-owned',
        activityName: 'charge',
        workflowType: 'testWorkflow',
        input: { amount: 42 },
      }),
    ).toBe(true);

    const pollRequest = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=0', {
      method: 'GET',
    });
    const pollResponse = await handleTaskPollRequest(
      context,
      options,
      pollRequest,
      new URL(pollRequest.url),
      WORKER_PRINCIPAL,
    );
    const task = await pollResponse?.json();

    const rejected = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-owned',
        attemptToken: 'attempt-token',
        status: 'completed',
        value: 42,
        workerId: 'longpoll-attacker',
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );

    expect(rejected?.status).toBe(403);

    const accepted = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-owned',
        status: 'completed',
        value: 42,
        workerId: task.workerId,
        attemptToken: task.attemptToken,
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );
    expect(accepted?.status).toBe(200);
  });

  it('rejects an in-flight result that omits the workerId', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    expect(
      await dispatchTaskImpl(context, options, {
        operationId: 'op-missing-worker',
        activityName: 'charge',
        workflowType: 'testWorkflow',
        input: { amount: 42 },
      }),
    ).toBe(true);

    const pollRequest = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=0', {
      method: 'GET',
    });
    await handleTaskPollRequest(
      context,
      options,
      pollRequest,
      new URL(pollRequest.url),
      WORKER_PRINCIPAL,
    );

    // A claimed task has an owner; a result that does not echo the workerId is
    // rejected rather than treated as a wildcard match. Echo the token so the
    // request reaches the ownership guard instead of failing body validation.
    const rejected = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-missing-worker',
        status: 'completed',
        value: 42,
        attemptToken: 'attempt-token',
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );
    expect(rejected?.status).toBe(403);
  });

  it('rejects an in-flight result whose attempt token does not match the claim', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    expect(
      await dispatchTaskImpl(context, options, {
        operationId: 'op-stale-token',
        activityName: 'charge',
        workflowType: 'testWorkflow',
        input: { amount: 42 },
      }),
    ).toBe(true);

    const pollRequest = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=0', {
      method: 'GET',
    });
    const pollResponse = await handleTaskPollRequest(
      context,
      options,
      pollRequest,
      new URL(pollRequest.url),
      WORKER_PRINCIPAL,
    );
    const task = await pollResponse?.json();
    // The poll response carries the per-claim attempt token.
    expect(task.attemptToken).toBeString();

    // Same workerId (passes the ownership guard) but a stale/wrong token — as a
    // re-claimed earlier attempt would echo. The attempt guard rejects it.
    const rejected = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-stale-token',
        status: 'completed',
        value: 42,
        workerId: task.workerId,
        attemptToken: 'stale-token-from-an-earlier-claim',
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );
    expect(rejected?.status).toBe(403);

    // The matching token is accepted.
    const accepted = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-stale-token',
        status: 'completed',
        value: 42,
        workerId: task.workerId,
        attemptToken: task.attemptToken,
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );
    expect(accepted?.status).toBe(200);
  });

  it('rejects a present-but-malformed attemptToken with 400 (not silently treated as absent)', async () => {
    // A present but non-string/empty token is a malformed frame and must be
    // rejected — the same strictness the WebSocket parser applies — so the
    // long-poll transport cannot be coerced into treating `{ attemptToken: 42 }`
    // as an absent echo and bypassing the attempt guard on a token-bearing record.
    const context = minimalServerContext();
    const options = minimalServeOptions();
    expect(
      await dispatchTaskImpl(context, options, {
        operationId: 'op-malformed-token',
        activityName: 'charge',
        workflowType: 'testWorkflow',
        input: { amount: 1 },
      }),
    ).toBe(true);

    const pollRequest = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=0', {
      method: 'GET',
    });
    const pollResponse = await handleTaskPollRequest(
      context,
      options,
      pollRequest,
      new URL(pollRequest.url),
      WORKER_PRINCIPAL,
    );
    const task = await pollResponse?.json();
    expect(task.attemptToken).toBeString();

    for (const malformed of [42, null, '']) {
      const rejected = await handleTaskResultRequest(
        context,
        options,
        makePostRequest({
          operationId: 'op-malformed-token',
          status: 'completed',
          value: 1,
          workerId: task.workerId,
          attemptToken: malformed,
        }),
        makeUrl('/v1/tasks/default/result'),
        WORKER_PRINCIPAL,
      );
      expect(rejected?.status).toBe(400);
      const body = await rejected?.json();
      expect(body.error).toMatch(/attemptToken/);
    }
  });

  it('rejects a matching-workerId completion when the worker omits the echoed token', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    expect(
      await dispatchTaskImpl(context, options, {
        operationId: 'op-omit-echo',
        activityName: 'charge',
        workflowType: 'testWorkflow',
        input: { amount: 42 },
      }),
    ).toBe(true);

    const pollRequest = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=0', {
      method: 'GET',
    });
    const pollResponse = await handleTaskPollRequest(
      context,
      options,
      pollRequest,
      new URL(pollRequest.url),
      WORKER_PRINCIPAL,
    );
    const task = await pollResponse?.json();
    // The record carries a token, and the claim never hands out an empty one.
    expect(task.attemptToken).toBeString();
    expect(task.attemptToken.length).toBeGreaterThan(0);

    const rejected = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-omit-echo',
        status: 'completed',
        value: 42,
        workerId: task.workerId,
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );
    expect(rejected?.status).toBe(400);
  });

  // Renamed from "accepts a result with no in-flight record without an
  // ownership check": the ledger cutover changed this response shape
  // deliberately. The old `op:inflight:` system tolerated a completion for
  // an unknown/already-resolved operationId as a silent no-op returning
  // success; the durable ledger's single authoritative key removes the
  // ambiguity that made "absent" a plausible stand-in for "already resolved
  // elsewhere" — see `isLongPollCompletionAuthorized`'s doc comment in
  // task-polling.ts, which cites the project brief's failure matrix: "Result
  // arrives for unknown operation -> Rejected."
  it('rejects a task result for an operation with no ledger record — unknown operations reject, not no-op', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();

    // No task was ever claimed, so there is no ledger record to own.
    const response = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-never-claimed',
        attemptToken: 'attempt-token',
        status: 'completed',
        value: 42,
        workerId: 'longpoll-whatever',
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );
    expect(response?.status).toBe(403);
  });

  // COR-233 item 2: a `queued` record has no current attempt either — it was
  // never claimed by anyone (or was requeued after a previous attempt), so
  // there is no worker/attempt identity to authorize against. Same rejection
  // shape as no record at all, not a tolerant no-op.
  it('rejects a task result for an operation whose ledger record is still queued', async () => {
    const context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    const now = Date.now();
    await storage.put(
      taskLedgerKey('op-queued'),
      encodeRemoteTaskRecord({
        recordVersion: 1,
        operationId: 'op-queued',
        workflowType: 'testWorkflow',
        activityName: 'charge',
        queue: 'default',
        input: null,
        headers: {},
        visibilityTimeoutMilliseconds: 30_000,
        createdAt: now,
        generation: 1,
        state: 'queued',
        attempt: 0,
        availableAt: now,
        firstQueuedAt: now,
        lastQueuedAt: now,
        retryCount: 0,
        requeueCount: 0,
      }),
    );

    const response = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-queued',
        workerId: 'longpoll-worker',
        attemptToken: 'attempt-token',
        status: 'completed',
        value: 42,
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );
    expect(response?.status).toBe(403);
    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-queued')));
    expect(record?.state).toBe('queued');
  });

  // COR-233 item 3: `isLongPollCompletionAuthorized` used to require
  // `record.state` to still be `leased`/`completing`, which meant a resend of
  // an already-resolved result — the same content, same attemptToken, after
  // the worker never received the first `{ ok: true, disposition: 'applied' }`
  // response — was rejected with 403 instead of reaching
  // `commitTaskLedgerCompletion`'s idempotent `duplicate` handling. The
  // shared `authorizeTaskResultForCurrentAttempt` decision now authorizes a
  // resend against a `terminal` record by attempt token alone (the only
  // identity a resolved record still carries), so the resend is accepted and
  // answered `duplicate` without writing a second terminal record.
  it('accepts a resend of an already-resolved result and answers duplicate without a second terminal write (COR-233)', async () => {
    const context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-resend' });

    const request = () =>
      makePostRequest({
        operationId: 'op-resend',
        workerId: 'longpoll-worker',
        attemptToken: 'attempt-token',
        status: 'completed',
        value: 42,
      });

    const first = await handleTaskResultRequest(context, options, request(), makeUrl());
    expect(first?.status).toBe(200);
    expect(await first?.json()).toEqual({ ok: true, disposition: 'applied' });
    const resolved = await readResolvedTerminalRecord(storage, 'op-resend');

    const second = await handleTaskResultRequest(context, options, request(), makeUrl());
    expect(second?.status).toBe(200);
    expect(await second?.json()).toEqual({ ok: true, disposition: 'duplicate' });

    const afterResend = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-resend')));
    expect(afterResend?.state).toBe('terminal');
    expect(afterResend?.generation).toBe(resolved.generation);
  });
});
