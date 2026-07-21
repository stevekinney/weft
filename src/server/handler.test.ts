import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting, waitForCondition } from '../testing/fake-timers.test-support.ts';

import { decode, encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import { StartWorkflowValidationError } from '../core/start-workflow-validation.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { UpdateCoordinator, WorkflowTerminalError } from '../core/updates.ts';
import { encodeStorageKeyComponent, KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { getRequiredRouteParameter, handleRequest } from './handler.ts';
import { principalFromApiKey } from './principal.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';
import { storeHistoricalReviewDecisionWithoutRequestMetadata } from './review-test-support.test-support.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

/**
 * HandlerOptions that inject an api-key principal, bypassing the auth layer
 * for tests that verify behavior of operations that now require authentication.
 */
function apiKeyAuth() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'test',
        scopes: ['workflows:read', 'workflows:admin'],
      }),
    },
  };
}

function reviewReadApiKeyAuth() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'review-reader', scopes: ['reviews:read'] }),
    },
  };
}

async function waitForWorkflowStatus(
  engine: Engine,
  workflowId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
): Promise<void> {
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      return state?.status === status;
    },
    { label: `workflow "${workflowId}" to reach ${status}`, timeoutMs: 500, intervalMs: 5 },
  );
}

// ---------------------------------------------------------------------------
// Module-scope workflow definitions used across handler tests.
// ---------------------------------------------------------------------------

const echoWorkflow = workflow({ name: 'echo' })
  .searchAttributes({ bucket: { type: 'string' } })
  .execute(async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });

const waitingWorkflow = workflow({ name: 'waiting' }).execute(async function* (
  ctx: WorkflowContext,
  input: unknown,
) {
  const signal = yield* ctx.waitForSignal<string>('continue');
  return `${String(input)}:${signal}`;
});

const errorOnStartWorkflow = workflow({ name: 'error-on-start' }).execute(async function* () {
  throw new Error('some internal error');
});

const failingWorkflow = workflow({ name: 'failing' }).execute(async function* () {
  throw new Error('workflow failed');
});

const failingNoMessageWorkflow = workflow({ name: 'failing-no-msg' }).execute(async function* () {
  throw new Error('deliberate');
});

const cancellableWorkflow = workflow({ name: 'cancellable' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.waitForSignal('never');
  return 'nope';
});

const longRunningWorkflow = workflow({ name: 'long-running' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.waitForSignal('never-arrives');
  return 'done';
});

const longRunningNeverSignalWorkflow = workflow({ name: 'long-running' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.waitForSignal('never');
  return 'done';
});

const erroringWorkflow = workflow({ name: 'erroring' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.waitForSignal('never');
  return 'done';
});

const queryableWorkflow = workflow({ name: 'queryable' }).execute(async function* (
  ctx: WorkflowContext,
) {
  let counter = 42;
  ctx.expose({ counter: () => counter });
  yield* ctx.waitForSignal('done');
  return counter;
});

const queryableSimpleWorkflow = workflow({ name: 'queryable' }).execute(async function* (
  ctx: WorkflowContext,
) {
  ctx.expose({ counter: () => 1 });
  yield* ctx.waitForSignal('done');
  return 0;
});

const noopWorkflow = workflow({ name: 'noop' }).execute(async function* () {
  return null;
});

