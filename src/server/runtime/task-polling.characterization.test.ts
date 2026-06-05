/**
 * Characterization tests for handleTaskResultRequest.
 *
 * These tests assert the HTTP response shapes the function returns for every
 * valid and invalid input combination so the refactor cannot silently change
 * those contract shapes.
 */

import { describe, expect, it } from 'bun:test';

import { principalFromApiKey } from '../principal.ts';
import { transitionQueuedToInflight } from '../task-state.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { handleTaskPollRequest, handleTaskResultRequest } from './task-polling.ts';

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

  it('authorizes a matching-workerId completion against a token-less in-flight record', async () => {
    // Backward-compat: an in-flight record written before the attempt-token field
    // existed carries no token. A completion that echoes the correct workerId must
    // still be accepted — the attempt guard is skipped when there is no stored
    // token to compare against, so an in-flight upgrade does not strand work.
    const options = minimalServeOptions();
    const context = minimalServerContext();

    await transitionQueuedToInflight(options.engine.storage, 'op-legacy', {
      operationId: 'op-legacy',
      workerId: 'longpoll-legacy',
      deadline: Date.now() + 30_000,
      activityName: 'charge',
      queue: 'default',
      input: { amount: 42 },
      attempt: 1,
      visibilityTimeout: 30_000,
      // No attemptToken — simulates a record persisted before the field existed.
    });

    const accepted = await handleTaskResultRequest(
      context,
      options,
      makePostRequest({
        operationId: 'op-legacy',
        status: 'completed',
        value: 42,
        workerId: 'longpoll-legacy',
        // The worker echoes a token, but the token-less record accepts any.
        attemptToken: 'token-the-record-never-stored',
      }),
      makeUrl('/v1/tasks/default/result'),
      WORKER_PRINCIPAL,
    );
    expect(accepted?.status).toBe(200);
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
