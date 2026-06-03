import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { query, workflow } from '../core/types.ts';
import { handleRequest } from '../server/handler.ts';
import { serve, type WeftServer } from '../server/index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  CONTRACT_PAYLOAD_CAP_BYTES,
  nextAsyncPendingToken,
} from '../testing/async-activity.test-support.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import {
  clientContractAsyncActivityWorkflow,
  clientContractEchoWorkflow,
  clientContractWaitingObjectWorkflow,
  clientContractWaitingTwiceWorkflow,
  clientContractWaitingWorkflow,
  runWeftClientContractTests,
  waitForQueryReadyForTesting,
} from './client-contract.test-support.ts';
import { FakeWebSocketServer } from './event-stream.test-support.ts';
import { HttpClient, HttpClientError } from './index.ts';
import type { WeftClient } from './interface.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

const clientContractSearchAttributesWorkflow = workflow({
  name: 'client-contract-search-attributes',
})
  .searchAttributes({
    customerId: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  })
  .execute(async function* (ctx: WorkflowContext, input: unknown) {
    ctx.expose({ ready: () => true });
    ctx.onQuery('echoInput', (queryInput) => queryInput);
    ctx.onUpdate('rename', (payload) => ({
      accepted: true,
      input,
      payload,
    }));

    const signal = yield* ctx.waitForSignal<string>('continue');
    return `${String(input)}:${signal}`;
  });

function requestInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

type FetchCall = { url: string; init: RequestInit | undefined };

