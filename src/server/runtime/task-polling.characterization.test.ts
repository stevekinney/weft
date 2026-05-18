/**
 * Characterization tests for handleTaskResultRequest.
 *
 * These tests assert the HTTP response shapes the function returns for every
 * valid and invalid input combination so the refactor cannot silently change
 * those contract shapes.
 */

import { describe, expect, it } from 'bun:test';

import { MetricsCollector } from '../../observability/metrics.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { DeadlineTracker } from '../deadline-tracker.ts';
import { TaskQueue } from '../task-queue.ts';
import { handleTaskResultRequest } from './task-polling.ts';

import type { ServerContext } from './context.ts';

function createMinimalContext(): ServerContext {
  return {
    registry: null as never,
    taskQueue: new TaskQueue(),
    workerSockets: new Map(),
    streamSockets: new Map(),
    workerAffinity: new Map(),
    workflowOperations: new Map(),
    operationToWorkflow: new Map(),
    pendingTimers: new Set(),
    deadlineTracker: new DeadlineTracker(),
    liveOperationRegistry: null as never,
    liveRestBindings: null as never,
    supportedAuthenticationSchemes: new Set() as never,
    metricsCollector: new MetricsCollector(),
    eventFeedBackend: null as never,
    workflowEventFeed: null as never,
    activeJsonRpcSessions: new Set(),
    mcpSessionManager: null as never,
    authenticatorPromise: null,
    visibilityPollMs: 5000,
    scanRunning: false,
    processingOperations: new Set(),
    reconciliationRunning: false,
  };
}

function createMinimalOptions(storage = new MemoryStorage()) {
  return {
    engine: { storage },
    port: 0,
  } as never;
}

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
