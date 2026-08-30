/**
 * Characterization tests for handleTaskResultRequest.
 *
 * These tests assert the HTTP response shapes the function returns for every
 * valid and invalid input combination so the refactor cannot silently change
 * those contract shapes. Migrated off the retired `op:queued:`/`op:inflight:`/
 * `op:resolved:`/`op:dead-letter:` keys onto the durable `task-ledger:` record
 * (WFT-22) — fixtures now write real ledger records instead of the deleted
 * `markInflight`. Two shapes deliberately changed across the cutover, not a
 * migration artifact: a completion for an operation with no ledger record now
 * returns 403 instead of a tolerant 200 no-op, and a terminal-commit
 * persistence failure now returns 403 instead of a tolerant 200 (see
 * `isLongPollCompletionAuthorized`'s and `task-ledger-completion.ts`'s doc
 * comments). Both are pinned below rather than silently dropped.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import type { TaskResultDeadLetteredEvent } from '../../core/events.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { principalFromApiKey } from '../principal.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  isRemoteTaskTerminalResolved,
  taskLedgerKey,
  type RemoteTaskLeased,
  type RemoteTaskTerminalResolved,
} from '../task-ledger.ts';
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

function makeUrl(path = '/v1/tasks/op-123/result'): URL {
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
    await expect(response?.json()).resolves.toEqual({ error: 'Payload Too Large' });
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
    expect(body).toEqual({ ok: true });
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
    expect(body).toEqual({ ok: true });
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
      makeUrl('/v1/tasks/op-oversize-http/result'),
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
      makeUrl('/v1/tasks/op-oversize-http-failure/result'),
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
      makeUrl('/v1/tasks/op-failure-size-boundary/result'),
      WORKER_PRINCIPAL,
    );

    expect(response?.status).toBe(200);
    const resolved = await readResolvedTerminalRecord(storage, 'op-failure-size-boundary');
    expect(resolved.status).toBe('failed');
    expect(resolved.error).toBe('12345678');
  });

  // Renamed from "logs and still returns 200 when resolved-result persistence
  // fails": the ledger cutover changed this response shape deliberately, not
  // as a migration artifact. `handleTaskResultRequest` now returns 403 (not a
  // tolerant 200) whenever `commitTaskLedgerCompletion` itself fails — see
  // the doc comment on `applyTaskResult`'s caller in task-polling.ts.
  it('logs, dead-letters, and returns 403 when the terminal ledger commit cannot be persisted', async () => {
    const storage = new FailingTerminalCommitStorage('op-resolved-write-fails');
    const context = createMinimalContext();
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-resolved-write-fails' });
    using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
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
      makeUrl('/v1/tasks/op-resolved-write-fails/result'),
      WORKER_PRINCIPAL,
    );

    expect(response?.status).toBe(403);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[weft] Failed to commit task result for "op-resolved-write-fails" through the durable ledger:',
      'lost the compare-and-swap race on operation "op-resolved-write-fails" after 3 attempt(s)',
    );

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

  it('logs when persisting an oversized-result rejection fails', async () => {
    const storage = new FailingTerminalCommitStorage('op-oversize-rejection-write-fails');
    const context = createMinimalContext();
    setPayloadSizeLimit(context, 64);
    const options = createMinimalOptions(storage);
    await writeLeasedRecord(storage, { operationId: 'op-oversize-rejection-write-fails' });
    using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

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
      makeUrl('/v1/tasks/op-oversize-rejection-write-fails/result'),
      WORKER_PRINCIPAL,
    );

    expect(response?.status).toBe(413);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[weft] Failed to persist oversized task result rejection for task "op-oversize-rejection-write-fails":',
      'lost the compare-and-swap race on operation "op-oversize-rejection-write-fails" after 3 attempt(s)',
    );
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
      makeUrl('/v1/tasks/op-tracked/result'),
    );

    expect(response?.status).toBe(200);
    expect(context.deadlineTracker.size).toBe(0);
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
});