function createFullSurfaceResponses(
  jsonResponse: (body: unknown, status?: number) => Response,
): Response[] {
  return [
    jsonResponse({ id: 'wf-1' }),
    jsonResponse({ result: 'hello' }),
    jsonResponse({ id: 'schedule-1' }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    jsonResponse({
      id: 'schedule-1',
      workflowType: 'echo',
      cronExpression: '0 * * * *',
      status: 'active',
      overlap: 'queue',
      backfill: true,
      createdAt: 1,
      updatedAt: 1,
      nextFireAt: 2,
      queuedRuns: 0,
    }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    jsonResponse({ result: 'handle-update' }),
    jsonResponse({ result: 'handle-query' }),
    jsonResponse({
      id: 'schedule-1',
      workflowType: 'echo',
      cronExpression: '0 * * * *',
      status: 'active',
      overlap: 'queue',
      backfill: true,
      createdAt: 1,
      updatedAt: 1,
      nextFireAt: 2,
      queuedRuns: 0,
    }),
    jsonResponse({ priority: 'high' }),
    new Response(null, { status: 204 }),
    jsonResponse({ id: 'wf-1', status: 'running' }),
    jsonResponse({
      items: [
        {
          id: 'schedule-1',
          workflowType: 'echo',
          cronExpression: '0 * * * *',
          status: 'active',
          overlap: 'queue',
          backfill: true,
          createdAt: 1,
          updatedAt: 1,
          nextFireAt: 2,
          queuedRuns: 0,
        },
      ],
      total: 1,
      offset: 0,
      limit: 100,
    }),
    jsonResponse({ items: [], total: 0 }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    jsonResponse({ result: 'client-query' }),
    jsonResponse({ result: 'client-update' }),
    jsonResponse({ id: 'wf-2' }),
    jsonResponse({ recovered: ['wf-3', 'wf-4'] }),
    new Response(null, { status: 204 }),
    jsonResponse({ priority: 'high' }),
    new Response(null, { status: 204 }),
    jsonResponse({ events: [{ type: 'workflow:started' }] }),
    jsonResponse({
      items: [
        {
          status: 'pending',
          reviewId: 'review-1',
          workflowId: 'wf-review-1',
          artifact: null,
          reviewType: 'general',
          reviewers: [],
          allowPartial: false,
          createdAt: 1,
        },
      ],
    }),
    new Response(null, { status: 204 }),
    jsonResponse({
      chunks: [
        { sequence: 2, value: 'chunk-a' },
        { sequence: 3, value: 'chunk-b' },
      ],
    }),
    jsonResponse({ id: 'wf-forked' }),
    jsonResponse({ updateId: 'update-1', result: 'accepted' }),
    jsonResponse({ status: 'completed', result: 'done', error: 'warn' }),
  ];
}

async function exerciseWorkflowHandleAndSchedule(httpClient: HttpClient): Promise<void> {
  const handle = await httpClient.start('echo', 'hello', { id: 'wf/1', executionTimeout: '5m' });
  expect(handle.id).toBe('wf-1');
  expect(await handle.result()).toBe('hello');

  const scheduleHandle = await httpClient.schedule('echo', 'hourly', '0 * * * *', {
    id: 'schedule-1',
    overlap: 'queue',
    backfill: true,
  });
  expect(scheduleHandle.id).toBe('schedule-1');

  await scheduleHandle.pause();
  await scheduleHandle.resume();
  await scheduleHandle.update('30 * * * *');
  expect(await scheduleHandle.describe()).toEqual(
    expect.objectContaining({
      id: 'schedule-1',
      cronExpression: '0 * * * *',
    }),
  );
  await scheduleHandle.cancel();

  await handle.cancel();
  await handle.signal('status', { ok: true });
  expect(await handle.update('rename', { value: 1 }, { timeout: 50 })).toBe('handle-update');
  expect(await handle.query('status')).toBe('handle-query');
  expect(await httpClient.getSchedule('schedule-1')).toEqual(
    expect.objectContaining({
      id: 'schedule-1',
      cronExpression: '0 * * * *',
    }),
  );
  expect(await handle.getAttributes()).toEqual({ priority: 'high' });
  await handle.setAttributes({ priority: 'critical' });
}

async function exerciseWorkflowClientRequests(httpClient: HttpClient): Promise<void> {
  expect(await httpClient.get('wf/1')).toMatchObject({ id: 'wf-1', status: 'running' });
  expect(
    await httpClient.listSchedules({ status: 'active', workflowType: 'echo', limit: 5, offset: 0 }),
  ).toMatchObject({
    items: [{ id: 'schedule-1' }],
    total: 1,
  });
  await httpClient.list({
    status: ['running', 'completed'],
    type: 'echo',
    limit: 5,
    offset: 2,
    attributes: [
      { key: 'priority', value: 'high' },
      { key: 'priority', gt: 1, lt: 9, gte: 2, lte: 8 },
    ],
  });
  await httpClient.cancel('wf/1');
  await httpClient.pauseSchedule('schedule-1');
  await httpClient.resumeSchedule('schedule-1');
  await httpClient.updateSchedule('schedule-1', '15 * * * *');
  await httpClient.cancelSchedule('schedule-1');
  await httpClient.signal('wf/1', 'status', { ok: true });
  expect(await httpClient.query('wf/1', 'status')).toBe('client-query');
  expect(await httpClient.update('wf/1', 'rename', { value: 2 }, { timeout: 10 })).toBe(
    'client-update',
  );
}

async function exerciseRecoveryAndReviewRequests(httpClient: HttpClient): Promise<void> {
  const resumed = await httpClient.resume('wf/1');
  expect(resumed.id).toBe('wf-2');

  const recovered = await httpClient.recoverAll();
  expect(recovered.map((recoveredHandle) => recoveredHandle.id)).toEqual(['wf-3', 'wf-4']);

  await httpClient.timeout('wf/1');
  expect(await httpClient.getAttributes('wf/1')).toEqual({ priority: 'high' });
  await httpClient.setAttributes('wf/1', { priority: 'critical' });
  expect(await httpClient.getEvents('wf/1')).toMatchObject([{ type: 'workflow:started' }]);
  expect(await httpClient.listReviews()).toEqual([
    {
      status: 'pending',
      reviewId: 'review-1',
      workflowId: 'wf-review-1',
      artifact: null,
      reviewType: 'general',
      reviewers: [],
      allowPartial: false,
      createdAt: 1,
    },
  ]);
  await httpClient.submitReview('review-1', { decision: 'approved', reviewer: 'alex' });
  expect(await httpClient.getStreamChunks('wf/1', 'stream/key', { after: 1 })).toEqual([
    { sequence: 2, value: 'chunk-a' },
    { sequence: 3, value: 'chunk-b' },
  ]);

  const forked = await httpClient.fork('wf/1', { fromStep: 2 });
  expect(forked.id).toBe('wf-forked');
  expect(
    await httpClient.submitCoordinatedUpdate(
      'wf/1',
      'rename',
      { value: 3 },
      {
        timeout: 20,
        idempotencyKey: 'idempotent-1',
      },
    ),
  ).toEqual({ updateId: 'update-1', result: 'accepted' });
  expect(await httpClient.getUpdateResult('update-1')).toEqual({
    updateId: 'update-1',
    result: 'done',
    error: 'warn',
  });
}

async function exerciseBulkWorkflowClientRequests(httpClient: HttpClient): Promise<void> {
  expect(await httpClient.cancelAll({ status: 'running', tags: ['nightly'] })).toEqual({
    cancelled: 2,
    failed: 1,
    errors: [{ id: 'wf-failed', error: 'boom' }],
  });
  expect(await httpClient.signalAll({ tags: ['nightly'] }, 'continue', { ok: true })).toEqual({
    signalled: 3,
    failed: 0,
  });
  expect(await httpClient.deleteAll({ status: 'completed' })).toEqual({ deleted: 4 });
  expect(await httpClient.tagAll({ tags: ['nightly'] }, ['bulk'])).toEqual({ modified: 5 });
  expect(await httpClient.untagAll({ tags: ['bulk'] }, ['nightly'])).toEqual({ modified: 2 });
}

function expectStringRequestBody(body: RequestInit['body']): string {
  expect(typeof body).toBe('string');
  if (typeof body !== 'string') {
    throw new Error('Expected request body to be a JSON string');
  }

  return body;
}

function assertBulkWorkflowRequestCalls(fetchCalls: FetchCall[]): void {
  const expectedCalls = [
    {
      url: 'http://example.test/v1/workflows/bulk/cancel',
      method: 'POST',
      body: { filter: { status: 'running', tags: ['nightly'] } },
    },
    {
      url: 'http://example.test/v1/workflows/bulk/signal',
      method: 'POST',
      body: {
        filter: { tags: ['nightly'] },
        name: 'continue',
        payload: { ok: true },
      },
    },
    {
      url: 'http://example.test/v1/workflows/bulk',
      method: 'DELETE',
      body: { filter: { status: 'completed' } },
    },
    {
      url: 'http://example.test/v1/workflows/bulk/tags',
      method: 'PATCH',
      body: { filter: { tags: ['nightly'] }, tags: ['bulk'], operation: 'add' },
    },
    {
      url: 'http://example.test/v1/workflows/bulk/tags',
      method: 'PATCH',
      body: { filter: { tags: ['bulk'] }, tags: ['nightly'], operation: 'remove' },
    },
  ] as const;

  expect(fetchCalls).toHaveLength(expectedCalls.length);

  for (const [index, expectedCall] of expectedCalls.entries()) {
    const actualCall = fetchCalls[index];
    expect(actualCall?.url).toBe(expectedCall.url);
    expect(actualCall?.init?.method).toBe(expectedCall.method);
    expect(JSON.parse(expectStringRequestBody(actualCall?.init?.body))).toEqual(expectedCall.body);
  }
}

function assertWorkflowStartCall(fetchCalls: FetchCall[]): void {
  const startCall = fetchCalls[0]!;
  expect(startCall.url).toBe('http://example.test/v1/workflows');
  expect(startCall.init?.method).toBe('POST');
  expect(new Headers(startCall.init?.headers).get('Authorization')).toBe('Bearer token');
  expect(new Headers(startCall.init?.headers).get('Content-Type')).toBe('application/json');

  const startBody = startCall.init?.body;
  expect(typeof startBody).toBe('string');
  if (typeof startBody !== 'string') {
    throw new Error('Expected start request body to be a string');
  }

  expect(JSON.parse(startBody)).toEqual({
    type: 'echo',
    input: 'hello',
    id: 'wf/1',
    executionTimeout: '5m',
  });
}

function assertScheduleCalls(fetchCalls: FetchCall[]): void {
  const scheduleCreateCall = fetchCalls[2]!;
  expect(scheduleCreateCall.url).toBe('http://example.test/v1/schedules');
  expect(scheduleCreateCall.init?.method).toBe('POST');

  const scheduleCreateBody = scheduleCreateCall.init?.body;
  expect(typeof scheduleCreateBody).toBe('string');
  if (typeof scheduleCreateBody !== 'string') {
    throw new Error('Expected schedule request body to be a string');
  }

  expect(JSON.parse(scheduleCreateBody)).toEqual({
    type: 'echo',
    input: 'hourly',
    cronExpression: '0 * * * *',
    id: 'schedule-1',
    overlap: 'queue',
    backfill: true,
  });

  const scheduleListCall = fetchCalls[16]!;
  const scheduleListUrl = new URL(scheduleListCall.url);
  expect(scheduleListUrl.searchParams.get('status')).toBe('active');
  expect(scheduleListUrl.searchParams.get('workflowType')).toBe('echo');
  expect(scheduleListUrl.searchParams.get('limit')).toBe('5');
  expect(scheduleListUrl.searchParams.get('offset')).toBe('0');
}

function assertFilterAndFollowupCalls(fetchCalls: FetchCall[]): void {
  const listCall = fetchCalls[17]!;
  const listUrl = new URL(listCall.url);
  expect(listUrl.searchParams.getAll('status')).toEqual(['running', 'completed']);
  expect(listUrl.searchParams.get('type')).toBe('echo');
  expect(listUrl.searchParams.get('limit')).toBe('5');
  expect(listUrl.searchParams.get('offset')).toBe('2');
  expect(listUrl.searchParams.get('attr.priority')).toBe('high');
  expect(listUrl.searchParams.get('attr.priority.gt')).toBe('1');
  expect(listUrl.searchParams.get('attr.priority.lt')).toBe('9');
  expect(listUrl.searchParams.get('attr.priority.gte')).toBe('2');
  expect(listUrl.searchParams.get('attr.priority.lte')).toBe('8');

  expect(fetchCalls[3]?.url).toContain('/schedules/schedule-1/pause');
  expect(fetchCalls[4]?.url).toContain('/schedules/schedule-1/resume');
  expect(fetchCalls[5]?.init?.method).toBe('PATCH');
  expect(fetchCalls[7]?.init?.method).toBe('DELETE');
  expect(fetchCalls[8]?.init?.method).toBe('DELETE');
  expect(fetchCalls[9]?.url).toContain('/signal/status');
  expect(fetchCalls[10]?.url).toContain('/update/rename');
  expect(fetchCalls[26]?.url).toContain('/resume');
  expect(fetchCalls[27]?.url).toBe('http://example.test/v1/recover');
  expect(fetchCalls[34]?.url).toContain('/streams/stream%2Fkey?after=1');
}

function assertForkCall(fetchCalls: FetchCall[]): void {
  expect(fetchCalls[35]?.url).toBe('http://example.test/v1/workflows/wf%2F1/fork');
  expect(fetchCalls[35]?.init?.method).toBe('POST');

  const forkBody = fetchCalls[35]?.init?.body;
  expect(typeof forkBody).toBe('string');
  if (typeof forkBody !== 'string') {
    throw new Error('Expected fork request body to be a string');
  }

  expect(JSON.parse(forkBody)).toEqual({ fromStep: 2 });
}

// A static API key whose principal carries the scopes the streaming
// subscription (`workflows:read`) and the REST surface need. The same
// `Authorization: Bearer` header flows through both `fetch` and the WebSocket
// upgrade, so live event streaming authenticates over the real `serve()` stack.
const CONTRACT_API_KEY = 'http-client-contract-key';

let engine: Engine;
let server: WeftServer;
let client: WeftClient;

beforeAll(() => {
  engine = new Engine({
    storage: new MemoryStorage(),
    payloadSize: { maxBytes: CONTRACT_PAYLOAD_CAP_BYTES },
  });
  engine.register(echoWorkflow);
  engine.register(clientContractEchoWorkflow);
  engine.register(clientContractWaitingObjectWorkflow);
  engine.register(clientContractWaitingWorkflow);
  engine.register(clientContractWaitingTwiceWorkflow);
  engine.register(clientContractAsyncActivityWorkflow);
  engine.register(clientContractSearchAttributesWorkflow);

  // Use the full `serve()` stack (not a bare `Bun.serve({ fetch })`) so the
  // JSON-RPC WebSocket subscription handler is wired and `HttpClient` streaming
  // works end-to-end against a real server.
  server = serve({
    engine,
    port: 0, // random available port
    auth: {
      apiKeys: [CONTRACT_API_KEY],
      defaultApiKeyScopes: ['reviews:read', 'system:read', 'workflows:read'],
    },
  });

  client = new HttpClient({
    baseUrl: server.url,
    headers: { Authorization: `Bearer ${CONTRACT_API_KEY}` },
  });
});

afterAll(async () => {
  await server.stop();
  await engine[Symbol.asyncDispose]();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HttpClient', () => {
  runWeftClientContractTests({
    label: 'HttpClient',
    getClient: () => client,
    idPrefix: 'http-client-contract',
    workflowTypes: {
      echo: 'client-contract-echo',
      waiting: 'client-contract-waiting',
      waitingObject: 'client-contract-waiting-object',
      waitingTwice: 'client-contract-waiting-twice',
      asyncActivity: 'client-contract-async-activity',
    },
    captureNextAsyncToken: () => nextAsyncPendingToken(engine),
    asyncResultCapBytes: CONTRACT_PAYLOAD_CAP_BYTES,
    expectTokenNotFound: (error) => {
      expect(error).toBeInstanceOf(HttpClientError);
      expect((error as HttpClientError).status).toBe(404);
    },
  });

  it('implements WeftClient', () => {
    expect(client.start).toBeFunction();
    expect(client.schedule).toBeFunction();
    expect(client.get).toBeFunction();
    expect(client.getSchedule).toBeFunction();
    expect(client.list).toBeFunction();
    expect(client.listSchedules).toBeFunction();
    expect(client.cancel).toBeFunction();
    expect(client.pauseSchedule).toBeFunction();
    expect(client.resumeSchedule).toBeFunction();
    expect(client.cancelSchedule).toBeFunction();
    expect(client.updateSchedule).toBeFunction();
    expect(client.signal).toBeFunction();
    expect(client.query).toBeFunction();
    expect(client.update).toBeFunction();
    expect(client.resume).toBeFunction();
    expect(client.recoverAll).toBeFunction();
    expect(client.timeout).toBeFunction();
    expect(client.getAttributes).toBeFunction();
    expect(client.setAttributes).toBeFunction();
    expect(client.getEvents).toBeFunction();
    expect(client.getTimeline).toBeFunction();
    expect(client.replayTo).toBeFunction();
    expect(client.listReviews).toBeFunction();
    expect(client.submitReview).toBeFunction();
    expect(client.getStreamChunks).toBeFunction();
    expect(client.fork).toBeFunction();
    expect(client.getRetentionOverview).toBeFunction();
    expect(client.purge).toBeFunction();
    expect(client.cancelAll).toBeFunction();
    expect(client.signalAll).toBeFunction();
    expect(client.deleteAll).toBeFunction();
    expect(client.tagAll).toBeFunction();
    expect(client.untagAll).toBeFunction();
    expect(client.submitCoordinatedUpdate).toBeFunction();
    expect(client.getUpdateResult).toBeFunction();
  });

  describe('start', () => {
    it('starts a workflow and returns a handle with a workflow id', async () => {
      const handle = await client.start('echo', 'hello');
      expect(handle.id).toBeString();
      expect(handle.id.length).toBeGreaterThan(0);
    });

    it('respects a custom id in start options', async () => {
      const handle = await client.start('echo', 'hello', { id: 'http-custom-id' });
      expect(handle.id).toBe('http-custom-id');
    });

    it('returns a handle whose result() resolves with the workflow output', async () => {
      const handle = await client.start('echo', 42);
      const result = await handle.result();
      expect(result).toBe(42);
    });

    it('forwards StartOptions.tags through the HTTP client', async () => {
      const handle = await client.start('echo', 'tagged', {
        id: 'http-client-tags',
        tags: ['nightly', 'v2'],
      });
      await handle.result();

      const state = await client.get('http-client-tags');
      expect(state?.tags).toEqual(['nightly', 'v2']);
    });

    it('forwards StartOptions.searchAttributes through the HTTP client', async () => {
      const createdAt = new Date('2026-01-02T03:04:05.000Z');
      const handle = await client.start('client-contract-search-attributes', 'searchable', {
        id: 'http-client-search-attributes',
        searchAttributes: { customerId: 'acme', createdAt },
      });

      const attributes = await engine.getAttributes('http-client-search-attributes');
      expect(attributes).toEqual({ customerId: 'acme', createdAt });

      await handle.cancel();
    });

    it('rejects StartOptions.idempotencyKey instead of silently dropping it', async () => {
      await expect(
        client.start('echo', 'dedupe', { idempotencyKey: 'dedupe-key' }),
      ).rejects.toThrow('idempotencyKey is not supported over HttpClient');
    });
  });

  describe('get', () => {
    it('returns the workflow state for a known workflow', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-get-test' });
      await handle.result();

      const state = await client.get('http-get-test');
      expect(state).not.toBeNull();
      expect(state!.id).toBe('http-get-test');
      expect(state!.type).toBe('echo');
      expect(state!.status).toBe('completed');
    });

    it('returns null for an unknown workflow', async () => {
      const state = await client.get('nonexistent');
      expect(state).toBeNull();
    });
  });

  describe('list', () => {
    it('lists workflows', async () => {
      const result = await client.list();
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', async () => {
      const result = await client.list({ status: 'completed' });
      expect(result.items.every((item) => item.status === 'completed')).toBe(true);
    });

    it('filters by repeated tag query parameters', async () => {
      const firstHandle = await client.start('echo', 'one', {
        id: 'http-tag-wf-1',
        tags: ['nightly', 'v2', 'release-candidate'],
      });
      const secondHandle = await client.start('echo', 'two', {
        id: 'http-tag-wf-2',
        tags: ['nightly'],
      });
      await firstHandle.result();
      await secondHandle.result();

      const result = await client.list({ tags: ['nightly', 'v2', 'release-candidate'] });
      expect(result.items.map((item) => item.id)).toEqual(['http-tag-wf-1']);
    });
  });

  describe('schedule surface', () => {
    it('exposes schedule handle describe and dispose helpers over HTTP', async () => {
      const schedule = await client.schedule('echo', { payload: 'wrapper' }, '0 * * * *', {
        id: 'http-schedule-wrapper',
      });

      expect(await schedule.describe()).toEqual(
        expect.objectContaining({
          id: 'http-schedule-wrapper',
          workflowType: 'echo',
        }),
      );

      expect(() => schedule[Symbol.dispose]()).not.toThrow();
    });
  });

  describe('cancel', () => {
    it('cancels a workflow via the client', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-cancel-test' });
      await handle.result();
      // Cancelling a completed workflow — should not error
      await client.cancel('http-cancel-test');
    });
  });

  describe('handle.cancel', () => {
    it('delegates to client.cancel', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-handle-cancel' });
      await handle.result();
      await handle.cancel();
    });
  });

  describe('handle.signal', () => {
    it('delegates to client.signal', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-handle-signal' });
      await handle.result();
      await handle.signal('test-signal', { key: 'value' });
    });
  });

  describe('getEvents', () => {
    it('returns event history for a workflow', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-events-test' });
      await handle.result();

      const events = await client.getEvents('http-events-test');
      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe('getTimeline / replayTo', () => {
    it('returns timeline entries and replay data over HTTP', async () => {
      async function firstHttpStep() {
        return { phase: 'first' as const };
      }

      async function secondHttpStep() {
        return { phase: 'second' as const };
      }

      const httpTimeline = workflow({ name: 'http-timeline' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.run(firstHttpStep);
        return yield* ctx.run(secondHttpStep);
      });
      engine.register(httpTimeline);

      const handle = await client.start('http-timeline', null, { id: 'wf-http-client-timeline' });
      await handle.result();

      const timeline = await client.getTimeline('wf-http-client-timeline');
      const replay = await client.replayTo('wf-http-client-timeline', 2);

      expect(timeline).toHaveLength(2);
      expect(timeline[0]?.operationLabel).toBe('firstHttpStep');
      expect(replay?.checkpoint.step).toBe(2);
      expect(replay?.accumulatedResults).toEqual([[0, { phase: 'first' }]]);
    });

    it('returns empty timeline and null replay for missing data over HTTP', async () => {
      const handle = await client.start('echo', 'done', { id: 'wf-http-missing-replay' });
      await handle.result();

      await expect(client.getTimeline('missing-workflow')).resolves.toEqual([]);
      await expect(client.replayTo('missing-workflow', 1)).resolves.toBeNull();
      await expect(client.replayTo('wf-http-missing-replay', 1)).resolves.toBeNull();
    });
  });

  describe('listReviews', () => {
    it('returns an array', async () => {
      const reviews = await client.listReviews();
      expect(Array.isArray(reviews)).toBe(true);
    });
  });

  describe('getUpdateResult', () => {
    it('returns null for an unknown update', async () => {
      const result = await client.getUpdateResult('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('retention surface', () => {
    it('returns the retention overview from the HTTP server', async () => {
      const retentionEngine = new Engine({
        storage: new MemoryStorage(),
        retention: {
          completed: '5m',
        },
      });
      const retainedEchoWorkflow = workflow({ name: 'retained-echo' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return input;
      });
      retentionEngine.register(retainedEchoWorkflow);

      const retentionServer = Bun.serve({
        port: 0,
        async fetch(request) {
          return handleRequest(request, retentionEngine);
        },
      });

      try {
        const retentionClient = new HttpClient({
          baseUrl: `http://localhost:${retentionServer.port}`,
        });

        const overview = await retentionClient.getRetentionOverview();

        expect(overview.sweepIntervalMs).toBe(300_000);
        expect(overview.workflowTypes).toContainEqual(
          expect.objectContaining({
            type: 'retained-echo',
            source: 'engine',
          }),
        );
      } finally {
        retentionServer.stop(true);
        await retentionEngine[Symbol.asyncDispose]();
      }
    });

    it('purges matching terminal workflows via the HTTP client', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-purge' });
      await handle.result();

      const result = await client.purge({ status: 'completed' });

      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(await client.get('http-purge')).toBeNull();
    });

    it('purge honors attribute filters, offset, and limit through the HTTP server', async () => {
      const first = await client.start('echo', 'one', { id: 'http-purge-filter-1' });
      const second = await client.start('echo', 'two', { id: 'http-purge-filter-2' });
      const third = await client.start('echo', 'three', { id: 'http-purge-filter-3' });
      await Promise.all([first.result(), second.result(), third.result()]);

      await client.setAttributes('http-purge-filter-1', { bucket: 'target' });
      await client.setAttributes('http-purge-filter-2', { bucket: 'target' });
      await client.setAttributes('http-purge-filter-3', { bucket: 'other' });

      const result = await client.purge({
        status: 'completed',
        attributes: [{ key: 'bucket', value: 'target' }],
        offset: 1,
        limit: 1,
      });

      expect(result.deleted).toBe(1);
      expect(await client.get('http-purge-filter-1')).not.toBeNull();
      expect(await client.get('http-purge-filter-2')).toBeNull();
      expect(await client.get('http-purge-filter-3')).not.toBeNull();
    });

    it('purge honors tag filters through the HTTP server', async () => {
      const first = await client.start('echo', 'one', {
        id: 'http-purge-tag-1',
        tags: ['nightly', 'v2'],
      });
      const second = await client.start('echo', 'two', {
        id: 'http-purge-tag-2',
        tags: ['nightly'],
      });
      await Promise.all([first.result(), second.result()]);

      const result = await client.purge({
        status: 'completed',
        tags: ['nightly', 'v2'],
      });

      expect(result.deleted).toBe(1);
      expect(await client.get('http-purge-tag-1')).toBeNull();
      expect(await client.get('http-purge-tag-2')).not.toBeNull();
    });
  });

  describe('same interface as LocalClient', () => {
    it('both export WeftClient-compatible classes', async () => {
      const { LocalClient } = await import('./local.ts');
      const localEngine = new Engine({ storage: new MemoryStorage() });
      localEngine.register(echoWorkflow);

      const local: WeftClient = new LocalClient(localEngine);
      const remote: WeftClient = client;

      // Both should have the same set of methods
      const clientMethods = [
        'start',
        'schedule',
        'get',
        'getSchedule',
        'list',
        'listSchedules',
        'cancel',
        'pauseSchedule',
        'resumeSchedule',
        'cancelSchedule',
        'updateSchedule',
        'signal',
        'query',
        'update',
        'resume',
        'recoverAll',
        'timeout',
        'getAttributes',
        'setAttributes',
        'getEvents',
        'listReviews',
        'submitReview',
        'getStreamChunks',
        'fork',
        'getRetentionOverview',
        'purge',
        'cancelAll',
        'signalAll',
        'deleteAll',
        'tagAll',
        'untagAll',
        'submitCoordinatedUpdate',
        'getUpdateResult',
      ] as const;

      for (const method of clientMethods) {
        expect(typeof local[method]).toBe('function');
        expect(typeof remote[method]).toBe('function');
      }

      await localEngine[Symbol.asyncDispose]();
    });
  });
});

describe('HttpClient live event streaming (end-to-end)', () => {
  async function waitForStreaming(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for streaming predicate');
      await sleepForTesting(5);
    }
  }

  it('resumes the event stream after the underlying socket drops', async () => {
    // Wrap the real Bun WebSocket so the test can reach in and drop the active
    // socket, proving the subscription reconnects and keeps delivering events.
    const liveSockets: WebSocket[] = [];
    const reconnectingClient = new HttpClient({
      baseUrl: server.url,
      headers: { Authorization: `Bearer ${CONTRACT_API_KEY}` },
      webSocketFactory: (url, headers) => {
        const Constructor = WebSocket as unknown as {
          new (url: string, options: { headers: Record<string, string> }): WebSocket;
        };
        const socket = new Constructor(url, { headers });
        liveSockets.push(socket);
        return socket;
      },
    });

    const handle = await reconnectingClient.start('client-contract-waiting-twice', 'resume', {
      id: 'http-stream-reconnect',
    });
    await waitForQueryReadyForTesting(reconnectingClient, handle.id);

    const seen: string[] = [];
    const tail = reconnectingClient.tail(handle.id);
    const consume = (async () => {
      for await (const event of tail) seen.push(event.type);
    })();
    await tail.whenConnected();

    // First signal: delivered live over the original socket.
    await handle.signal('continue', undefined, { signalId: 'first' });
    await waitForStreaming(() => seen.includes('signal:received'), 2000);

    // Drop the live socket; the subscription must reconnect on its own.
    expect(liveSockets.length).toBeGreaterThanOrEqual(1);
    liveSockets[liveSockets.length - 1]!.close();
    // Wait for the reconnect to produce a new socket and for it to actually
    // open, so the second signal's events are delivered over the live socket.
    await waitForStreaming(() => liveSockets.length >= 2, 3000);
    await waitForStreaming(
      () => liveSockets[liveSockets.length - 1]!.readyState === WebSocket.OPEN,
      3000,
    );

    // Second signal completes the workflow; the resumed stream must deliver
    // the terminal event and the tail must terminate cleanly.
    await handle.signal('continue', undefined, { signalId: 'second' });
    await Promise.race([
      consume,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`resumed stream did not complete; seen=${JSON.stringify(seen)}`)),
          3000,
        ),
      ),
    ]);

    expect(seen).toContain('workflow:completed');
    expect(await handle.result()).toBe('resume:done');
  });
});

