import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
/**
 * Operation-catalog live verification — verifies that `serve()` wires the
 * live `OperationRegistry` + `REST_BINDINGS` into `handleRequest`, and that
 * `weft.workflows.get` resolves end-to-end through the shared pipeline.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { signJWT } from './authentication.ts';
import { serve, type WeftServer } from './index.ts';
import { createLiveOperationRegistry, REST_BINDINGS } from './rest-bindings.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (
  ctx: WorkflowContext,
  _input: unknown,
) {
  return yield* ctx.waitForSignal<string>('release');
});

const TEST_SECRET = 'operation-catalog-live-secret-1234567890';

function createHoldEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) return;
    await sleepForTesting(5);
  }
  throw new Error(`workflow ${workflowId} did not reach ${status} in time`);
}

async function issueJwt(): Promise<string> {
  return signJWT({ sub: 'operation-catalog-user' }, TEST_SECRET);
}

async function postJsonRpc(
  server: WeftServer,
  method: string,
  params: Record<string, unknown>,
  token: string,
): Promise<Response> {
  return fetch(`${server.url}/jsonrpc`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
}

describe('operation catalog — live operation registry matches REST_BINDINGS', () => {
  it('The runtime API has one transport-neutral operation catalog', async () => {
    const engine = createHoldEngine();
    const getHandle = await engine.start('hold', { track: 'get' }, { id: 'parity-get' });
    const restSignalHandle = await engine.start(
      'hold',
      { track: 'signal-rest' },
      { id: 'parity-signal-rest' },
    );
    const jsonRpcSignalHandle = await engine.start(
      'hold',
      { track: 'signal-jsonrpc' },
      { id: 'parity-signal-jsonrpc' },
    );

    await waitForStatus(engine, getHandle.id, 'running');
    await waitForStatus(engine, restSignalHandle.id, 'running');
    await waitForStatus(engine, jsonRpcSignalHandle.id, 'running');

    const server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    const token = await issueJwt();

    try {
      const restGet = await fetch(`${server.url}/v1/workflows/${getHandle.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(restGet.status).toBe(200);
      const restGetBody = (await restGet.json()) as { id?: string };

      const jsonRpcGet = await postJsonRpc(
        server,
        'weft.workflows.get',
        { workflowId: getHandle.id },
        token,
      );
      expect(jsonRpcGet.status).toBe(200);
      const jsonRpcGetBody = (await jsonRpcGet.json()) as {
        result?: { id?: string };
        error?: unknown;
      };

      expect(jsonRpcGetBody.error).toBeUndefined();
      expect(restGetBody.id).toBe(getHandle.id);
      expect(jsonRpcGetBody.result?.id).toBe(getHandle.id);

      const restSignal = await fetch(
        `${server.url}/v1/workflows/${restSignalHandle.id}/signal/release`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ payload: 'rest-release' }),
        },
      );
      expect(restSignal.status).toBe(200);
      expect(await restSignal.json()).toEqual({ ok: true });

      const jsonRpcSignal = await postJsonRpc(
        server,
        'weft.workflows.signal',
        {
          workflowId: jsonRpcSignalHandle.id,
          signalName: 'release',
          payload: 'jsonrpc-release',
        },
        token,
      );
      expect(jsonRpcSignal.status).toBe(200);
      expect(await jsonRpcSignal.json()).toEqual({
        jsonrpc: '2.0',
        id: expect.any(String),
        result: { ok: true },
      });

      await expect(restSignalHandle.result()).resolves.toBe('rest-release');
      await expect(jsonRpcSignalHandle.result()).resolves.toBe('jsonrpc-release');
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });

  it('createLiveOperationRegistry resolves every operation referenced by REST_BINDINGS', () => {
    const registry = createLiveOperationRegistry();
    for (const binding of REST_BINDINGS) {
      const operation = registry.get(binding.operationName);
      expect(operation).toBeDefined();
      expect(operation?.name).toBe(binding.operationName);
    }
  });

  it('REST_BINDINGS mounts weft.workflows.get at GET /v1/workflows/:id', () => {
    const binding = REST_BINDINGS.find((b) => b.method === 'GET' && b.path === '/v1/workflows/:id');
    expect(binding).toBeDefined();
    expect(binding?.operationName).toBe('weft.workflows.get');
  });
});

describe('operation catalog — end-to-end serve() to REST pipeline', () => {
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('GET /v1/workflows/:id returns the workflow state', async () => {
    const engine = createHoldEngine();
    const handle = await engine.start('hold', { track: 8 }, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });
    const response = await fetch(`${server.url}/v1/workflows/${handle.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as { id?: string };
    expect(body.id).toBe(handle.id);
  });

  it('GET /openapi.json returns a valid OpenAPI 3.1 document that includes the route', async () => {
    const engine = createHoldEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/openapi.json`);
    expect(response.status).toBe(200);
    const doc = (await response.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.paths?.['/api/v1/workflows/{id}']).toBeDefined();
  });
});
