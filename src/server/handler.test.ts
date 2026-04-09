import { afterEach, describe, expect, it } from 'bun:test';

import { decode, encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { UpdateCoordinator, WorkflowTerminalError } from '../core/updates.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { getRequiredRouteParameter, handleRequest } from './handler.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });

  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });

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

  // 10. Unknown route returns 404
  it('unknown route returns 404', async () => {
    engine = createEngine();
    const response = await handleRequest(request('GET', '/v1/unknown'), engine);

    expect(response.status).toBe(404);
    const body = (await json(response)) as { error: string };
    expect(body.error).toBeDefined();
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
    engine.register('error-on-start', async function* () {
      throw new Error('some internal error');
    });

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
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('unexpected engine error');

    // Restore original
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
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('cancel failed internally');

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
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('unexpected signal error');

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

    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    engine.register('failing', async function* () {
      throw new Error('workflow failed');
    });

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

    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    engine.register('failing-no-msg', async function* () {
      throw new Error('deliberate');
    });

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

    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    engine.register('cancellable', async function* (ctx: WorkflowContext) {
      yield* (ctx as import('../core/context.ts').Context).waitForSignal('never');
      return 'nope';
    });

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

    engine.register(
      'long-running',
      async function* (ctx: import('../core/types.ts').WorkflowContext) {
        yield* (ctx as import('../core/context.ts').Context).waitForSignal('never-arrives');
        return 'done';
      },
    );

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

    engine.register('erroring', async function* (ctx: import('../core/types.ts').WorkflowContext) {
      yield* (ctx as import('../core/context.ts').Context).waitForSignal('never');
      return 'done';
    });

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
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('some unexpected error');

    engine.getHandle = originalGetHandle;
  });

  // -------------------------------------------------------------------------
  // POST /v1/workflows/:id/update/:name — synchronous update
  // -------------------------------------------------------------------------

  describe('POST /v1/workflows/:id/update/:name', () => {
    it('creates update and returns result when response is written quickly', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
          await Bun.sleep(10);
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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
          await Bun.sleep(10);
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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
          await Bun.sleep(10);
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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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
      const body = (await json(response)) as { error: string };
      expect(body.error).toContain('Storage read failure');

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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

      const response = await handleRequest(
        request('PATCH', '/v1/workflows/wf-no-attr/attributes', {}),
        engine,
      );

      expect(response.status).toBe(200);
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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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

      const response = await handleRequest(request('GET', '/v1/reviews'), engine);

      expect(response.status).toBe(200);
      const body = (await json(response)) as { items: unknown[] };
      expect(body.items).toEqual([]);
    });

    it('returns reviews that have been stored', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

      // Manually insert a review into storage
      const review = {
        reviewId: 'rev-1',
        workflowId: 'wf-1',
        artifact: { text: 'review me' },
        reviewType: 'manual',
        reviewers: ['alice'],
        createdAt: Date.now(),
      };
      await storage.put(KEYS.review('wf-1', 'rev-1'), encode(review));

      const response = await handleRequest(request('GET', '/v1/reviews'), engine);

      expect(response.status).toBe(200);
      const body = (await json(response)) as { items: Array<{ reviewId: string }> };
      expect(body.items.length).toBe(1);
      expect(body.items[0]!.reviewId).toBe('rev-1');
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
      expect(await json(response)).toMatchObject({ error: 'review submission failed' });

      engine.submitReview = originalSubmitReview;
    });

    it('resolves an existing review via direct key lookup when workflowId is provided', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

      // Insert a review using the canonical key format
      const review = {
        reviewId: 'rev-2',
        workflowId: 'wf-2',
        artifact: { text: 'approve me' },
        reviewType: 'manual',
        reviewers: ['bob'],
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
      const decisionBytes = await storage.get('review-decision:rev-2');
      expect(decisionBytes).not.toBeNull();
      const decisionData = decode(decisionBytes!) as { decision: string; reviewer: string };
      expect(decisionData.decision).toBe('approved');
      expect(decisionData.reviewer).toBe('bob');
    });

    it('falls back to scan when workflowId is not provided', async () => {
      const storage = new MemoryStorage();
      engine = new Engine({ storage });
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

      const review = {
        reviewId: 'rev-3',
        workflowId: 'wf-3',
        artifact: { text: 'approve me' },
        reviewType: 'manual',
        reviewers: ['alice'],
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
      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

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

      engine.register(
        'queryable',
        async function* (ctx: import('../core/types.ts').WorkflowContext) {
          const context = ctx as import('../core/context.ts').Context;
          let counter = 42;
          context.expose({ counter: () => counter });
          yield* context.waitForSignal('done');
          return counter;
        },
      );

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

      engine.register(
        'queryable',
        async function* (ctx: import('../core/types.ts').WorkflowContext) {
          const context = ctx as import('../core/context.ts').Context;
          context.expose({ counter: () => 1 });
          yield* context.waitForSignal('done');
          return 0;
        },
      );

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
      expect(await json(response)).toMatchObject({ error: 'query exploded' });

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
      expect(await json(response)).toMatchObject({ error: 'resume exploded' });

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

      engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      });

      engine.register(
        'long-running',
        async function* (ctx: import('../core/types.ts').WorkflowContext) {
          yield* (ctx as import('../core/context.ts').Context).waitForSignal('never');
          return 'done';
        },
      );

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
      expect(await json(response)).toMatchObject({ error: 'timeout exploded' });

      engine.timeout = originalTimeout;
    });
  });

  // -------------------------------------------------------------------------
  // PUT /v1/budget-policy — set AI budget policy
  // -------------------------------------------------------------------------

  describe('PUT /v1/budget-policy', () => {
    it('sets a budget policy and returns ok', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('PUT', '/v1/budget-policy', {
          namespace: 'org-1',
          daily: { maxCost: 100 },
          monthly: { maxCost: 2000 },
        }),
        engine,
      );

      expect(response.status).toBe(200);
      const body = (await json(response)) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it('returns 400 when namespace is missing', async () => {
      engine = createEngine();

      const response = await handleRequest(
        request('PUT', '/v1/budget-policy', {
          daily: { maxCost: 100 },
        }),
        engine,
      );

      expect(response.status).toBe(400);
      const body = (await json(response)) as { error: string };
      expect(body.error).toContain('namespace');
    });

    it('returns 400 for invalid JSON body', async () => {
      engine = createEngine();

      const response = await handleRequest(
        new Request('http://localhost/v1/budget-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: 'not valid json',
        }),
        engine,
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when the body is null', async () => {
      engine = createEngine();

      const response = await handleRequest(
        new Request('http://localhost/v1/budget-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(null),
        }),
        engine,
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toMatchObject({
        error: 'Request body must be a JSON object',
      });
    });

    it('returns 500 when setting the budget policy fails', async () => {
      engine = createEngine();

      const originalSetBudgetPolicy = engine.setBudgetPolicy.bind(engine);
      engine.setBudgetPolicy = async () => {
        throw new Error('budget policy write failed');
      };

      const response = await handleRequest(
        request('PUT', '/v1/budget-policy', { namespace: 'org-1' }),
        engine,
      );

      expect(response.status).toBe(500);
      expect(await json(response)).toMatchObject({ error: 'budget policy write failed' });

      engine.setBudgetPolicy = originalSetBudgetPolicy;
    });
  });

  describe('GET /v1/budget-policy/:namespace', () => {
    it('returns an existing budget policy', async () => {
      engine = createEngine();
      await engine.setBudgetPolicy({ namespace: 'org-1', daily: { maxCost: 50 } });

      const response = await handleRequest(request('GET', '/v1/budget-policy/org-1'), engine);

      expect(response.status).toBe(200);
      expect(await json(response)).toMatchObject({
        namespace: 'org-1',
        daily: { maxCost: 50 },
      });
    });

    it('returns 404 for an unknown namespace', async () => {
      engine = createEngine();

      const response = await handleRequest(request('GET', '/v1/budget-policy/missing'), engine);

      expect(response.status).toBe(404);
      expect(await json(response)).toMatchObject({
        error: 'Budget policy for namespace "missing" not found',
      });
    });
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
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
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
      engine.getStreamChunks = async () => [
        'alpha',
        { token: 'beta' },
        { token: '' },
        { nope: 'ignored' },
        42,
      ];

      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/${id}/sse`, {
          method: 'GET',
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': '2' },
        }),
        engine,
      );

      const body = await response.text();
      expect(body).toContain('alpha');
      expect(body).toContain('beta');
      expect(body).not.toContain('ignored');

      engine.getStreamChunks = originalGetStreamChunks;
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
});