describe('HttpClient request surface', () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('serializes the full client surface into the expected HTTP requests', async () => {
    const fetchCalls: FetchCall[] = [];
    const responses = createFullSurfaceResponses(jsonResponse);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestInputToUrl(input);
      fetchCalls.push({ url, init });
      const response = responses.shift();
      if (!response) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return response;
    }) as unknown as typeof fetch;

    const httpClient = new HttpClient({
      baseUrl: 'http://example.test///',
      headers: { Authorization: 'Bearer token' },
    });

    await exerciseWorkflowHandleAndSchedule(httpClient);
    await exerciseWorkflowClientRequests(httpClient);
    await exerciseRecoveryAndReviewRequests(httpClient);

    assertWorkflowStartCall(fetchCalls);
    assertScheduleCalls(fetchCalls);
    assertFilterAndFollowupCalls(fetchCalls);
    assertForkCall(fetchCalls);
  });

  it('uses WEFT_ADDR and WEFT_TOKEN when constructed without explicit options', async () => {
    const fetchCalls: FetchCall[] = [];
    const priorAddress = Bun.env['WEFT_ADDR'];
    const priorToken = Bun.env['WEFT_TOKEN'];
    Bun.env['WEFT_ADDR'] = 'http://environment.test///';
    Bun.env['WEFT_TOKEN'] = 'environment-token';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      return jsonResponse({ id: 'wf-env' });
    }) as unknown as typeof fetch;

    try {
      const httpClient = new HttpClient();
      await httpClient.start('echo', 'hello');

      expect(fetchCalls[0]?.url).toBe('http://environment.test/v1/workflows');
      expect(new Headers(fetchCalls[0]?.init?.headers).get('Authorization')).toBe(
        'Bearer environment-token',
      );
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
      if (priorToken === undefined) delete Bun.env['WEFT_TOKEN'];
      else Bun.env['WEFT_TOKEN'] = priorToken;
    }
  });

  it('uses explicit client options before environment values', async () => {
    const fetchCalls: FetchCall[] = [];
    const priorAddress = Bun.env['WEFT_ADDR'];
    const priorToken = Bun.env['WEFT_TOKEN'];
    Bun.env['WEFT_ADDR'] = 'http://environment.test';
    Bun.env['WEFT_TOKEN'] = 'environment-token';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      return jsonResponse({ id: 'wf-explicit' });
    }) as unknown as typeof fetch;

    try {
      const httpClient = new HttpClient({
        baseUrl: 'http://explicit.test',
        token: 'explicit-token',
      });
      await httpClient.start('echo', 'hello');

      expect(fetchCalls[0]?.url).toBe('http://explicit.test/v1/workflows');
      expect(new Headers(fetchCalls[0]?.init?.headers).get('Authorization')).toBe(
        'Bearer explicit-token',
      );
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
      if (priorToken === undefined) delete Bun.env['WEFT_TOKEN'];
      else Bun.env['WEFT_TOKEN'] = priorToken;
    }
  });

  it('uses an explicit empty token to suppress environment authorization', async () => {
    const fetchCalls: FetchCall[] = [];
    const priorAddress = Bun.env['WEFT_ADDR'];
    const priorToken = Bun.env['WEFT_TOKEN'];
    Bun.env['WEFT_ADDR'] = 'http://environment.test';
    Bun.env['WEFT_TOKEN'] = 'environment-token';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      return jsonResponse({ id: 'wf-empty-token' });
    }) as unknown as typeof fetch;

    try {
      const httpClient = new HttpClient({
        baseUrl: 'http://explicit.test',
        token: '',
      });
      await httpClient.start('echo', 'hello');

      expect(fetchCalls[0]?.url).toBe('http://explicit.test/v1/workflows');
      expect(new Headers(fetchCalls[0]?.init?.headers).get('Authorization')).toBeNull();
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
      if (priorToken === undefined) delete Bun.env['WEFT_TOKEN'];
      else Bun.env['WEFT_TOKEN'] = priorToken;
    }
  });

  it('preserves caller Authorization headers over resolved tokens', async () => {
    const fetchCalls: FetchCall[] = [];
    const priorAddress = Bun.env['WEFT_ADDR'];
    const priorToken = Bun.env['WEFT_TOKEN'];
    Bun.env['WEFT_ADDR'] = 'http://environment.test';
    Bun.env['WEFT_TOKEN'] = 'environment-token';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      return jsonResponse({ id: 'wf-header-token' });
    }) as unknown as typeof fetch;

    try {
      const httpClient = new HttpClient({
        baseUrl: 'http://explicit.test',
        token: 'resolved-token',
        headers: { Authorization: 'Bearer caller-token' },
      });
      await httpClient.start('echo', 'hello');

      expect(fetchCalls[0]?.url).toBe('http://explicit.test/v1/workflows');
      expect(new Headers(fetchCalls[0]?.init?.headers).get('Authorization')).toBe(
        'Bearer caller-token',
      );
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
      if (priorToken === undefined) delete Bun.env['WEFT_TOKEN'];
      else Bun.env['WEFT_TOKEN'] = priorToken;
    }
  });

  it('serializes bulk workflow methods into the expected HTTP requests', async () => {
    const fetchCalls: FetchCall[] = [];
    const responses = [
      jsonResponse({
        cancelled: 2,
        failed: 1,
        errors: [{ id: 'wf-failed', error: 'boom' }],
      }),
      jsonResponse({ signalled: 3, failed: 0 }),
      jsonResponse({ deleted: 4 }),
      jsonResponse({ modified: 5 }),
      jsonResponse({ modified: 2 }),
    ];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      const response = responses.shift();
      if (!response) {
        throw new Error(`Unexpected fetch: ${requestInputToUrl(input)}`);
      }
      return response;
    }) as unknown as typeof fetch;

    const httpClient = new HttpClient({
      baseUrl: 'http://example.test',
      headers: { Authorization: 'Bearer token' },
    });

    await exerciseBulkWorkflowClientRequests(httpClient);
    assertBulkWorkflowRequestCalls(fetchCalls);
  });

  it('serializes startAt in the workflow start payload', async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      return jsonResponse({ id: 'wf-start-at' });
    }) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });
    await httpClient.start('echo', 'hello', { startAt: 12_345 });

    const startBody = fetchCalls[0]?.init?.body;
    expect(typeof startBody).toBe('string');
    if (typeof startBody !== 'string') {
      throw new Error('Expected start request body to be a string');
    }
    expect(JSON.parse(startBody)).toEqual({
      type: 'echo',
      input: 'hello',
      startAt: 12_345,
    });
  });

  it('serializes startAfter in the workflow start payload', async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      return jsonResponse({ id: 'wf-start-after' });
    }) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });
    await httpClient.start('echo', 'hello', { startAfter: '5m' });

    const startBody = fetchCalls[0]?.init?.body;
    expect(typeof startBody).toBe('string');
    if (typeof startBody !== 'string') {
      throw new Error('Expected start request body to be a string');
    }
    expect(JSON.parse(startBody)).toEqual({
      type: 'echo',
      input: 'hello',
      startAfter: '5m',
    });
  });

  it('uses GET for no-input queries and POST with input payloads', async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      jsonResponse({ id: 'wf/1' }),
      jsonResponse({ result: 'ready' }),
      jsonResponse({ result: { detail: true } }),
      jsonResponse({ result: { source: 'handle' } }),
    ];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      return responses.shift() ?? jsonResponse({ result: null });
    }) as unknown as typeof fetch;

    const statusQuery = query<void, string>('status');
    const echoInputQuery = query<{ detail?: boolean; source?: string }, object>('echoInput');
    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });
    const handle = await httpClient.start('echo', null);

    await expect(handle.query(statusQuery)).resolves.toBe('ready');
    await expect(httpClient.query('wf/1', echoInputQuery, { detail: true })).resolves.toEqual({
      detail: true,
    });
    await expect(handle.query(echoInputQuery, { source: 'handle' })).resolves.toEqual({
      source: 'handle',
    });

    expect(fetchCalls[1]?.url).toBe('http://example.test/v1/workflows/wf%2F1/query/status');
    expect(fetchCalls[1]?.init?.method).toBeUndefined();
    expect(fetchCalls[1]?.init?.body).toBeUndefined();

    expect(fetchCalls[2]?.url).toBe('http://example.test/v1/workflows/wf%2F1/query/echoInput');
    expect(fetchCalls[2]?.init?.method).toBe('POST');
    expect(fetchCalls[2]?.init?.body).toBe(JSON.stringify({ input: { detail: true } }));

    expect(fetchCalls[3]?.url).toBe('http://example.test/v1/workflows/wf%2F1/query/echoInput');
    expect(fetchCalls[3]?.init?.method).toBe('POST');
    expect(fetchCalls[3]?.init?.body).toBe(JSON.stringify({ input: { source: 'handle' } }));
  });

  it('encodes review list filters into the request query string', async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      return jsonResponse({ items: [] });
    }) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });
    await httpClient.listReviews({
      status: 'completed',
      workflowId: 'wf/1',
      reviewType: 'security review',
    });

    const listCall = fetchCalls[0];
    expect(listCall?.init?.method).toBeUndefined();

    const listUrl = new URL(listCall?.url ?? '');
    expect(listUrl.pathname).toBe('/v1/reviews');
    expect(listUrl.searchParams.get('status')).toBe('completed');
    expect(listUrl.searchParams.get('workflowId')).toBe('wf/1');
    expect(listUrl.searchParams.get('reviewType')).toBe('security review');
  });

  it('returns null or empty collections for missing GET resources', async () => {
    const responses = [
      new Response(JSON.stringify({ error: 'missing' }), { status: 404 }),
      new Response(JSON.stringify({ error: 'missing' }), { status: 404 }),
      new Response(JSON.stringify({ error: 'missing' }), { status: 404 }),
    ];

    globalThis.fetch = (async () =>
      responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });

    expect(await httpClient.get('missing')).toBeNull();
    expect(await httpClient.getEvents('missing')).toEqual([]);
    expect(await httpClient.getUpdateResult('missing')).toBeNull();
  });

  it('converts coordinated update business errors and propagates transport errors', async () => {
    const responses = [
      new Response(JSON.stringify({ error: 'business rejection' }), { status: 422 }),
      new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }),
    ];

    globalThis.fetch = (async () =>
      responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });

    expect(await httpClient.submitCoordinatedUpdate('wf-1', 'rename')).toEqual({
      updateId: '',
      error: 'business rejection',
    });
    await expect(httpClient.submitCoordinatedUpdate('wf-1', 'rename')).rejects.toMatchObject({
      status: 401,
      message: 'Unauthorized',
    });
  });

  it('converts a structured coordinated-update fault body to the human message', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'Unprocessable', message: 'bad payload' } }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });

    // The behavioral contract: the structured fault's human message reaches the
    // `error` field and the call resolves rather than throwing.
    const result = await httpClient.submitCoordinatedUpdate('wf-1', 'rename');
    expect(result.error).toBe('bad payload');
  });

  it('throws a 404 client error when handle.result() points at a missing workflow', async () => {
    const responses = [
      jsonResponse({ id: 'wf-1' }),
      new Response(JSON.stringify({ error: 'missing' }), { status: 404 }),
    ];

    globalThis.fetch = (async () =>
      responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });
    const handle = await httpClient.start('echo', 'hello');

    await expect(handle.result()).rejects.toBeInstanceOf(HttpClientError);
  });

  it('pushes handle events over the watch channel and closes on terminal events', async () => {
    // `start` POST returns the id; the streaming catch-up `getEvents` GET
    // returns an empty history so only the live frame is delivered.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestInputToUrl(input);
      if (url.includes('/events')) return jsonResponse({ events: [] });
      return jsonResponse({ id: 'wf-terminal' });
    }) as unknown as typeof fetch;
    const wsServer = new FakeWebSocketServer();

    const httpClient = new HttpClient({
      baseUrl: 'http://example.test',
      webSocketFactory: wsServer.factory,
    });

    const handle = await httpClient.start('echo', 'hello');
    const terminalEvent = await new Promise<Event>((resolve) => {
      handle.addEventListener('workflow:completed', resolve as EventListener);
      void (async () => {
        // The subscription opens lazily on addEventListener; once the socket
        // is open and catch-up has run, deliver the live terminal event.
        const deadline = Date.now() + 1000;
        while (wsServer.sockets.length === 0 || !wsServer.latest().opened) {
          if (Date.now() > deadline) throw new Error('subscription never opened');
          await sleepForTesting(2);
        }
        await sleepForTesting(5); // let the catch-up fetch settle
        wsServer.latest().deliver({
          type: 'workflow:completed',
          timestamp: 1,
          data: { result: 'done' },
        });
      })();
    });

    expect(terminalEvent).toBeInstanceOf(CustomEvent);
    expect((terminalEvent as CustomEvent).detail).toEqual({ result: 'done' });
    // The terminal event auto-closes the subscription and its socket.
    expect(wsServer.latest().closed).toBe(true);
  });

  it('does not re-open a duplicating subscription after the workflow terminates', async () => {
    // Regression: re-opening the cached subscription after termination would
    // replay the full persisted history on connect and re-dispatch every event
    // to listeners still registered from before — duplicate delivery. The handle
    // opens its subscription once and never re-opens, so attaching a listener
    // after the terminal event must not create a second socket.
    let eventsCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestInputToUrl(input);
      if (url.includes('/events')) {
        eventsCalls += 1;
        // History carries the terminal event, so any re-subscribe would replay it.
        return jsonResponse({
          events: [{ type: 'workflow:completed', timestamp: 1, data: { result: 'done' } }],
        });
      }
      return jsonResponse({ id: 'wf-no-reopen' });
    }) as unknown as typeof fetch;
    const wsServer = new FakeWebSocketServer();

    const httpClient = new HttpClient({
      baseUrl: 'http://example.test',
      webSocketFactory: wsServer.factory,
    });
    const handle = await httpClient.start('echo', 'hello');

    const completedCounts = { first: 0, second: 0 };
    handle.addEventListener('workflow:completed', () => {
      completedCounts.first += 1;
    });

    // Wait for the catch-up to deliver the terminal event and auto-close.
    const deadline = Date.now() + 1000;
    while (completedCounts.first === 0) {
      if (Date.now() > deadline) throw new Error('terminal event never delivered');
      await sleepForTesting(2);
    }
    expect(completedCounts.first).toBe(1);
    const socketsAfterTerminal = wsServer.sockets.length;
    const eventsCallsAfterTerminal = eventsCalls;

    // Attach a new listener after termination. The handle must NOT open a new
    // subscription (no new socket, no second catch-up), so the pre-existing
    // listener does not fire again.
    handle.addEventListener('workflow:completed', () => {
      completedCounts.second += 1;
    });
    await sleepForTesting(10);

    expect(wsServer.sockets.length).toBe(socketsAfterTerminal);
    expect(eventsCalls).toBe(eventsCallsAfterTerminal);
    expect(completedCounts.first).toBe(1); // not re-fired
    expect(completedCounts.second).toBe(0);
  });

  it('opens at most one subscription regardless of listener count', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (requestInputToUrl(input).includes('/events')) return jsonResponse({ events: [] });
      return jsonResponse({ id: 'wf-shared' });
    }) as unknown as typeof fetch;
    const wsServer = new FakeWebSocketServer();

    const httpClient = new HttpClient({
      baseUrl: 'http://example.test',
      webSocketFactory: wsServer.factory,
    });
    const handle = await httpClient.start('echo', 'hello');

    handle.addEventListener('workflow:started', () => {});
    handle.addEventListener('workflow:completed', () => {});

    await sleepForTesting(5);
    expect(wsServer.sockets).toHaveLength(1);
  });

  it('removes listeners and disposes a handle, closing the subscription', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (requestInputToUrl(input).includes('/events')) return jsonResponse({ events: [] });
      return jsonResponse({ id: 'wf-dispose' });
    }) as unknown as typeof fetch;
    const wsServer = new FakeWebSocketServer();

    const httpClient = new HttpClient({
      baseUrl: 'http://example.test',
      webSocketFactory: wsServer.factory,
    });
    const handle = await httpClient.start('echo', 'hello');
    const listener = (() => {}) as EventListener;

    handle.addEventListener('workflow:started', listener);
    await sleepForTesting(5);
    handle.removeEventListener('workflow:started', listener);
    handle[Symbol.dispose]();

    expect(wsServer.latest().closed).toBe(true);
  });

  it('exercises HttpScheduleHandle.describe() directly against a mocked remote response', async () => {
    const originalFetchOverride = globalThis.fetch;

    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Response.json({ id: 'schedule-direct' });
        }

        return Response.json({
          id: 'schedule-direct',
          workflowType: 'echo',
          cronExpression: '0 * * * *',
          status: 'active',
          overlap: 'queue',
          backfill: true,
          createdAt: 1,
          updatedAt: 2,
          nextFireAt: 3,
          queuedRuns: 0,
        });
      }) as typeof fetch;

      const directClient = new HttpClient({ baseUrl: 'http://example.test' });
      const scheduleHandle = await directClient.schedule('echo', 'payload', '0 * * * *');

      expect(await scheduleHandle.describe()).toEqual(
        expect.objectContaining({
          id: 'schedule-direct',
          cronExpression: '0 * * * *',
        }),
      );

      expect(() => scheduleHandle[Symbol.dispose]()).not.toThrow();
    } finally {
      globalThis.fetch = originalFetchOverride;
    }
  });
});
