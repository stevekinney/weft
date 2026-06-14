/**
 * Characterization tests for handleTaskResultRequest.
 *
 * These tests assert the HTTP response shapes the function returns for every
 * valid and invalid input combination so the refactor cannot silently change
 * those contract shapes.
 */

import { describe, expect, it } from 'bun:test';

import { decode } from '../../core/codec.ts';
import { KEYS, type BatchOperation } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { principalFromApiKey } from '../principal.ts';
import { markInflight, type InflightRecord, type ResolvedRecord } from '../task-state.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { handleTaskPollRequest, handleTaskResultRequest } from './task-polling.ts';
import { transitionTaskResultToResolvedWithRetry } from './task-result-resolution.ts';

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

function makeInflightRecord(operationId: string): InflightRecord {
  return {
    operationId,
    workerId: 'longpoll-worker',
    deadline: Date.now() + 30_000,
    activityName: 'charge',
    queue: 'default',
    input: null,
    attempt: 1,
    visibilityTimeout: 30_000,
    attemptToken: 'attempt-token',
  };
}

class FailingTaskResultResolutionStorage extends MemoryStorage {
  override async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.some((operation) => operation.key.startsWith('op:resolved:'))) {
      throw new Error('resolved write failed');
    }
    await super.batch(operations);
  }

  override async put(key: string, value: Uint8Array): Promise<void> {
    if (key.startsWith('op:dead-letter:')) {
      throw new Error('dead-letter write failed');
    }
    await super.put(key, value);
  }
}

async function readResolvedRecord(
  storage: MemoryStorage,
  operationId: string,
): Promise<ResolvedRecord> {
  const bytes = await storage.get(KEYS.operationResolved(operationId));
  expect(bytes).not.toBeNull();
  return decode(bytes!) as ResolvedRecord;
}

describe('handleTaskResultRequest', () => {
  it('returns null for non-POST requests', async () => {
    const context = createMinimalContext();
    const options = createMinimalOptions();
    const request = new Request('http://localhost/v1/tasks/op-1/result', { method: 'GET' });
    const result = await handleTaskResultRequest(context, options, request, makeUrl());
    expect(result).toBeNull();
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
    const options = createMinimalOptions();
    const request = makePostRequest({ operationId: 'op-1', status: 'completed', value: 42 });
    const response = await handleTaskResultRequest(context, options, request, makeUrl());
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ ok: true });
  });

  it('returns 200 ok for a valid failed result', async () => {
    const context = createMinimalContext();
    const options = createMinimalOptions();
    const request = makePostRequest({
      operationId: 'op-2',
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
    await markInflight(storage, makeInflightRecord('op-oversize-http'));

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
    expect(await storage.get(KEYS.operationInflight('op-oversize-http'))).toBeNull();

    const resolved = await readResolvedRecord(storage, 'op-oversize-http');
    expect(resolved.status).toBe('failed');
    expect(resolved.error).toContain('activity result exceeds');
    expect(resolved.value).toBeUndefined();
  });

  it('rejects oversized failure errors and resolves the long-poll task as failed', async () => {
    const storage = new MemoryStorage();
    const context = createMinimalContext();
    setPayloadSizeLimit(context, 64);
    const options = createMinimalOptions(storage);
    await markInflight(storage, makeInflightRecord('op-oversize-http-failure'));

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

    const resolved = await readResolvedRecord(storage, 'op-oversize-http-failure');
    expect(resolved.status).toBe('failed');
    expect(resolved.error).toContain('activity result exceeds');
    expect(resolved.error).not.toContain('x'.repeat(100));
  });

  it('measures failed-result payload size against the persisted error string', async () => {
    const storage = new MemoryStorage();
    const context = createMinimalContext();
    setPayloadSizeLimit(context, 10);
    const options = createMinimalOptions(storage);
    await markInflight(storage, makeInflightRecord('op-failure-size-boundary'));

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
    const resolved = await readResolvedRecord(storage, 'op-failure-size-boundary');
    expect(resolved.status).toBe('failed');
    expect(resolved.error).toBe('12345678');
  });

  it('does not throw when dead-letter persistence fails after result-resolution retries', async () => {
    const storage = new FailingTaskResultResolutionStorage();
    const context = createMinimalContext();
    const options = createMinimalOptions(storage);
    await markInflight(storage, makeInflightRecord('op-dead-letter-write-fails'));

    await expect(
      transitionTaskResultToResolvedWithRetry(context, options, {
        operationId: 'op-dead-letter-write-fails',
        status: 'completed',
        resolutionReason: 'completed',
        value: 'done',
      }),
    ).resolves.toBeUndefined();

    expect(await storage.get(KEYS.operationInflight('op-dead-letter-write-fails'))).not.toBeNull();
    expect(await storage.get(KEYS.operationDeadLetter('op-dead-letter-write-fails'))).toBeNull();
  });

  it('removes the deadline tracker entry on success', async () => {
    const context = createMinimalContext();
    const options = createMinimalOptions();

    context.deadlineTracker.add({ operationId: 'op-tracked', deadline: Date.now() + 30_000 });
    expect(context.deadlineTracker.size).toBe(1);

    const request = makePostRequest({ operationId: 'op-tracked', status: 'completed' });
    await handleTaskResultRequest(
      context,
      options,
      request,
      makeUrl('/v1/tasks/op-tracked/result'),
    );

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
    context.taskQueue.enqueue('default', {
      operationId: 'op-claim',
      activityName: 'charge',
      input: { amount: 42 },
    });
    const request = new Request('http://localhost/v1/tasks/default?activity=charge&timeout=0', {
      method: 'GET',
    });
    const url = new URL(request.url);

    const response = await handleTaskPollRequest(context, options, request, url, WORKER_PRINCIPAL);

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.workerId).toMatch(/^longpoll-/);
  });

  it('rejects task results that do not match the long-poll in-flight workerId', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    context.taskQueue.enqueue('default', {
      operationId: 'op-owned',
      activityName: 'charge',
      input: { amount: 42 },
    });

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
    context.taskQueue.enqueue('default', {
      operationId: 'op-missing-worker',
      activityName: 'charge',
      input: { amount: 42 },
    });

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
    // rejected rather than treated as a wildcard match.
    const rejected = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({ operationId: 'op-missing-worker', status: 'completed', value: 42 }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );
    expect(rejected?.status).toBe(403);
  });

  it('rejects an in-flight result whose attempt token does not match the claim', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    context.taskQueue.enqueue('default', {
      operationId: 'op-stale-token',
      activityName: 'charge',
      input: { amount: 42 },
    });

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
    context.taskQueue.enqueue('default', {
      operationId: 'op-malformed-token',
      activityName: 'charge',
      input: { amount: 1 },
    });

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
    context.taskQueue.enqueue('default', {
      operationId: 'op-omit-echo',
      activityName: 'charge',
      input: { amount: 42 },
    });

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
    expect(rejected?.status).toBe(403);
  });

  it('accepts a result with no in-flight record without an ownership check', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();

    // No task was ever claimed, so there is no in-flight record to own. The
    // completion lands as a no-op on already-settled/unknown work; the ownership
    // guard is intentionally skipped because there is no owner to match against.
    const response = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-never-claimed',
        status: 'completed',
        value: 42,
        workerId: 'longpoll-whatever',
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );
    expect(response?.status).toBe(200);
  });
});