const forkableWorkflow = workflow({ name: 'forkable' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

const slowCleanupWorkflow = workflow({
  name: 'slow-cleanup',
  retention: { completed: '1h' },
}).execute(async function* () {
  return 'done';
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return engine;
}

function request(method: string, path: string, body?: unknown): Request {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, options);
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

function confirmationTokenFromPreview(preview: unknown): string {
  const token = (preview as { confirmationToken?: unknown }).confirmationToken;
  if (typeof token !== 'string') {
    throw new Error('Expected bulk preview confirmation token');
  }
  return token;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleRequest', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  // 1. Health check
  it('GET /v1/health returns 200 with status ok', async () => {
    engine = createEngine();
    const response = await handleRequest(request('GET', '/v1/health'), engine);

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ status: 'ok' });
  });

  it('GET /openapi.json returns the OpenAPI document', async () => {
    engine = createEngine();
    const response = await handleRequest(request('GET', '/openapi.json'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe('3.1.0');
    expect(body.paths['/api/v1/workflows']).toBeDefined();
  });

  it('GET /openrpc.json returns the OpenRPC document', async () => {
    engine = createEngine();
    const response = await handleRequest(request('GET', '/openrpc.json'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { openrpc: string; methods: unknown[] };
    expect(body.openrpc).toBe('1.3.2');
    expect(body.methods.length).toBeGreaterThan(0);
  });

  it('GET /v1/retention returns the retention overview used by the dashboard', async () => {
    engine = new Engine({
      storage: new MemoryStorage(),
      retention: {
        completed: '5m',
      },
    });
    engine.register(echoWorkflow);
    engine.register(slowCleanupWorkflow);

    const response = await handleRequest(request('GET', '/v1/retention'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      sweepIntervalMs: number;
      nextSweepAt: number | null;
      workflowTypes: Array<{
        type: string;
        source: string;
        retention: { completed?: number } | null;
      }>;
    };
    expect(body.sweepIntervalMs).toBe(300_000);
    expect(body.nextSweepAt).not.toBeNull();
    expect(body.workflowTypes).toContainEqual(
      expect.objectContaining({
        type: 'echo',
        source: 'engine',
        retention: expect.objectContaining({ completed: 300_000 }),
      }),
    );
    expect(body.workflowTypes).toContainEqual(
      expect.objectContaining({
        type: 'slow-cleanup',
        source: 'workflow',
        retention: expect.objectContaining({ completed: 3_600_000 }),
      }),
    );
  });

  describe('schedule routes', () => {
    it('Acceptance criterion: GET /v1/schedules and POST /v1/schedules expose schedule CRUD over REST', async () => {
      engine = createEngine();

      const createResponse = await handleRequest(
        request('POST', '/v1/schedules', {
          type: 'echo',
          input: { payload: 'nightly' },
          cronExpression: '0 * * * *',
          id: 'nightly-maintenance',
          overlap: 'queue',
          backfill: true,
        }),
        engine,
      );

      expect(createResponse.status).toBe(201);
      expect(await json(createResponse)).toEqual({ id: 'nightly-maintenance' });

      const listResponse = await handleRequest(
        request('GET', '/v1/schedules'),
        engine,
        apiKeyAuth(),
      );
      expect(listResponse.status).toBe(200);

      const listed = (await json(listResponse)) as {
        items: Array<{
          id: string;
          workflowType: string;
          cronExpression: string;
          status: string;
          overlap: string;
          backfill: boolean;
          nextFireAt: number | null;
          queuedRuns: Array<{ workflowId: string; queuedAt: number; occurrence?: number }>;
        }>;
        total: number;
      };
      expect(listed.total).toBe(1);
      expect(listed.items).toContainEqual(
        expect.objectContaining({
          id: 'nightly-maintenance',
          workflowType: 'echo',
          cronExpression: '0 * * * *',
          status: 'active',
          overlap: 'queue',
          backfill: true,
          queuedRuns: [],
        }),
      );
      expect(listed.items[0]?.nextFireAt).toEqual(expect.any(Number));
    });

    it('GET /v1/schedules/:id returns a stored schedule summary', async () => {
      engine = createEngine();
      await engine.schedule('echo', 'payload', '0 * * * *', { id: 'schedule-detail' });

      const response = await handleRequest(
        request('GET', '/v1/schedules/schedule-detail'),
        engine,
        apiKeyAuth(),
      );

      expect(response.status).toBe(200);
      expect(await json(response)).toEqual(
        expect.objectContaining({
          id: 'schedule-detail',
          workflowType: 'echo',
          cronExpression: '0 * * * *',
          status: 'active',
        }),
      );
    });

    it('POST /v1/schedules/:id/pause and /resume mutate schedule state', async () => {
      engine = createEngine();
      await engine.schedule('echo', null, '0 * * * *', { id: 'schedule-pause-resume' });

      const pauseResponse = await handleRequest(
        request('POST', '/v1/schedules/schedule-pause-resume/pause'),
        engine,
      );
      expect(pauseResponse.status).toBe(204);
      expect(await engine.getSchedule('schedule-pause-resume')).toEqual(
        expect.objectContaining({ status: 'paused' }),
      );

      const resumeResponse = await handleRequest(
        request('POST', '/v1/schedules/schedule-pause-resume/resume'),
        engine,
      );
      expect(resumeResponse.status).toBe(204);
      expect(await engine.getSchedule('schedule-pause-resume')).toEqual(
        expect.objectContaining({ status: 'active' }),
      );
    });

    it('PATCH /v1/schedules/:id updates the cron expression', async () => {
      engine = createEngine();
      await engine.schedule('echo', null, '0 * * * *', { id: 'schedule-update' });

      const response = await handleRequest(
        request('PATCH', '/v1/schedules/schedule-update', { cronExpression: '30 * * * *' }),
        engine,
      );

      expect(response.status).toBe(204);
      expect(await engine.getSchedule('schedule-update')).toEqual(
        expect.objectContaining({ cronExpression: '30 * * * *' }),
      );
    });

    it('DELETE /v1/schedules/:id cancels the schedule', async () => {
      engine = createEngine();
      await engine.schedule('echo', null, '0 * * * *', { id: 'schedule-cancel' });

      const response = await handleRequest(
        request('DELETE', '/v1/schedules/schedule-cancel'),
        engine,
      );

      expect(response.status).toBe(204);
      expect(await engine.getSchedule('schedule-cancel')).toEqual(
        expect.objectContaining({ status: 'cancelled', nextFireAt: null }),
      );
    });

    it('POST /v1/schedules validates the request body', async () => {
      engine = createEngine();

      const missingTypeResponse = await handleRequest(
        request('POST', '/v1/schedules', {
          cronExpression: '0 * * * *',
        }),
        engine,
      );
      expect(missingTypeResponse.status).toBe(400);
      expect(await json(missingTypeResponse)).toEqual({ error: 'Missing required field: type' });

      const invalidCronResponse = await handleRequest(
        request('POST', '/v1/schedules', {
          type: 'echo',
          cronExpression: 'not-a-cron',
        }),
        engine,
      );
      expect(invalidCronResponse.status).toBe(400);
      expect((await json(invalidCronResponse)) as { error: string }).toEqual(
        expect.objectContaining({
          error: expect.stringContaining('Cron'),
        }),
      );
    });

    it('GET /v1/schedules rejects invalid status filters', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('GET', '/v1/schedules?status=unknown'),
        engine,
        apiKeyAuth(),
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        error: 'Query parameter "status" must be one of active, paused, cancelled',
      });
    });

    it('GET /v1/schedules rejects invalid pagination values', async () => {
      engine = createEngine();

      const invalidLimitResponse = await handleRequest(
        request('GET', '/v1/schedules?limit=bogus'),
        engine,
        apiKeyAuth(),
      );
      expect(invalidLimitResponse.status).toBe(400);
      expect(await json(invalidLimitResponse)).toEqual({
        error: 'Query parameter "limit" must be a positive integer',
      });

      const invalidOffsetResponse = await handleRequest(
        request('GET', '/v1/schedules?offset=-1'),
        engine,
        apiKeyAuth(),
      );
      expect(invalidOffsetResponse.status).toBe(400);
      expect(await json(invalidOffsetResponse)).toEqual({
        error: 'Query parameter "offset" must be a non-negative integer',
      });
    });

    it('schedule item routes return 404 when the schedule does not exist', async () => {
      engine = createEngine();

      const getResponse = await handleRequest(
        request('GET', '/v1/schedules/missing-schedule'),
        engine,
        apiKeyAuth(),
      );
      expect(getResponse.status).toBe(404);

      const pauseResponse = await handleRequest(
        request('POST', '/v1/schedules/missing-schedule/pause'),
        engine,
      );
      expect(pauseResponse.status).toBe(404);
    });
  });

  // 2. Start workflow with valid body
  it('POST /v1/workflows with valid body returns 201 with id', async () => {
    engine = createEngine();
    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'hello' }),
      engine,
    );

    expect(response.status).toBe(201);
    const body = (await json(response)) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  // 3. Start workflow with missing type returns 400
  it('POST /v1/workflows with missing type returns 400', async () => {
    engine = createEngine();
    const response = await handleRequest(
      request('POST', '/v1/workflows', { input: 'hello' }),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toBeDefined();
  });

  // 4. Get workflow state
  it('GET /v1/workflows/:id returns workflow state', async () => {
    engine = createEngine();

    // Start a workflow first
    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 42 }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };
    await flush();

    const response = await handleRequest(request('GET', `/v1/workflows/${id}`), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { id: string; type: string; status: string };
    expect(body.id).toBe(id);
    expect(body.type).toBe('echo');
    expect(body.status).toBe('completed');
  });

  // 5. Get workflow with unknown id returns 404
  it('GET /v1/workflows/:id with unknown id returns 404', async () => {
    engine = createEngine();
    const response = await handleRequest(request('GET', '/v1/workflows/nonexistent-id'), engine);

    expect(response.status).toBe(404);
  });

  // 6. Cancel workflow returns 204
  it('DELETE /v1/workflows/:id returns 204', async () => {
    engine = createEngine();

    // Start a workflow
    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data' }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };

    const response = await handleRequest(request('DELETE', `/v1/workflows/${id}`), engine);

    expect(response.status).toBe(204);
  });

  // 7. Signal workflow returns 200
  it('POST /v1/workflows/:id/signal/:name returns 200', async () => {
    engine = createEngine();

    // Start a workflow
    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data' }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };

    const response = await handleRequest(
      request('POST', `/v1/workflows/${id}/signal/my-signal`, { payload: 'signal-data' }),
      engine,
    );

    expect(response.status).toBe(200);
  });

  // 8. List workflows
  it('GET /v1/workflows returns list of workflows', async () => {
    engine = createEngine();

    // Start two workflows
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 2 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('returns 400 for malformed percent-encoded route parameters', async () => {
    engine = createEngine();

    const response = await handleRequest(request('GET', '/v1/workflows/%E0%A4%A/result'), engine);

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Malformed route parameter encoding' });
  });

  // 9. List workflows with status filter
  it('GET /v1/workflows?status=running filters by status', async () => {
    engine = createEngine();

    // Start a workflow that completes immediately
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?status=running'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number };
    // The echo workflow completes immediately, so no running workflows
    expect(body.items.length).toBe(0);
    expect(body.total).toBe(0);
  });

  it('GET /v1/workflows?id_prefix=order- narrows by workflow id prefix', async () => {
    engine = createEngine();

    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 1, id: 'order-1' }),
      engine,
    );
    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 1, id: 'order-2' }),
      engine,
    );
    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 1, id: 'payment-1' }),
      engine,
    );
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?id_prefix=order-'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: { id: string }[]; total: number };
    expect(body.items.map((item) => item.id).toSorted()).toEqual(['order-1', 'order-2']);
    expect(body.total).toBe(2);
  });

  it('GET /v1/workflows?id_prefix=a:b is rejected by normalizeListFilter as Unprocessable', async () => {
    engine = createEngine();

    const response = await handleRequest(request('GET', '/v1/workflows?id_prefix=a:b'), engine);

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('idPrefix');
  });

  it('GET /v1/workflows?created_at_gte=… narrows by createdAt range', async () => {
    engine = createEngine();

    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 1, id: 'wf-x' }),
      engine,
    );
    await flush();

    // gte at 0 includes everything; gte at a huge future time excludes everything.
    const futureBound = Date.now() + 60 * 60 * 1000;

    const inclusive = await handleRequest(request('GET', '/v1/workflows?created_at_gte=0'), engine);
    expect(inclusive.status).toBe(200);
    const inclusiveBody = (await json(inclusive)) as { total: number };
    expect(inclusiveBody.total).toBeGreaterThanOrEqual(1);

    const exclusive = await handleRequest(
      request('GET', `/v1/workflows?created_at_gte=${futureBound}`),
      engine,
    );
    expect(exclusive.status).toBe(200);
    const exclusiveBody = (await json(exclusive)) as { total: number };
    expect(exclusiveBody.total).toBe(0);
  });

  it('GET /v1/workflows?created_at_gte=0&created_at_gt=0 is rejected (conflicting bounds)', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows?created_at_gte=0&created_at_gt=0'),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('createdAt');
  });

  // 10. Unknown route returns 404
  it('unknown route returns 404', async () => {
    engine = createEngine();
    const response = await handleRequest(request('GET', '/v1/unknown'), engine);

    expect(response.status).toBe(404);
    const body = (await json(response)) as { error: string };
    expect(body.error).toBeDefined();
  });

  it('returns 400 for malformed percent-encoding in a route parameter', async () => {
    engine = createEngine();

    const response = await handleRequest(request('GET', '/v1/workflows/%E0%A4%A/result'), engine);

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Malformed route parameter encoding' });
  });

  it('returns 400 for malformed percent-encoding in top-level route matching', async () => {
    engine = createEngine();

    const response = await handleRequest(request('GET', '/v1/workflows/%E0%A4%A/history'), engine);

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Malformed route parameter encoding' });
  });

  it('returns 500 when rest bindings and the operation registry are not supplied together', async () => {
    engine = createEngine();

    const response = await handleRequest(request('GET', '/v1/unknown'), engine, {
      restBindings: [],
    });

    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({
      error: '`restBindings` and `operationRegistry` must be supplied together (or both omitted).',
    });
  });

  it('returns 500 when unexpected route-matching errors escape the malformed-route boundary', async () => {
    engine = createEngine();

    const restBindings: ReadonlyArray<UnknownRestBinding> = [
      {
        get method(): 'GET' {
          throw new Error('binding lookup exploded');
        },
        path: '/v1/workflows/:id',
        pathParamNames: ['id'],
        operationName: 'explosive.binding',
        inputSources: {},
        async extractInput() {
          return {};
        },
        success: { kind: 'json', status: 200 },
      },
    ];

    const recordedCalls: unknown[][] = [];
    const originalError = console.error;
    console.error = ((...args: unknown[]) => {
      recordedCalls.push(args);
    }) as typeof console.error;

    let response: Response;
    try {
      response = await handleRequest(request('GET', '/v1/workflows/test-workflow'), engine, {
        restBindings,
        operationRegistry: {} as never,
      });
    } finally {
      console.error = originalError;
    }

    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ error: 'Internal server error' });
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0]?.[0]).toBe('Unhandled error in handleRequest route matching');
    expect(recordedCalls[0]?.[1]).toMatchObject({
      method: 'GET',
      path: '/v1/workflows/test-workflow',
      error: expect.objectContaining({ message: 'binding lookup exploded' }),
    });
  });

  it('getRequiredRouteParameter throws a descriptive error when a parameter is missing', () => {
    expect(() => getRequiredRouteParameter({}, 'id', 'GET /v1/workflows/broken-id')).toThrow(
      'Missing route parameter "id" for GET /v1/workflows/broken-id',
    );
  });

  // 11. Start workflow with custom id
  it('POST /v1/workflows with custom id uses that id', async () => {
    engine = createEngine();
    const customId = 'my-custom-workflow-id';

    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data', id: customId }),
      engine,
    );

    expect(response.status).toBe(201);
    const body = (await json(response)) as { id: string };
    expect(body.id).toBe(customId);
  });

  it('POST /v1/workflows/purge manually triggers retention cleanup for matching terminal workflows', async () => {
    engine = createEngine();
    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'keep', id: 'purge-keep' }),
      engine,
    );
    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'delete', id: 'purge-delete' }),
      engine,
    );
    await flush();

    const response = await handleRequest(
      request('POST', '/v1/workflows/purge', {
        filter: {
          status: 'completed',
          type: 'echo',
        },
      }),
      engine,
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ deleted: 2 });
    expect(await engine.get('purge-keep')).toBeNull();
    expect(await engine.get('purge-delete')).toBeNull();
  });

  it('POST /v1/workflows/purge accepts an empty request body', async () => {
    engine = createEngine();
    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'delete', id: 'purge-empty-body' }),
      engine,
    );
    await flush();

    const response = await handleRequest(request('POST', '/v1/workflows/purge'), engine);

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ deleted: 1 });
    expect(await engine.get('purge-empty-body')).toBeNull();
  });

  it('POST /v1/workflows/purge rejects non-object bodies and treats an omitted filter as unfiltered', async () => {
    engine = createEngine();
    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'delete', id: 'purge-no-filter' }),
      engine,
    );
    await flush();

    const nonObjectBodyResponse = await handleRequest(
      new Request('http://localhost/v1/workflows/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '"not-an-object"',
      }),
      engine,
    );

    expect(nonObjectBodyResponse.status).toBe(400);
    expect(await json(nonObjectBodyResponse)).toEqual({
      error: 'Request body must be a JSON object',
    });

    const omittedFilterResponse = await handleRequest(
      request('POST', '/v1/workflows/purge', { note: 'ignored' }),
      engine,
    );

    expect(omittedFilterResponse.status).toBe(200);
    expect(await json(omittedFilterResponse)).toEqual({ deleted: 1 });
    expect(await engine.get('purge-no-filter')).toBeNull();
  });

  it('POST /v1/workflows/purge honors attribute filters, offset, and limit', async () => {
    engine = createEngine();
    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'one', id: 'purge-filter-1' }),
      engine,
    );
    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'two', id: 'purge-filter-2' }),
      engine,
    );
    await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'other', id: 'purge-filter-3' }),
      engine,
    );
    await flush();
    await engine.setAttributes('purge-filter-1', { bucket: 'target' });
    await engine.setAttributes('purge-filter-2', { bucket: 'target' });
    await engine.setAttributes('purge-filter-3', { bucket: 'other' });

    const response = await handleRequest(
      request('POST', '/v1/workflows/purge', {
        filter: {
          status: 'completed',
          attributes: [{ key: 'bucket', value: 'target' }],
          offset: 1,
          limit: 1,
        },
      }),
      engine,
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ deleted: 1 });
    expect(await engine.get('purge-filter-1')).not.toBeNull();
    expect(await engine.get('purge-filter-2')).toBeNull();
    expect(await engine.get('purge-filter-3')).not.toBeNull();
  });

  it('POST /v1/workflows/purge rejects malformed JSON and invalid filter bodies', async () => {
    engine = createEngine();

    const invalidJsonResponse = await handleRequest(
      new Request('http://localhost/v1/workflows/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"filter":',
      }),
      engine,
    );
    expect(invalidJsonResponse.status).toBe(400);

    const invalidAttributesResponse = await handleRequest(
      request('POST', '/v1/workflows/purge', {
        filter: {
          attributes: [{ key: '' }],
        },
      }),
      engine,
    );
    expect(invalidAttributesResponse.status).toBe(400);
    expect(await json(invalidAttributesResponse)).toEqual({
      error: 'Field "filter.attributes[0].key" must be a non-empty string',
    });

    const invalidStatusResponse = await handleRequest(
      request('POST', '/v1/workflows/purge', {
        filter: {
          status: [1],
        },
      }),
      engine,
    );
    expect(invalidStatusResponse.status).toBe(400);
    expect(await json(invalidStatusResponse)).toEqual({
      error: 'Field "filter.status" must be a string or an array of strings',
    });

    const missingFilterResponse = await handleRequest(
      request('POST', '/v1/workflows/purge', { note: 'no filter here' }),
      engine,
    );
    expect(missingFilterResponse.status).toBe(200);
    expect(await json(missingFilterResponse)).toEqual({ deleted: 0 });

    const nonObjectBodyResponse = await handleRequest(
      request('POST', '/v1/workflows/purge', ['not-an-object']),
      engine,
    );
    expect(nonObjectBodyResponse.status).toBe(400);
    expect(await json(nonObjectBodyResponse)).toEqual({
      error: 'Field "filter" must be an object',
    });
  });

  describe('bulk workflow routes', () => {
    it('POST /v1/workflows/bulk/cancel returns counts and cancels matching workflows', async () => {
      engine = createEngine();
      engine.register(waitingWorkflow);

      await engine.start('waiting', 'one', { id: 'bulk-route-cancel-a', tags: ['bulk-route'] });
      await engine.start('waiting', 'two', { id: 'bulk-route-cancel-b', tags: ['bulk-route'] });
      await engine.start('waiting', 'other', { id: 'bulk-route-cancel-other', tags: ['other'] });

      await Promise.all([
        waitForWorkflowStatus(engine, 'bulk-route-cancel-a', 'running'),
        waitForWorkflowStatus(engine, 'bulk-route-cancel-b', 'running'),
        waitForWorkflowStatus(engine, 'bulk-route-cancel-other', 'running'),
      ]);

      const previewResponse = await handleRequest(
        request('POST', '/v1/workflows/bulk/cancel', {
          filter: { tags: ['bulk-route'] },
          dryRun: true,
          requestId: 'bulk-route-cancel',
        }),
        engine,
        apiKeyAuth(),
      );
      expect(previewResponse.status).toBe(200);
      const preview = await json(previewResponse);

      const response = await handleRequest(
        request('POST', '/v1/workflows/bulk/cancel', {
          filter: { tags: ['bulk-route'] },
          confirmationToken: confirmationTokenFromPreview(preview),
          requestId: 'bulk-route-cancel',
        }),
        engine,
        apiKeyAuth(),
      );
      expect(response.status).toBe(200);
      expect(await json(response)).toEqual(
        expect.objectContaining({
          cancelled: 2,
          failed: 0,
          errors: [],
          auditEvent: expect.objectContaining({ requestId: 'bulk-route-cancel' }),
        }),
      );
      const firstCancelledState = await engine.get('bulk-route-cancel-a');
      const secondCancelledState = await engine.get('bulk-route-cancel-b');
      const untouchedState = await engine.get('bulk-route-cancel-other');
      expect(firstCancelledState?.status).toBe('cancelled');
      expect(secondCancelledState?.status).toBe('cancelled');
      expect(untouchedState?.status).toBe('running');

      await engine.cancel('bulk-route-cancel-other');
    });

    it('POST /v1/workflows/bulk/signal returns counts and signals matching workflows', async () => {
      engine = createEngine();
      engine.register(waitingWorkflow);

      const firstHandle = await engine.start('waiting', 'first', {
        id: 'bulk-route-signal-a',
        tags: ['bulk-route-signal'],
      });
      const secondHandle = await engine.start('waiting', 'second', {
        id: 'bulk-route-signal-b',
        tags: ['bulk-route-signal'],
      });
      const untouchedHandle = await engine.start('waiting', 'other', {
        id: 'bulk-route-signal-other',
        tags: ['other'],
      });

      await Promise.all([
        waitForWorkflowStatus(engine, firstHandle.id, 'running'),
        waitForWorkflowStatus(engine, secondHandle.id, 'running'),
        waitForWorkflowStatus(engine, untouchedHandle.id, 'running'),
      ]);

      const previewResponse = await handleRequest(
        request('POST', '/v1/workflows/bulk/signal', {
          filter: { tags: ['bulk-route-signal'] },
          name: 'continue',
          payload: 'released',
          dryRun: true,
          requestId: 'bulk-route-signal',
        }),
        engine,
        apiKeyAuth(),
      );
      expect(previewResponse.status).toBe(200);
      const preview = await json(previewResponse);

      const response = await handleRequest(
        request('POST', '/v1/workflows/bulk/signal', {
          filter: { tags: ['bulk-route-signal'] },
          name: 'continue',
          payload: 'released',
          confirmationToken: confirmationTokenFromPreview(preview),
          requestId: 'bulk-route-signal',
        }),
        engine,
        apiKeyAuth(),
      );
      expect(response.status).toBe(200);
      expect(await json(response)).toEqual(
        expect.objectContaining({
          signalled: 2,
          failed: 0,
          auditEvent: expect.objectContaining({ requestId: 'bulk-route-signal' }),
        }),
      );
      await expect(firstHandle.result()).resolves.toBe('first:released');
      await expect(secondHandle.result()).resolves.toBe('second:released');
      const untouchedState = await engine.get(untouchedHandle.id);
      expect(untouchedState?.status).toBe('running');

      await engine.signal(untouchedHandle.id, 'continue', 'cleanup');
      await untouchedHandle.result();
    });

    it('DELETE /v1/workflows/bulk returns 422 when running workflows would match', async () => {
      engine = createEngine();
      engine.register(waitingWorkflow);

      const completedHandle = await engine.start('echo', 'done', {
        id: 'bulk-route-delete-completed',
        tags: ['bulk-route-delete'],
      });
      await completedHandle.result();

      const runningHandle = await engine.start('waiting', 'pending', {
        id: 'bulk-route-delete-running',
        tags: ['bulk-route-delete'],
      });
      await waitForWorkflowStatus(engine, runningHandle.id, 'running');

      const response = await handleRequest(
        request('DELETE', '/v1/workflows/bulk', {
          filter: { tags: ['bulk-route-delete'] },
          dryRun: true,
        }),
        engine,
        apiKeyAuth(),
      );

      expect(response.status).toBe(422);
      expect(await json(response)).toEqual({
        error: 'Bulk delete matches non-terminal workflows',
      });
      expect(await engine.get('bulk-route-delete-completed')).not.toBeNull();
      expect(await engine.get('bulk-route-delete-running')).not.toBeNull();

      await engine.cancel(runningHandle.id);
    });

    it('DELETE /v1/workflows/bulk deletes matching terminal workflows', async () => {
      engine = createEngine();

      const firstHandle = await engine.start('echo', 'one', {
        id: 'bulk-route-delete-a',
        tags: ['bulk-route-delete-only'],
      });
      const secondHandle = await engine.start('echo', 'two', {
        id: 'bulk-route-delete-b',
        tags: ['bulk-route-delete-only'],
      });
      await firstHandle.result();
      await secondHandle.result();

      const previewResponse = await handleRequest(
        request('DELETE', '/v1/workflows/bulk', {
          filter: { tags: ['bulk-route-delete-only'] },
          dryRun: true,
          requestId: 'bulk-route-delete',
        }),
        engine,
        apiKeyAuth(),
      );
      expect(previewResponse.status).toBe(200);
      const preview = await json(previewResponse);

      const response = await handleRequest(
        request('DELETE', '/v1/workflows/bulk', {
          filter: { tags: ['bulk-route-delete-only'] },
          confirmationToken: confirmationTokenFromPreview(preview),
          requestId: 'bulk-route-delete',
        }),
        engine,
        apiKeyAuth(),
      );
      expect(response.status).toBe(200);
      expect(await json(response)).toEqual(
        expect.objectContaining({
          deleted: 2,
          auditEvent: expect.objectContaining({ requestId: 'bulk-route-delete' }),
        }),
      );
      expect(await engine.get('bulk-route-delete-a')).toBeNull();
      expect(await engine.get('bulk-route-delete-b')).toBeNull();
    });

    it('PATCH /v1/workflows/bulk/tags adds and removes tags on matching workflows', async () => {
      engine = createEngine();

      const firstHandle = await engine.start('echo', 'one', {
        id: 'bulk-route-tags-a',
        tags: ['selected'],
      });
      const secondHandle = await engine.start('echo', 'two', {
        id: 'bulk-route-tags-b',
        tags: ['selected'],
      });
      await firstHandle.result();
      await secondHandle.result();

      const addPreviewResponse = await handleRequest(
        request('PATCH', '/v1/workflows/bulk/tags', {
          filter: { tags: ['selected'] },
          tags: ['bulk'],
          operation: 'add',
          dryRun: true,
          requestId: 'bulk-route-tags-add',
        }),
        engine,
        apiKeyAuth(),
      );
      expect(addPreviewResponse.status).toBe(200);
      const addPreview = await json(addPreviewResponse);

      const addResponse = await handleRequest(
        request('PATCH', '/v1/workflows/bulk/tags', {
          filter: { tags: ['selected'] },
          tags: ['bulk'],
          operation: 'add',
          confirmationToken: confirmationTokenFromPreview(addPreview),
          requestId: 'bulk-route-tags-add',
        }),
        engine,
        apiKeyAuth(),
      );
      expect(addResponse.status).toBe(200);
      expect(await json(addResponse)).toEqual(
        expect.objectContaining({
          modified: 2,
          auditEvent: expect.objectContaining({ requestId: 'bulk-route-tags-add' }),
        }),
      );
      const addedTagsState = await engine.get('bulk-route-tags-a');
      expect(addedTagsState?.tags).toEqual(['bulk', 'selected']);

      const removePreviewResponse = await handleRequest(
        request('PATCH', '/v1/workflows/bulk/tags', {
          filter: { tags: ['bulk'] },
          tags: ['selected'],
          operation: 'remove',
          dryRun: true,
          requestId: 'bulk-route-tags-remove',
        }),
        engine,
        apiKeyAuth(),
      );
      expect(removePreviewResponse.status).toBe(200);
      const removePreview = await json(removePreviewResponse);

      const removeResponse = await handleRequest(
        request('PATCH', '/v1/workflows/bulk/tags', {
          filter: { tags: ['bulk'] },
          tags: ['selected'],
          operation: 'remove',
          confirmationToken: confirmationTokenFromPreview(removePreview),
          requestId: 'bulk-route-tags-remove',
        }),
        engine,
        apiKeyAuth(),
      );
      expect(removeResponse.status).toBe(200);
      expect(await json(removeResponse)).toEqual(
        expect.objectContaining({
          modified: 2,
          auditEvent: expect.objectContaining({ requestId: 'bulk-route-tags-remove' }),
        }),
      );
      const firstRemovedTagsState = await engine.get('bulk-route-tags-a');
      const secondRemovedTagsState = await engine.get('bulk-route-tags-b');
      expect(firstRemovedTagsState?.tags).toEqual(['bulk']);
      expect(secondRemovedTagsState?.tags).toEqual(['bulk']);
    });

    it('PATCH /v1/workflows/bulk/tags validates the operation field', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('PATCH', '/v1/workflows/bulk/tags', {
          filter: { tags: ['selected'] },
          tags: ['bulk'],
          operation: 'rename',
        }),
        engine,
        apiKeyAuth(),
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        error: 'Field "operation" must be "add" or "remove"',
      });
    });

    it('bulk workflow routes reject missing or unscoped filters', async () => {
      engine = createEngine();

      const missingFilterResponse = await handleRequest(
        request('POST', '/v1/workflows/bulk/cancel', {}),
        engine,
        apiKeyAuth(),
      );

      expect(missingFilterResponse.status).toBe(400);
      expect(await json(missingFilterResponse)).toEqual({
        error:
          'Field "filter" must include at least one of status, type, scheduleId, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
      });

      const emptyTagsResponse = await handleRequest(
        request('POST', '/v1/workflows/bulk/cancel', {
          filter: { tags: [] },
        }),
        engine,
        apiKeyAuth(),
      );

      expect(emptyTagsResponse.status).toBe(400);
      expect(await json(emptyTagsResponse)).toEqual({
        error:
          'Field "filter" must include at least one of status, type, scheduleId, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
      });

      const emptyAttributesResponse = await handleRequest(
        request('POST', '/v1/workflows/bulk/cancel', {
          filter: { attributes: [] },
        }),
        engine,
        apiKeyAuth(),
      );

      expect(emptyAttributesResponse.status).toBe(400);
      expect(await json(emptyAttributesResponse)).toEqual({
        error:
          'Field "filter" must include at least one of status, type, scheduleId, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
      });

      const blankAttributeKeyResponse = await handleRequest(
        request('POST', '/v1/workflows/bulk/cancel', {
          filter: { attributes: [{ key: '   ' }] },
        }),
        engine,
        apiKeyAuth(),
      );

      expect(blankAttributeKeyResponse.status).toBe(400);
      expect(await json(blankAttributeKeyResponse)).toEqual({
        error:
          'Field "filter" must include at least one of status, type, scheduleId, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
      });
    });
  });

  // 12. Start workflow with executionTimeout passes it through
  it('POST /v1/workflows with executionTimeout passes it through', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        input: 'data',
        executionTimeout: 30000,
      }),
      engine,
    );

    expect(response.status).toBe(201);
    const { id } = (await json(response)) as { id: string };
    await flush();

    // Verify the workflow was created (state check)
    const stateResponse = await handleRequest(request('GET', `/v1/workflows/${id}`), engine);
    expect(stateResponse.status).toBe(200);
    const state = (await json(stateResponse)) as { executionDeadline?: number };
    expect(state.executionDeadline).toBeDefined();
  });

  it('POST /v1/workflows accepts a custom id with storage key separators', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        input: 'data',
        id: 'wf:ckpt/with spaces',
      }),
      engine,
    );

    expect(response.status).toBe(201);
    const body = (await json(response)) as { id: string };
    expect(body.id).toBe('wf:ckpt/with spaces');
  });

  it('POST /v1/workflows rejects custom ids with control characters', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        input: 'data',
        id: 'wf-control\nid',
      }),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      error: 'Field "id" must not contain control characters',
    });
  });

  it('POST /v1/workflows with startAt keeps the workflow pending until it is due', async () => {
    engine = createEngine();
    const startAt = Date.now() + 60_000;

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        input: 'data',
        startAt,
      }),
      engine,
    );

    expect(response.status).toBe(201);
    const { id } = (await json(response)) as { id: string };

    const stateResponse = await handleRequest(request('GET', `/v1/workflows/${id}`), engine);
    expect(stateResponse.status).toBe(200);
    const state = (await json(stateResponse)) as { status: string };
    expect(state.status).toBe('pending');
  });

  it('POST /v1/workflows with both startAt and startAfter returns 400', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        input: 'data',
        startAt: Date.now() + 60_000,
        startAfter: '1m',
      }),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('Provide only one of startAt or startAfter');
  });

  it('POST /v1/workflows with a negative startAt returns 400', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        input: 'data',
        startAt: -1,
      }),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('Field "startAt"');
  });

  it('POST /v1/workflows with a negative startAfter returns 400', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        input: 'data',
        startAfter: -1,
      }),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('Field "startAfter"');
  });

  it('POST /v1/workflows with a negative executionTimeout returns 400', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        input: 'data',
        executionTimeout: -1,
      }),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('Field "executionTimeout"');
  });

  // Additional edge cases
  it('POST /v1/workflows with invalid JSON returns 400', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('http://localhost/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{',
      }),
      engine,
    );

    expect(response.status).toBe(400);
  });

  it('GET /v1/workflows with limit and offset paginates results', async () => {
    engine = createEngine();

    // Start three workflows
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 2 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 3 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?limit=2&offset=1'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      items: unknown[];
      total: number;
      offset: number;
      limit: number;
    };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(3);
    expect(body.offset).toBe(1);
    expect(body.limit).toBe(2);
  });

  // Limit/offset boundary validation
  it('GET /v1/workflows?limit=-1 returns all workflows (negative limit ignored)', async () => {
    engine = createEngine();

    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 2 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?limit=-1'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('GET /v1/workflows?limit=0 returns all workflows (zero limit ignored)', async () => {
    engine = createEngine();

    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 2 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?limit=0'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('GET /v1/workflows?limit=abc returns all workflows (NaN limit ignored)', async () => {
    engine = createEngine();

    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 2 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?limit=abc'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('GET /v1/workflows?limit=99999999999 does not crash (clamps to 1000)', async () => {
    engine = createEngine();

    const response = await handleRequest(request('GET', '/v1/workflows?limit=99999999999'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[] };
    // No crash; 0 workflows exist so items is empty
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('GET /v1/workflows?limit=2.9 floors to 2', async () => {
    engine = createEngine();

    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 2 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 3 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?limit=2.9'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number; limit: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(3);
    expect(body.limit).toBe(2);
  });

  it('GET /v1/workflows?offset=-5 is ignored (offset stays undefined)', async () => {
    engine = createEngine();

    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 2 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?offset=-5'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number };
    // All items returned because the invalid offset was ignored
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('GET /v1/workflows?type=echo filters by type', async () => {
    engine = createEngine();

    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?type=echo'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(1);

    // Filter for a type that does not exist
    const emptyResponse = await handleRequest(
      request('GET', '/v1/workflows?type=nonexistent'),
      engine,
    );

    expect(emptyResponse.status).toBe(200);
    const emptyBody = (await json(emptyResponse)) as { items: unknown[]; total: number };
    expect(emptyBody.items.length).toBe(0);
  });

  it('GET /v1/workflows parses multiple statuses and typed attribute filters', async () => {
    engine = createEngine();
    let capturedFilter: Record<string, unknown> | undefined;
    const originalList = engine.list.bind(engine);
    engine.list = async (filter) => {
      capturedFilter = filter as Record<string, unknown>;
      return originalList(filter);
    };

    const response = await handleRequest(
      request(
        'GET',
        '/v1/workflows?status=running&status=failed&attr.priority=high&attr.score.gt=1&attr.score.lt=9&attr.score.gte=2&attr.score.lte=8&attr.active=true&attr.disabled=false&attr.ignored.bad=123',
      ),
      engine,
    );

    expect(response.status).toBe(200);
    expect(capturedFilter).toMatchObject({
      status: ['running', 'failed'],
      attributes: [
        { key: 'priority', value: 'high' },
        { key: 'score', gt: 1, lt: 9, gte: 2, lte: 8 },
        { key: 'active', value: true },
        { key: 'disabled', value: false },
      ],
    });
    expect(JSON.stringify(capturedFilter)).not.toContain('ignored');
  });

  it('POST /v1/workflows with unregistered type returns 400', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: 'nonexistent', input: 'data' }),
      engine,
    );

    expect(response.status).toBe(400);
  });

  it('GET /v1/workflows/:id/result returns result for completed workflow', async () => {
    engine = createEngine();

    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'hello' }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };
    await flush();

    const response = await handleRequest(request('GET', `/v1/workflows/${id}/result`), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { result: unknown };
    expect(body.result).toBe('hello');
  });

  // --- Additional coverage tests ---

  it('POST /v1/workflows with null body returns 400', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('http://localhost/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(null),
      }),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('JSON object');
  });

  it('POST /v1/workflows with empty string type returns 400', async () => {
    engine = createEngine();
    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: '', input: 'data' }),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('type');
  });

  it('POST /v1/workflows with duplicate id returns 409', async () => {
    engine = createEngine();

    const firstResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'first', id: 'dup-id' }),
      engine,
    );
    expect(firstResponse.status).toBe(201);

    const secondResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'second', id: 'dup-id' }),
      engine,
    );
    expect(secondResponse.status).toBe(409);
    const body = (await json(secondResponse)) as { error: string };
    expect(body.error).toContain('already exists');
  });

  it('POST /v1/workflows with engine.start error returns 500', async () => {
    engine = createEngine();

    // Register a workflow that throws a generic (non-matching) error on start
    engine.register(errorOnStartWorkflow);

    // The 500 path is for errors that don't match "No workflow registered" or "already exists".
    // We can trigger it by making the engine throw something unexpected.
    // Actually, the start itself may succeed (it returns a handle) and the error happens later.
    // Let's test by overriding engine.start to throw.
    const originalStart = engine.start.bind(engine);
    engine.start = async () => {
      throw new Error('unexpected engine error');
    };

    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data' }),
      engine,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    const body = (await json(response)) as { error: string };
    expect(body.error).toBe('Internal server error');

    // Restore original
    engine.start = originalStart;
  });

  it('POST /v1/workflows returns 400 when engine.start throws a validation error', async () => {
    engine = createEngine();

    const originalStart = engine.start.bind(engine);
    engine.start = async () => {
      throw new StartWorkflowValidationError('Field "id" must be a string');
    };

    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data' }),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Field "id" must be a string' });

    engine.start = originalStart;
  });

  it('POST /v1/workflows/nonexistent/signal/test signals non-existent workflow', async () => {
    engine = createEngine();

    // Signal a workflow that doesn't exist. The engine.signal doesn't throw for
    // non-existent workflows (it just writes to storage), so this should still
    // succeed with 200.
    const response = await handleRequest(
      request('POST', '/v1/workflows/nonexistent-wf/signal/test-signal', {
        payload: 'test-data',
      }),
      engine,
    );

    // engine.signal doesn't throw for non-existent workflows
    expect(response.status).toBe(200);
  });

  it('POST /v1/workflows/:id/signal/:name with invalid JSON body still works', async () => {
    engine = createEngine();

    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data' }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };

    // Send signal with no body (empty)
    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${id}/signal/my-signal`, {
        method: 'POST',
      }),
      engine,
    );

    expect(response.status).toBe(200);
  });

  it('DELETE /v1/workflows/:id returns 500 when cancel throws', async () => {
    engine = createEngine();

    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('cancel failed internally');
    };

    const response = await handleRequest(request('DELETE', '/v1/workflows/some-id'), engine);

    expect(response.status).toBe(500);
    // EngineFailure is masked to a generic body; the raw engine message
    // never reaches REST clients.
    expect(await json(response)).toEqual({ error: 'Internal server error' });

    engine.cancel = originalCancel;
  });

  it('DELETE /v1/workflows/:id returns 404 when cancel reports not found', async () => {
    engine = createEngine();

    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('workflow not found');
    };

    const response = await handleRequest(request('DELETE', '/v1/workflows/missing-id'), engine);

    expect(response.status).toBe(404);
    expect(await json(response)).toMatchObject({ error: 'workflow not found' });

    engine.cancel = originalCancel;
  });

  it('POST /v1/workflows/:id/signal/:name returns 404 when signal throws not found', async () => {
    engine = createEngine();

    const originalSignal = engine.signal.bind(engine);
    engine.signal = async () => {
      throw new Error('Workflow not found');
    };

    const response = await handleRequest(
      request('POST', '/v1/workflows/missing-wf/signal/test', { payload: 'data' }),
      engine,
    );

    expect(response.status).toBe(404);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('not found');

    engine.signal = originalSignal;
  });

  it('POST /v1/workflows/:id/signal/:name returns 500 on unexpected signal error', async () => {
    engine = createEngine();

    const originalSignal = engine.signal.bind(engine);
    engine.signal = async () => {
      throw new Error('unexpected signal error');
    };

    const response = await handleRequest(
      request('POST', '/v1/workflows/wf/signal/test', { payload: 'data' }),
      engine,
    );

    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ error: 'Internal server error' });

    engine.signal = originalSignal;
  });

  it('GET /v1/workflows/:id/result returns 404 for non-existent workflow', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows/nonexistent/result'),
      engine,
    );

    expect(response.status).toBe(404);
  });

  it('GET /v1/workflows/:id/result returns 422 for failed workflow', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });

    engine.register(echoWorkflow);

    engine.register(failingWorkflow);

    const handle = await engine.start('failing', null);
    // Wait for the failure to be recorded
    await handle.result().catch(() => {});
    await flush();

    const response = await handleRequest(
      request('GET', `/v1/workflows/${handle.id}/result`),
      engine,
    );

    expect(response.status).toBe(422);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('failed');
  });

  it('GET /v1/workflows/:id/result returns 422 with default message for failed workflow with no error', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });

    engine.register(echoWorkflow);

    engine.register(failingNoMessageWorkflow);

    const handle = await engine.start('failing-no-msg', null);
    await handle.result().catch(() => {});
    await flush();

    // Manually update the stored state to remove the error field
    const bytes = await storage.get(KEYS.workflow(handle.id));
    const state = decode(bytes!) as any;
    delete state.error;
    await storage.put(KEYS.workflow(handle.id), encode(state));

    const response = await handleRequest(
      request('GET', `/v1/workflows/${handle.id}/result`),
      engine,
    );

    expect(response.status).toBe(422);
    const body = (await json(response)) as { error: string };
    expect(body.error).toBe('Workflow failed');
  });

  it('GET /v1/workflows/:id/result returns 422 for cancelled workflow', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });

    engine.register(echoWorkflow);

    engine.register(cancellableWorkflow);

    const handle = await engine.start('cancellable', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();

    await engine.cancel(handle.id);
    await resultPromise;
    await flush();

    const response = await handleRequest(
      request('GET', `/v1/workflows/${handle.id}/result`),
      engine,
    );

    expect(response.status).toBe(422);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('cancelled');
  });

  it('GET /v1/workflows/:id/result returns 408 when running workflow times out', async () => {
    engine = createEngine();

    engine.register(longRunningWorkflow);

    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'long-running', input: null }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };
    await flush();

    // Test the timeout path by making handle.result() reject with Timeout
    const originalGetHandle = engine.getHandle.bind(engine);
    engine.getHandle = (workflowId: string) => {
      const handle = originalGetHandle(workflowId);
      handle.result = async () => {
        throw new Error('Timeout waiting for workflow result');
      };
      return handle;
    };

    const response = await handleRequest(request('GET', `/v1/workflows/${id}/result`), engine);

    expect(response.status).toBe(408);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('Timeout');

    engine.getHandle = originalGetHandle;
  });

  it('GET /v1/workflows/:id/result returns 500 when running workflow result rejects', async () => {
    engine = createEngine();

    engine.register(erroringWorkflow);

    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'erroring', input: null }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };
    await flush();

    const originalGetHandle = engine.getHandle.bind(engine);
    engine.getHandle = (workflowId: string) => {
      const handle = originalGetHandle(workflowId);
      handle.result = async () => {
        throw new Error('some unexpected error');
      };
      return handle;
    };

    const response = await handleRequest(request('GET', `/v1/workflows/${id}/result`), engine);

    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ error: 'Internal server error' });

    engine.getHandle = originalGetHandle;
  });

  // -------------------------------------------------------------------------
  // POST /v1/workflows/:id/update/:name — synchronous update
  // -------------------------------------------------------------------------

  describe('POST /v1/workflows/:id/update/:name', () => {
    it('creates update and returns result when response is written quickly', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      // Start a background poller that watches for new update requests
      // and immediately writes a response for them (simulating workflow processing)
      const coordinator = new UpdateCoordinator(storage);
      const control = { active: true };
      const poller = (async () => {
        while (control.active) {
          const pending = await coordinator.getPendingUpdates('upd-wf-1');
          for (const updateRequest of pending) {
            const operations = coordinator.buildResponseOperations(
              updateRequest.updateId,
              'upd-wf-1',
              { accepted: true },
            );
            await storage.batch(operations);
          }
          await sleepForTesting(10);
        }
      })();

      const response = await handleRequest(
        request('POST', '/v1/workflows/upd-wf-1/update/setName', {
          payload: { name: 'Alice' },
          timeout: 2000,
        }),
        engine,
      );

      control.active = false;
      await poller;

      expect(response.status).toBe(200);
      const body = (await json(response)) as { updateId: string; result: unknown };
      expect(body.updateId).toBeDefined();
      expect(body.result).toEqual({ accepted: true });
    });

    it('returns 408 when update times out', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      // No response is ever written, so the coordinator will time out
      const response = await handleRequest(
        request('POST', '/v1/workflows/timeout-wf/update/setName', {
          payload: { name: 'Alice' },
          timeout: 100,
        }),
        engine,
      );

      expect(response.status).toBe(408);
      const body = (await json(response)) as { error: string };
      expect(body.error).toContain('timed out');
    });

    it('returns 422 when the workflow is already terminal', async () => {
      engine = createEngine();

      const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);
      engine.submitCoordinatedUpdate = async () => {
        throw new WorkflowTerminalError('wf-terminal', 'completed');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/wf-terminal/update/setName', {
          payload: { name: 'Alice' },
        }),
        engine,
      );

      expect(response.status).toBe(422);
      expect(await json(response)).toMatchObject({
        error:
          'Cannot send update to workflow "wf-terminal": workflow is in terminal state "completed"',
      });

      engine.submitCoordinatedUpdate = originalSubmit;
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/updates/:updateId — poll update result
  // -------------------------------------------------------------------------

  describe('GET /v1/updates/:updateId', () => {
    it('returns 202 pending when update has no response', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      // Create an update request but no response
      const coordinator = new UpdateCoordinator(storage);
      const updateId = await coordinator.createRequest('wf-poll-1', 'setName', { name: 'Alice' });

      const response = await handleRequest(request('GET', `/v1/updates/${updateId}`), engine);

      expect(response.status).toBe(202);
      const body = (await json(response)) as { status: string };
      expect(body.status).toBe('pending');
    });

    it('returns 200 completed when update response exists', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      const coordinator = new UpdateCoordinator(storage);
      const updateId = await coordinator.createRequest('wf-poll-2', 'setName', { name: 'Bob' });
      const operations = coordinator.buildResponseOperations(updateId, 'wf-poll-2', {
        accepted: true,
      });
      await storage.batch(operations);

      const response = await handleRequest(request('GET', `/v1/updates/${updateId}`), engine);

      expect(response.status).toBe(200);
      const body = (await json(response)) as { status: string; result: unknown };
      expect(body.status).toBe('completed');
      expect(body.result).toEqual({ accepted: true });
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/workflows/:id/attributes — read attributes
  // -------------------------------------------------------------------------

  describe('GET /v1/workflows/:id/attributes', () => {
    it('returns attributes for a workflow', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      const attributes = { color: 'blue', count: 42 };
      await storage.put(KEYS.attribute('wf-attr-1'), encode(attributes));

      const response = await handleRequest(
        request('GET', '/v1/workflows/wf-attr-1/attributes'),
        engine,
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as Record<string, unknown>;
      expect(body['color']).toBe('blue');
      expect(body['count']).toBe(42);
    });

    it('returns 404 when no attributes exist', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('GET', '/v1/workflows/nonexistent/attributes'),
        engine,
      );

      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/workflows/:id/attributes — set attributes
  // -------------------------------------------------------------------------

  describe('PATCH /v1/workflows/:id/attributes', () => {
    it('sets attributes on a workflow', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      const response = await handleRequest(
        request('PATCH', '/v1/workflows/wf-patch-1/attributes', {
          attributes: { priority: 'high', score: 99 },
        }),
        engine,
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify attributes were written
      const stored = await storage.get(KEYS.attribute('wf-patch-1'));
      expect(stored).not.toBeNull();
      const decoded = decode(stored!) as Record<string, unknown>;
      expect(decoded['priority']).toBe('high');
      expect(decoded['score']).toBe(99);
    });

    it('merges with existing attributes', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      // Write initial attributes
      await storage.put(KEYS.attribute('wf-merge-1'), encode({ color: 'red', size: 'large' }));

      const response = await handleRequest(
        request('PATCH', '/v1/workflows/wf-merge-1/attributes', {
          attributes: { color: 'blue', weight: 10 },
        }),
        engine,
      );

      expect(response.status).toBe(200);

      const stored = await storage.get(KEYS.attribute('wf-merge-1'));
      const decoded = decode(stored!) as Record<string, unknown>;
      expect(decoded['color']).toBe('blue');
      expect(decoded['size']).toBe('large');
      expect(decoded['weight']).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/metrics — Prometheus metrics
  // -------------------------------------------------------------------------

  describe('GET /v1/metrics', () => {
    it('returns Prometheus-formatted metrics', async () => {
      engine = createEngine();

      const response = await handleRequest(request('GET', '/v1/metrics'), engine);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');

      const text = await response.text();
      expect(text).toContain('weft_workflow_started_total');
      expect(text).toContain('weft_workflow_completed_total');
      expect(text).toContain('weft_workflow_failed_total');
      expect(text).toContain('weft_workflow_active');
    });

    it('returns 503 with JSON error body when the custom exporter throws', async () => {
      engine = createEngine();

      const failingExporter = {
        serialize(): string {
          throw new Error('boom');
        },
      };

      // Silence the expected console.error from the handler and verify it
      // fired. We swap `console.error` for a recording function (parallel-
      // safe within this test because Bun runs tests in one file serially)
      // rather than `spyOn`, because `spyOn(console, 'error')` does not
      // reliably intercept in this context.
      const recordedCalls: unknown[][] = [];
      const originalError = console.error;
      console.error = ((...args: unknown[]) => {
        recordedCalls.push(args);
      }) as typeof console.error;
      let response: Response;
      try {
        response = await handleRequest(request('GET', '/v1/metrics'), engine, {
          prometheusExporter: failingExporter,
        });
      } finally {
        console.error = originalError;
      }

      expect(response.status).toBe(503);
      expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      expect(await json(response)).toEqual({ error: 'metrics exporter failed' });
      expect(recordedCalls).toHaveLength(1);
      const logged = recordedCalls[0]?.map(String).join(' ') ?? '';
      expect(logged).toContain('PrometheusExporter.serialize()');
    });

    it('returns 503 when an async exporter rejects', async () => {
      engine = createEngine();

      const failingExporter = {
        async serialize(): Promise<string> {
          throw new Error('async boom');
        },
      };

      const recordedCalls: unknown[][] = [];
      const originalError = console.error;
      console.error = ((...args: unknown[]) => {
        recordedCalls.push(args);
      }) as typeof console.error;
      let response: Response;
      try {
        response = await handleRequest(request('GET', '/v1/metrics'), engine, {
          prometheusExporter: failingExporter,
        });
      } finally {
        console.error = originalError;
      }

      expect(response.status).toBe(503);
      expect(await json(response)).toEqual({ error: 'metrics exporter failed' });
      expect(recordedCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Accept: application/msgpack content negotiation
  // -------------------------------------------------------------------------

  describe('Accept: application/msgpack', () => {
    it('returns msgpack-encoded response when Accept header is set', async () => {
      engine = createEngine();

      const response = await handleRequest(
        new Request('http://localhost/v1/health', {
          method: 'GET',
          headers: { Accept: 'application/msgpack' },
        }),
        engine,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/msgpack');

      const buffer = await response.arrayBuffer();
      const decoded = decode(new Uint8Array(buffer));
      expect(decoded).toEqual({ status: 'ok' });
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/workflows/:id/update/:name — idempotency and error paths
  // -------------------------------------------------------------------------

  describe('POST /v1/workflows/:id/update/:name (idempotency)', () => {
    it('returns cached result for duplicate idempotency key', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      const coordinator = new UpdateCoordinator(storage);

      // Set up a completed update with an idempotency key
      const updateId = await coordinator.createRequest(
        'idem-wf',
        'setName',
        { name: 'Alice' },
        {
          idempotencyKey: 'unique-key-1',
        },
      );
      const operations = coordinator.buildResponseOperations(
        updateId,
        'idem-wf',
        { accepted: true },
        undefined,
        'unique-key-1',
      );
      await storage.batch(operations);

      // Send request with the same idempotency key — should return cached result
      const response = await handleRequest(
        request('POST', '/v1/workflows/idem-wf/update/setName', {
          payload: { name: 'Alice' },
          timeout: 2000,
          idempotencyKey: 'unique-key-1',
        }),
        engine,
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { updateId: string; result: unknown };
      expect(body.updateId).toBe(updateId);
      expect(body.result).toEqual({ accepted: true });
    });

    it('passes idempotency key through to coordinator when no cached result exists', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      const coordinator = new UpdateCoordinator(storage);
      const control = { active: true };
      const poller = (async () => {
        while (control.active) {
          const pending = await coordinator.getPendingUpdates('idem-wf-new');
          for (const updateRequest of pending) {
            const ops = coordinator.buildResponseOperations(
              updateRequest.updateId,
              'idem-wf-new',
              { done: true },
              undefined,
              updateRequest.idempotencyKey,
            );
            await storage.batch(ops);
          }
          await sleepForTesting(10);
        }
      })();

      const response = await handleRequest(
        request('POST', '/v1/workflows/idem-wf-new/update/setName', {
          payload: { name: 'Bob' },
          timeout: 2000,
          idempotencyKey: 'new-key-1',
        }),
        engine,
      );

      control.active = false;
      await poller;

      expect(response.status).toBe(200);
      const body = (await json(response)) as { updateId: string; result: unknown };
      expect(body.updateId).toBeDefined();
      expect(body.result).toEqual({ done: true });
    });

    it('returns 422 when update response contains an error', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      const coordinator = new UpdateCoordinator(storage);
      const control = { active: true };
      const poller = (async () => {
        while (control.active) {
          const pending = await coordinator.getPendingUpdates('error-wf');
          for (const updateRequest of pending) {
            const ops = coordinator.buildResponseOperations(
              updateRequest.updateId,
              'error-wf',
              undefined,
              'Validation failed',
            );
            await storage.batch(ops);
          }
          await sleepForTesting(10);
        }
      })();

      const response = await handleRequest(
        request('POST', '/v1/workflows/error-wf/update/setName', {
          payload: { name: 'Bad' },
          timeout: 2000,
        }),
        engine,
      );

      control.active = false;
      await poller;

      expect(response.status).toBe(422);
      const body = (await json(response)) as { error: string };
      expect(body.error).toContain('Validation failed');
    });

    it('returns 500 when update throws a non-timeout error', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      // Override storage.get to throw during waitForResponse polling
      const originalGet = storage.get.bind(storage);
      let callCount = 0;
      storage.get = async (key: string) => {
        callCount++;
        // Let the initial createRequest succeed (first few calls), then throw
        // when waitForResponse polls for the response key
        if (key.startsWith('upr:') && callCount > 2) {
          throw new Error('Storage read failure');
        }
        return originalGet(key);
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/err-wf/update/setName', {
          payload: { name: 'Fail' },
          timeout: 500,
        }),
        engine,
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      const body = (await json(response)) as { error: string };
      expect(body.error).toBe('Internal server error');

      storage.get = originalGet;
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/workflows/:id/attributes — invalid JSON body
  // -------------------------------------------------------------------------

  describe('PATCH /v1/workflows/:id/attributes (error paths)', () => {
    it('returns 400 when body is invalid JSON', async () => {
      engine = createEngine();

      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/wf-bad-json/attributes', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: 'not valid json{',
        }),
        engine,
      );

      expect(response.status).toBe(400);
      const body = (await json(response)) as { error: string };
      expect(body.error).toContain('Invalid JSON body');
    });

    it('handles missing attributes field gracefully by using empty object', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      const response = await handleRequest(
        request('PATCH', '/v1/workflows/wf-no-attr/attributes', {}),
        engine,
      );

      expect(response.status).toBe(200);
    });
  });

  describe('POST/DELETE /v1/workflows/:id/tags (error paths)', () => {
    it('returns 400 when tag routes receive malformed JSON bodies', async () => {
      engine = createEngine();

      const invalidAddResponse = await handleRequest(
        new Request('http://localhost/v1/workflows/tag-route-invalid-add/tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"tags":',
        }),
        engine,
      );

      expect(invalidAddResponse.status).toBe(400);
      expect(await json(invalidAddResponse)).toEqual({ error: 'Invalid JSON body' });

      const invalidRemoveResponse = await handleRequest(
        new Request('http://localhost/v1/workflows/tag-route-invalid-remove/tags', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: '{"tags":',
        }),
        engine,
      );

      expect(invalidRemoveResponse.status).toBe(400);
      expect(await json(invalidRemoveResponse)).toEqual({ error: 'Invalid JSON body' });
    });

    it('returns 400 when POST /v1/workflows/:id/tags receives a null JSON body', async () => {
      engine = createEngine();
      await engine.start('echo', 'payload', { id: 'tag-route-null-add' });

      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/tag-route-null-add/tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'null',
        }),
        engine,
      );

      expect(response.status).toBe(400);
      const body = (await json(response)) as { error: string };
      expect(body.error).toBe('Invalid JSON body');
    });

    it('returns 400 when DELETE /v1/workflows/:id/tags receives an array JSON body', async () => {
      engine = createEngine();
      await engine.start('echo', 'payload', { id: 'tag-route-array-remove', tags: ['alpha'] });

      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/tag-route-array-remove/tags', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(['alpha']),
        }),
        engine,
      );

      expect(response.status).toBe(400);
      const body = (await json(response)) as { error: string };
      expect(body.error).toBe('Invalid JSON body');
    });

    it('returns 400 when tag routes receive malformed JSON payloads', async () => {
      engine = createEngine();
      await engine.start('echo', 'payload', { id: 'tag-route-malformed-json', tags: ['alpha'] });

      let response = await handleRequest(
        new Request('http://localhost/v1/workflows/tag-route-malformed-json/tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        }),
        engine,
      );
      expect(response.status).toBe(400);

      response = await handleRequest(
        new Request('http://localhost/v1/workflows/tag-route-malformed-json/tags', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        }),
        engine,
      );
      expect(response.status).toBe(400);
    });

    it('maps not found, validation, and unexpected tag route errors to the correct status codes', async () => {
      engine = createEngine();
      const originalAddTags = engine.addTags.bind(engine);
      const originalRemoveTags = engine.removeTags.bind(engine);

      try {
        engine.addTags = async () => {
          throw new Error('workflow not found');
        };
        let response = await handleRequest(
          request('POST', '/v1/workflows/missing/tags', { tags: ['alpha'] }),
          engine,
        );
        expect(response.status).toBe(404);

        engine.addTags = async () => {
          throw new StartWorkflowValidationError('invalid tags');
        };
        response = await handleRequest(
          request('POST', '/v1/workflows/missing/tags', { tags: ['alpha'] }),
          engine,
        );
        expect(response.status).toBe(400);

        engine.addTags = async () => {
          throw new Error('boom');
        };
        response = await handleRequest(
          request('POST', '/v1/workflows/missing/tags', { tags: ['alpha'] }),
          engine,
        );
        expect(response.status).toBe(500);

        engine.removeTags = async () => {
          throw new Error('workflow not found');
        };
        response = await handleRequest(
          request('DELETE', '/v1/workflows/missing/tags', { tags: ['alpha'] }),
          engine,
        );
        expect(response.status).toBe(404);

        engine.removeTags = async () => {
          throw new StartWorkflowValidationError('invalid tags');
        };
        response = await handleRequest(
          request('DELETE', '/v1/workflows/missing/tags', { tags: ['alpha'] }),
          engine,
        );
        expect(response.status).toBe(400);

        engine.removeTags = async () => {
          throw new Error('boom');
        };
        response = await handleRequest(
          request('DELETE', '/v1/workflows/missing/tags', { tags: ['alpha'] }),
          engine,
        );
        expect(response.status).toBe(500);
      } finally {
        engine.addTags = originalAddTags;
        engine.removeTags = originalRemoveTags;
      }
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/workflows/:id/events — workflow event history
  // -------------------------------------------------------------------------

  describe('GET /v1/workflows/:id/events', () => {
    it('returns 404 for non-existent workflow', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('GET', '/v1/workflows/nonexistent/events'),
        engine,
      );

      expect(response.status).toBe(404);
    });

    it('returns ordered events for an existing workflow', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      const startResponse = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo', input: 'hello' }),
        engine,
      );
      const { id } = (await json(startResponse)) as { id: string };
      await flush();

      // Insert events into storage using EventLog so they are written in the
      // correct WorkflowLogEntry format (with workflowId, sequence, prevHash).
      // The old approach wrote raw objects that the new EventLog.scan() guard
      // correctly filters out, causing the endpoint to return an empty list.
      const { EventLog } = await import('../core/event-log.ts');
      const log = new EventLog(storage, id);
      await log.append({ type: 'workflow:started', payload: { workflowId: id } });
      await log.append({ type: 'activity:started', payload: { workflowId: id } });
      await log.append({ type: 'workflow:completed', payload: { workflowId: id } });

      const response = await handleRequest(request('GET', `/v1/workflows/${id}/events`), engine);

      expect(response.status).toBe(200);
      const body = (await json(response)) as {
        events: Array<{ type: string; timestamp: number; data: Record<string, unknown> }>;
      };
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBeGreaterThanOrEqual(2);

      const types = body.events.map((e) => e.type);
      expect(types).toContain('workflow:started');
      expect(types).toContain('workflow:completed');

      // Events should be in chronological order (timestamps are assigned at append time)
      for (let i = 1; i < body.events.length; i++) {
        expect(body.events[i]!.timestamp).toBeGreaterThanOrEqual(body.events[i - 1]!.timestamp);
      }
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/reviews — list pending reviews
  // -------------------------------------------------------------------------

  describe('GET /v1/reviews', () => {
    it('returns empty items when no reviews exist', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('GET', '/v1/reviews'),
        engine,
        reviewReadApiKeyAuth(),
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { items: unknown[] };
      expect(body.items).toEqual([]);
    });

    it('returns reviews that have been stored', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      // Manually insert a review into storage
      const review = {
        reviewId: 'rev-1',
        workflowId: 'wf-1',
        artifact: { text: 'review me' },
        reviewType: 'manual',
        reviewers: ['alice'],
        allowPartial: false,
        createdAt: Date.now(),
      };
      await storage.put(KEYS.review('wf-1', 'rev-1'), encode(review));

      const response = await handleRequest(
        request('GET', '/v1/reviews'),
        engine,
        reviewReadApiKeyAuth(),
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { items: Array<{ reviewId: string }> };
      expect(body.items.length).toBe(1);
      expect(body.items[0]!.reviewId).toBe('rev-1');
    });

    it('supports completed-status and workflow-id filters', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      await storage.put(
        KEYS.review('wf-completed-filter', 'rev-completed-filter'),
        encode({
          reviewId: 'rev-completed-filter',
          workflowId: 'wf-completed-filter',
          artifact: { text: 'review me' },
          reviewType: 'manual',
          reviewers: ['alice'],
          allowPartial: false,
          createdAt: 1_234,
        }),
      );
      await engine.submitReview('rev-completed-filter', {
        decision: 'approved',
        reviewer: 'alice',
        workflowId: 'wf-completed-filter',
      });

      const response = await handleRequest(
        request(
          'GET',
          '/v1/reviews?status=completed&workflowId=wf-completed-filter&reviewType=manual',
        ),
        engine,
        reviewReadApiKeyAuth(),
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as {
        items: unknown[];
      };
      expect(body.items).toEqual([
        {
          reviewId: 'rev-completed-filter',
          status: 'completed',
          workflowId: 'wf-completed-filter',
          artifact: { text: 'review me' },
          reviewType: 'manual',
          reviewers: ['alice'],
          allowPartial: false,
          createdAt: 1_234,
          decision: 'approved',
          reviewer: 'alice',
          timestamp: expect.any(Number),
        },
      ]);
    });

    it('skips completed review records missing canonical request metadata', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });

      await storeHistoricalReviewDecisionWithoutRequestMetadata(storage);

      const response = await handleRequest(
        request('GET', '/v1/reviews?status=completed'),
        engine,
        reviewReadApiKeyAuth(),
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { items: unknown[] };
      expect(body.items).toEqual([]);
    });

    it('returns 400 for an invalid review status filter', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('GET', '/v1/reviews?status=not-a-status'),
        engine,
        reviewReadApiKeyAuth(),
      );

      expect(response.status).toBe(400);
      const body = (await json(response)) as { error: string };
      expect(body.error).toContain('status');
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/reviews/:reviewId/decision — submit review decision
  // -------------------------------------------------------------------------

  describe('POST /v1/reviews/:reviewId/decision', () => {
    it('returns 400 for invalid JSON body', async () => {
      engine = createEngine();

      const response = await handleRequest(
        new Request('http://localhost/v1/reviews/rev-1/decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not valid json',
        }),
        engine,
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 for missing required fields', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-1/decision', { decision: 'approved' }),
        engine,
      );

      expect(response.status).toBe(400);
      const body = (await json(response)) as { error: string };
      expect(body.error).toContain('decision');
    });

    it('returns 400 for invalid decision value', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-1/decision', {
          decision: 'maybe',
          reviewer: 'alice',
        }),
        engine,
      );

      expect(response.status).toBe(400);
      const body = (await json(response)) as { error: string };
      expect(body.error).toContain('Invalid decision');
    });

    it('returns 400 when feedback is not a string', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-1/decision', {
          decision: 'approved',
          reviewer: 'alice',
          feedback: 42,
        }),
        engine,
      );

      expect(response.status).toBe(400);
      const body = (await json(response)) as { error: string };
      expect(body.error).toContain('feedback');
    });

    it('returns 404 for non-existent review', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('POST', '/v1/reviews/nonexistent/decision', {
          decision: 'approved',
          reviewer: 'alice',
        }),
        engine,
      );

      expect(response.status).toBe(404);
    });

    it('returns 500 for unexpected review submission errors', async () => {
      engine = createEngine();

      const originalSubmitReview = engine.submitReview.bind(engine);
      engine.submitReview = async () => {
        throw new Error('review submission failed');
      };

      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-1/decision', {
          decision: 'approved',
          reviewer: 'alice',
        }),
        engine,
      );

      expect(response.status).toBe(500);
      expect(await json(response)).toEqual({ error: 'Internal server error' });

      engine.submitReview = originalSubmitReview;
    });

    it('resolves an existing review via direct key lookup when workflowId is provided', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      // Insert a review using the canonical key format
      const review = {
        reviewId: 'rev-2',
        workflowId: 'wf-2',
        artifact: { text: 'approve me' },
        reviewType: 'manual',
        reviewers: ['bob'],
        allowPartial: false,
        createdAt: Date.now(),
      };
      await storage.put(KEYS.review('wf-2', 'rev-2'), encode(review));

      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-2/decision', {
          decision: 'approved',
          reviewer: 'bob',
          workflowId: 'wf-2',
          feedback: 'Looks good',
        }),
        engine,
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify the review was removed from storage
      const reviewAfter = await storage.get(KEYS.review('wf-2', 'rev-2'));
      expect(reviewAfter).toBeNull();

      // Verify the decision was stored
      const decisionBytes = await storage.get(
        `review-decision:${encodeStorageKeyComponent('wf-2')}:${encodeStorageKeyComponent('rev-2')}`,
      );
      expect(decisionBytes).not.toBeNull();
      const decisionData = decode(decisionBytes!) as { decision: string; reviewer: string };
      expect(decisionData.decision).toBe('approved');
      expect(decisionData.reviewer).toBe('bob');
    });

    it('falls back to scan when workflowId is not provided', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      const review = {
        reviewId: 'rev-3',
        workflowId: 'wf-3',
        artifact: { text: 'approve me' },
        reviewType: 'manual',
        reviewers: ['alice'],
        allowPartial: false,
        createdAt: Date.now(),
      };
      await storage.put(KEYS.review('wf-3', 'rev-3'), encode(review));

      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-3/decision', {
          decision: 'rejected',
          reviewer: 'alice',
        }),
        engine,
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { ok: boolean };
      expect(body.ok).toBe(true);

      const reviewAfter = await storage.get(KEYS.review('wf-3', 'rev-3'));
      expect(reviewAfter).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/workflows/:id/review/:reviewId — get review details
  // -------------------------------------------------------------------------

  describe('GET /v1/workflows/:id/review/:reviewId', () => {
    it('returns review details when found', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register(echoWorkflow);

      const review = {
        reviewId: 'rev-detail',
        workflowId: 'wf-detail',
        artifact: { content: 'report' },
        reviewType: 'code-review',
        reviewers: ['charlie'],
        allowPartial: false,
        createdAt: Date.now(),
      };
      await storage.put(KEYS.review('wf-detail', 'rev-detail'), encode(review));

      const response = await handleRequest(
        request('GET', '/v1/workflows/wf-detail/review/rev-detail'),
        engine,
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { reviewId: string; reviewType: string };
      expect(body.reviewId).toBe('rev-detail');
      expect(body.reviewType).toBe('code-review');
    });

    it('returns 404 for non-existent review', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('GET', '/v1/workflows/wf-1/review/nonexistent'),
        engine,
      );

      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/workflows/:id/query/:name — query workflow state
  // -------------------------------------------------------------------------

  describe('GET /v1/workflows/:id/query/:name', () => {
    it('returns query result for a running workflow with exposed accessor', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });

      engine.register(queryableWorkflow);

      const handle = await engine.start('queryable', null);
      await flush();

      const response = await handleRequest(
        request('GET', `/v1/workflows/${handle.id}/query/counter`),
        engine,
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { result: unknown };
      expect(body.result).toBe(42);
    });

    it('returns null result when query name does not exist', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });

      engine.register(queryableSimpleWorkflow);

      const handle = await engine.start('queryable', null);
      await flush();

      const response = await handleRequest(
        request('GET', `/v1/workflows/${handle.id}/query/nonexistent`),
        engine,
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { result: unknown };
      expect(body.result).toBeNull();
    });

    it('returns null result when workflow context is not available', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('GET', '/v1/workflows/no-such-workflow/query/counter'),
        engine,
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { result: unknown };
      expect(body.result).toBeNull();
    });

    it('returns 501 when the workflow does not support queries', async () => {
      engine = createEngine();

      const originalQuery = engine.query.bind(engine);
      engine.query = async () => {
        throw new Error('query not supported for this workflow');
      };

      const response = await handleRequest(
        request('GET', '/v1/workflows/wf-query/query/status'),
        engine,
      );

      expect(response.status).toBe(501);
      expect(await json(response)).toMatchObject({
        error: 'query not supported for this workflow',
      });

      engine.query = originalQuery;
    });

    it('returns 500 for unexpected query errors', async () => {
      engine = createEngine();

      const originalQuery = engine.query.bind(engine);
      engine.query = async () => {
        throw new Error('query exploded');
      };

      const response = await handleRequest(
        request('GET', '/v1/workflows/wf-query/query/status'),
        engine,
      );

      expect(response.status).toBe(500);
      expect(await json(response)).toEqual({ error: 'Internal server error' });

      engine.query = originalQuery;
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/workflows/:id/resume — resume workflow from checkpoint
  // -------------------------------------------------------------------------

  describe('POST /v1/workflows/:id/resume', () => {
    it('returns 404 when workflow does not exist', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('POST', '/v1/workflows/nonexistent/resume'),
        engine,
      );

      expect(response.status).toBe(404);
    });

    it('returns 409 when workflow is not in running status', async () => {
      engine = createEngine();

      // Start and complete a workflow
      const startResponse = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo', input: 'done' }),
        engine,
      );
      const { id } = (await json(startResponse)) as { id: string };
      await flush();

      const response = await handleRequest(request('POST', `/v1/workflows/${id}/resume`), engine);

      expect(response.status).toBe(409);
      const body = (await json(response)) as { error: string };
      expect(body.error).toContain('status');
    });

    it('returns 500 for unexpected resume errors', async () => {
      engine = createEngine();

      const originalResume = engine.resume.bind(engine);
      engine.resume = async () => {
        throw new Error('resume exploded');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/wf-resume/resume'),
        engine,
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await json(response)).toMatchObject({ error: 'Internal server error' });

      engine.resume = originalResume;
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/recover — recover all running workflows
  // -------------------------------------------------------------------------

  describe('POST /v1/recover', () => {
    it('returns recovered workflow ids (empty when none running)', async () => {
      engine = createEngine();

      const response = await handleRequest(request('POST', '/v1/recover'), engine);

      expect(response.status).toBe(200);
      const body = (await json(response)) as { recovered: string[] };
      expect(body.recovered).toEqual([]);
    });

    it('returns recovered workflow ids when recoverAll returns handles', async () => {
      engine = createEngine();
      engine.recoverAll = async () =>
        [{ id: 'wf-recovered-1' }, { id: 'wf-recovered-2' }] as Awaited<
          ReturnType<Engine['recoverAll']>
        >;

      const response = await handleRequest(request('POST', '/v1/recover'), engine);

      expect(response.status).toBe(200);
      const body = (await json(response)) as { recovered: string[] };
      expect(body.recovered).toEqual(['wf-recovered-1', 'wf-recovered-2']);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/workflows/:id/timeout — force timeout a workflow
  // -------------------------------------------------------------------------

  describe('POST /v1/workflows/:id/timeout', () => {
    it('times out a running workflow and returns 204', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });

      engine.register(echoWorkflow);

      engine.register(longRunningNeverSignalWorkflow);

      const handle = await engine.start('long-running', null);
      const resultPromise = handle.result().catch(() => {});
      await flush();

      const response = await handleRequest(
        request('POST', `/v1/workflows/${handle.id}/timeout`),
        engine,
      );

      expect(response.status).toBe(204);
      await resultPromise;
      await flush();

      // Verify the workflow is now timed-out
      const stateResponse = await handleRequest(
        request('GET', `/v1/workflows/${handle.id}`),
        engine,
      );
      const state = (await json(stateResponse)) as { status: string };
      expect(state.status).toBe('timed-out');
    });

    it('returns 204 even for non-existent workflow (idempotent)', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('POST', '/v1/workflows/nonexistent/timeout'),
        engine,
      );

      // timeout() is idempotent — terminateWorkflow returns silently if state not found
      expect(response.status).toBe(204);
    });

    it('returns 404 when timeout reports not found', async () => {
      engine = createEngine();

      const originalTimeout = engine.timeout.bind(engine);
      engine.timeout = async () => {
        throw new Error('workflow not found');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/wf-timeout/timeout'),
        engine,
      );

      expect(response.status).toBe(404);
      expect(await json(response)).toMatchObject({ error: 'workflow not found' });

      engine.timeout = originalTimeout;
    });

    it('returns 500 for unexpected timeout errors', async () => {
      engine = createEngine();

      const originalTimeout = engine.timeout.bind(engine);
      engine.timeout = async () => {
        throw new Error('timeout exploded');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/wf-timeout/timeout'),
        engine,
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await json(response)).toMatchObject({ error: 'Internal server error' });

      engine.timeout = originalTimeout;
    });
  });

  it('GET /v1/workflows/:id/streams/:key returns stored stream chunks with sequence metadata', async () => {
    engine = createEngine();

    const originalGetStreamChunks = engine.getStreamChunks.bind(engine);
    engine.getStreamChunks = async () => [
      { sequence: 0, value: 'alpha' },
      { sequence: 1, value: { token: 'beta' } },
    ];

    const response = await handleRequest(
      request('GET', '/v1/workflows/wf-stream/streams/tokens'),
      engine,
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      chunks: [
        { sequence: 0, value: 'alpha' },
        { sequence: 1, value: { token: 'beta' } },
      ],
    });

    engine.getStreamChunks = originalGetStreamChunks;
  });

  it('GET /v1/workflows/:id/streams/:key forwards the after query parameter', async () => {
    engine = createEngine();

    const originalGetStreamChunks = engine.getStreamChunks.bind(engine);
    let receivedAfter: number | undefined;
    engine.getStreamChunks = async (_workflowId, _key, options) => {
      receivedAfter = options?.after;
      return [{ sequence: 2, value: 'charlie' }];
    };

    const response = await handleRequest(
      request('GET', '/v1/workflows/wf-stream/streams/tokens?after=1'),
      engine,
    );

    expect(response.status).toBe(200);
    expect(receivedAfter).toBe(1);
    expect(await json(response)).toEqual({
      chunks: [{ sequence: 2, value: 'charlie' }],
    });

    engine.getStreamChunks = originalGetStreamChunks;
  });

  it('GET /v1/workflows/:id/streams/:key returns 400 for an invalid after query parameter', async () => {
    engine = createEngine();

    for (const after of ['not-a-number', '0x10', '1e3']) {
      const response = await handleRequest(
        request('GET', `/v1/workflows/wf-stream/streams/tokens?after=${after}`),
        engine,
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        error: `Invalid after query parameter: ${after}`,
      });
    }
  });

  it('GET /v1/workflows/:id/streams/:key returns 400 for an empty after query parameter', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows/wf-stream/streams/tokens?after='),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: 'Invalid after query parameter: ',
    });
  });

  it('GET /v1/workflows/:id/streams/:key uses durable chunk sequences for SSE event ids', async () => {
    engine = createEngine();

    const originalGetStreamChunks = engine.getStreamChunks.bind(engine);
    engine.getStreamChunks = async (_workflowId, _key, options) => {
      expect(options?.after).toBe(2);
      return [
        { sequence: 3, value: 'alpha' },
        { sequence: 5, value: { done: true } },
      ];
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-stream/streams/tokens?after=2', {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      }),
      engine,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');

    const body = await response.text();
    expect(body).toContain('id: 3');
    expect(body).toContain('id: 5');
    expect(body).not.toContain('id: 4');
    expect(body).toContain('{"sequence":3,"value":"alpha"}');
    expect(body).toContain('{"sequence":5,"value":{"done":true}}');

    engine.getStreamChunks = originalGetStreamChunks;
  });

  // SSE streaming endpoint
  describe('GET /v1/workflows/:id/sse', () => {
    it('returns 406 when Accept header does not include text/event-stream', async () => {
      engine = createEngine();

      const startResponse = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo', input: 'data' }),
        engine,
      );
      const { id } = (await json(startResponse)) as { id: string };
      await flush();

      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/${id}/sse`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        }),
        engine,
      );

      expect(response.status).toBe(406);
    });

    it('returns 404 for unknown workflow', async () => {
      engine = createEngine();

      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/nonexistent/sse', {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        }),
        engine,
      );

      expect(response.status).toBe(404);
    });

    it('returns SSE format with correct content-type', async () => {
      engine = createEngine();

      const startResponse = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo', input: 'hello' }),
        engine,
      );
      const { id } = (await json(startResponse)) as { id: string };
      await flush();

      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/${id}/sse`, {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        }),
        engine,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-transform');
      expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    });

    it('SSE response body contains data: prefixed lines', async () => {
      engine = createEngine();

      const startResponse = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo', input: 'test' }),
        engine,
      );
      const { id } = (await json(startResponse)) as { id: string };
      await flush();

      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/${id}/sse`, {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        }),
        engine,
      );

      const body = await response.text();
      // Should contain at least the done event
      expect(body).toContain('event: done');
      expect(body).toContain('data: ');
    });

    it('streams string and token-object chunks while skipping unsupported shapes', async () => {
      engine = createEngine();

      const startResponse = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo', input: 'stream' }),
        engine,
      );
      const { id } = (await json(startResponse)) as { id: string };
      await flush();

      const originalGetStreamChunks = engine.getStreamChunks.bind(engine);
      let receivedAfter: number | undefined;
      engine.getStreamChunks = async (_workflowId, _key, options) => {
        receivedAfter = options?.after;
        return [
          { sequence: 3, value: 'alpha' },
          { sequence: 4, value: { token: 'beta' } },
          { sequence: 5, value: { token: '' } },
          { sequence: 6, value: { nope: 'ignored' } },
          { sequence: 7, value: 42 },
        ];
      };

      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/${id}/sse`, {
          method: 'GET',
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': '2' },
        }),
        engine,
      );

      const body = await response.text();
      expect(receivedAfter).toBe(2);
      expect(body).toContain('id: 3');
      expect(body).toContain('id: 4');
      expect(body).toContain('alpha');
      expect(body).toContain('beta');
      expect(body).not.toContain('ignored');
      expect(body).not.toContain('id: 2\nevent: token');
      expect(body).not.toContain('id: 5\nevent: done');

      engine.getStreamChunks = originalGetStreamChunks;
    });

    it('returns 400 when Last-Event-ID is invalid', async () => {
      engine = createEngine();

      const startResponse = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo', input: 'stream' }),
        engine,
      );
      const { id } = (await json(startResponse)) as { id: string };
      await flush();

      for (const lastEventId of ['1abc', '0x10', '1e3']) {
        const response = await handleRequest(
          new Request(`http://localhost/v1/workflows/${id}/sse`, {
            method: 'GET',
            headers: { Accept: 'text/event-stream', 'Last-Event-ID': lastEventId },
          }),
          engine,
        );

        expect(response.status).toBe(400);
        expect(await json(response)).toEqual({
          error: `Invalid Last-Event-ID header: ${lastEventId}`,
        });
      }
    });

    it('returns 400 when Last-Event-ID is empty', async () => {
      engine = createEngine();

      const startResponse = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo', input: 'stream' }),
        engine,
      );
      const { id } = (await json(startResponse)) as { id: string };
      await flush();

      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/${id}/sse`, {
          method: 'GET',
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': '' },
        }),
        engine,
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        error: 'Invalid Last-Event-ID header: ',
      });
    });
  });

  it('returns 500 from the top-level handler when a route throws unexpectedly', async () => {
    engine = createEngine();

    const originalList = engine.list.bind(engine);
    engine.list = async () => {
      throw new Error('list exploded');
    };

    const response = await handleRequest(request('GET', '/v1/workflows'), engine);

    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ error: 'Internal server error' });

    engine.list = originalList;
  });

  // -------------------------------------------------------------------------
  // Checkpoint history endpoints
  // -------------------------------------------------------------------------

  it('GET /v1/workflows/:id/checkpoints returns checkpoint list', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });
    engine.register(echoWorkflow);

    // Pre-seed checkpoint history entries
    const { serializeCheckpoint } = await import('../core/checkpoint.ts');
    const { CURRENT_CHECKPOINT_SCHEMA_VERSION } = await import('../core/types.ts');
    for (const step of [1, 2, 3]) {
      const checkpoint = {
        workflowId: 'test-wf',
        step,
        locals: {},
        accumulatedResults: [] as Array<[number, unknown]>,
        searchAttributes: {},
        version: '1.0.0',
        schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
        createdAt: 1000 + step * 100,
      };
      await storage.put(KEYS.checkpointHistory('test-wf', step), serializeCheckpoint(checkpoint));
    }

    const response = await handleRequest(
      request('GET', '/v1/workflows/test-wf/checkpoints'),
      engine,
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as Array<{ step: number }>;
    expect(body).toHaveLength(3);
    expect(body[0]!.step).toBe(3);
    expect(body[1]!.step).toBe(2);
    expect(body[2]!.step).toBe(1);
  });

  it('GET /v1/workflows/:id/checkpoints returns empty array when no history', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows/nonexistent/checkpoints'),
      engine,
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual([]);
  });

  it('GET /v1/workflows/:id/checkpoints/:step returns checkpoint state', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });
    engine.register(noopWorkflow);

    const { serializeCheckpoint } = await import('../core/checkpoint.ts');
    const { CURRENT_CHECKPOINT_SCHEMA_VERSION } = await import('../core/types.ts');
    const checkpoint = {
      workflowId: 'test-wf',
      step: 5,
      locals: { greeting: 'hello' },
      accumulatedResults: [] as Array<[number, unknown]>,
      searchAttributes: {
        tag: 'test' as unknown as import('../core/types.ts').SearchAttributeValue,
      },
      version: '2.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: 9999,
    };
    await storage.put(KEYS.checkpointHistory('test-wf', 5), serializeCheckpoint(checkpoint));

    const response = await handleRequest(
      request('GET', '/v1/workflows/test-wf/checkpoints/5'),
      engine,
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as Record<string, unknown>;
    expect(body['step']).toBe(5);
    expect(body['locals']).toEqual({ greeting: 'hello' });
    expect(body['version']).toBe('2.0.0');
    expect(body['createdAt']).toBe(9999);
  });

  it('GET /v1/workflows/:id/checkpoints/:step returns 404 for missing step', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows/test-wf/checkpoints/99'),
      engine,
    );

    expect(response.status).toBe(404);
  });

  it('GET /v1/workflows/:id/checkpoints/:step returns 400 for non-numeric step', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows/test-wf/checkpoints/abc'),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: 'Invalid step: abc',
      data: {
        issues: [{ path: ['step'], message: 'Invalid step: abc', code: 'custom' }],
      },
    });
  });

  it('returns 400 for malformed percent-encoding in route parameters', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows/%E0%A4%A/checkpoints/1'),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Malformed route parameter encoding' });
  });

  // -------------------------------------------------------------------------
  // Timeline and replay endpoints
  // -------------------------------------------------------------------------

  it('GET /v1/workflows/:id/timeline returns structured timeline entries', async () => {
    let now = 5_000;
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10, getNow: () => now });

    async function loadCart(input: unknown) {
      const { cartId } = input as { cartId: string; token: string };
      now += 15;
      return { cartId, password: 'cart-secret', status: 'loaded' as const };
    }

    async function submitOrder(input: unknown) {
      const { cartId } = input as { cardNumber: string; cartId: string };
      now += 20;
      return { cardNumber: '4111111111111111', cartId, orderId: 'ord-42' };
    }

    const timelineHttpWorkflow = workflow({
      name: 'timeline-http',
      version: '1.2.3',
    }).execute(async function* (ctx: WorkflowContext) {
      const cart = yield* ctx.run(loadCart, {
        cartId: 'cart-1',
        token: 'Bearer inbound-secret',
      });
      return yield* ctx.run(submitOrder, {
        cardNumber: '4111 1111 1111 1111',
        cartId: cart.cartId,
      });
    });
    engine.register(timelineHttpWorkflow);

    const handle = await engine.start('timeline-http', null, { id: 'wf-http-timeline' });
    await handle.result();

    const response = await handleRequest(
      request('GET', '/v1/workflows/wf-http-timeline/timeline'),
      engine,
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0]?.['step']).toBe(1);
    expect(body[0]?.['operationType']).toBe('activity');
    expect(body[0]?.['inputSummary']).toBe('{"cartId":"cart-1","token":"[REDACTED]"}');
    expect(body[0]?.['outputSummary']).toBe(
      '{"cartId":"cart-1","password":"[REDACTED]","status":"loaded"}',
    );
    expect(body[1]?.['operationLabel']).toBe('submitOrder');
    expect(body[1]?.['inputSummary']).toBe('{"cardNumber":"[REDACTED]","cartId":"cart-1"}');
    expect(body[1]?.['outputSummary']).toBe(
      '{"cardNumber":"[REDACTED]","cartId":"cart-1","orderId":"ord-42"}',
    );
  });

  it('GET /v1/workflows/:id/replay/:step returns checkpoint replay data', async () => {
    let now = 8_000;
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10, getNow: () => now });

    async function firstStage() {
      now += 5;
      return { stage: 'first' as const, token: 'Bearer replay-secret' };
    }

    async function secondStage() {
      now += 5;
      return { stage: 'second' as const };
    }

    const replayHttpWorkflow = workflow({
      name: 'replay-http',
      version: '4.0.0',
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.run(firstStage);
      return yield* ctx.run(secondStage);
    });
    engine.register(replayHttpWorkflow);

    const handle = await engine.start('replay-http', null, { id: 'wf-http-replay' });
    await handle.result();

    const response = await handleRequest(
      request('GET', '/v1/workflows/wf-http-replay/replay/2'),
      engine,
      apiKeyAuth(),
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as Record<string, unknown>;
    expect(body['checkpoint']).toMatchObject({ step: 2, version: '4.0.0' });
    expect(body['accumulatedResults']).toEqual([[0, { stage: 'first', token: '[REDACTED]' }]]);
    expect((body['events'] as Array<{ type: string }>).map((event) => event.type)).toEqual([
      'workflow:checkpoint',
      'workflow:checkpoint',
    ]);
  });

  it('GET /v1/workflows/:id/replay/:step returns 400 for invalid step parameters', async () => {
    engine = createEngine();
    const handle = await engine.start('echo', 'value', { id: 'wf-replay-step' });
    await handle.result();

    const response = await handleRequest(
      request('GET', '/v1/workflows/wf-replay-step/replay/9007199254740992'),
      engine,
      apiKeyAuth(),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Invalid step: 9007199254740992' });
  });

  it('GET /v1/workflows/:id/checkpoints/:step returns 400 for a numeric step outside the safe integer range', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows/test-wf/checkpoints/9007199254740992'),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: 'Invalid step: 9007199254740992',
      data: {
        issues: [
          {
            path: ['step'],
            message: 'Invalid step: 9007199254740992',
            code: 'custom',
          },
        ],
      },
    });
  });

  it('POST /v1/workflows/:id/fork returns 201 with the new workflow id', async () => {
    engine = createEngine();

    engine.register(forkableWorkflow);

    const original = await engine.start('forkable', 'hello', { id: 'wf-source' });
    await original.result();

    const response = await handleRequest(request('POST', '/v1/workflows/wf-source/fork'), engine);

    expect(response.status).toBe(201);
    const body = (await json(response)) as { id: string };
    expect(body.id).toBeString();
    expect(body.id).not.toBe('wf-source');
  });

  it('POST /v1/workflows/:id/fork returns 400 for invalid JSON bodies', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-source/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Invalid JSON body' });
  });

  it('POST /v1/workflows/:id/fork returns 400 for non-object JSON bodies', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows/wf-source/fork', ['x']),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('POST /v1/workflows/:id/fork returns 400 for invalid fromStep values', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows/wf-source/fork', { fromStep: -1 }),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: 'Field "fromStep" must be a non-negative safe integer',
    });
  });

  it('POST /v1/workflows/:id/fork returns 400 when fromStep does not exist', async () => {
    engine = createEngine();

    engine.register(forkableWorkflow);

    const original = await engine.start('forkable', 'hello', { id: 'wf-source' });
    await original.result();

    const response = await handleRequest(
      request('POST', '/v1/workflows/wf-source/fork', { fromStep: 999 }),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: 'Checkpoint not found at step 999 for workflow "wf-source"',
    });
  });

  it('POST /v1/workflows/:id/fork returns 404 for unknown workflow ids', async () => {
    engine = createEngine();

    const response = await handleRequest(request('POST', '/v1/workflows/missing/fork'), engine);

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      error: 'Workflow "missing" not found',
      data: { resource: 'workflow' },
    });
  });

  it('POST /v1/workflows/:id/fork returns 404 when the current checkpoint is missing', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    engine.fork = async () => {
      throw new Error('Checkpoint not found for workflow "wf-source"');
    };

    const response = await handleRequest(request('POST', '/v1/workflows/wf-source/fork'), engine);

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      error: 'Checkpoint not found for workflow "wf-source"',
      data: { resource: 'checkpoint' },
    });

    engine.fork = originalFork;
  });

  it('POST /v1/workflows/:id/fork returns 500 for unexpected errors', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('unexpected fork failure');
      };

      const response = await handleRequest(request('POST', '/v1/workflows/wf-source/fork'), engine);

      expect(response.status).toBe(500);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await json(response)).toEqual({ error: 'Internal server error' });
    } finally {
      engine.fork = originalFork;
    }
  });
});
