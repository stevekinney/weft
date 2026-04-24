/**
 * End-to-end integration — `serve()` routes POST `/jsonrpc` into the
 * JSON-RPC HTTP adapter against the live operation registry.
 *
 * Unit coverage for `handleJsonRpcHttpRequest` lives in
 * `json-rpc-http.test.ts`. This suite asserts the wiring: a real HTTP
 * server stood up via `serve()` dispatches a call to
 * `weft.workflows.get` against a real engine and returns a JSON-RPC
 * success envelope.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serve, type WeftServer } from './index.ts';

function createHoldEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    return yield* (ctx as Context).waitForSignal<string>('release');
  });
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
    await Bun.sleep(5);
  }
  throw new Error(`workflow ${workflowId} did not reach ${status} in time`);
}

describe('serve() — POST /jsonrpc', () => {
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('dispatches weft.workflows.get against the live engine and sets Cache-Control: no-store', async () => {
    const engine = createHoldEngine();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    // The adapter stamps `Cache-Control: no-store` on every /jsonrpc
    // response — cached JSON-RPC bodies served to a different caller
    // are a correctness and security hazard. Pin this at the wire.
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result?: { id: string; status: string };
      error?: unknown;
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.error).toBeUndefined();
    expect(body.result?.id).toBe(handle.id);
  });

  it('returns MethodNotFound for an unknown method', async () => {
    const engine = createHoldEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'probe',
        method: 'weft.nope.missing',
        params: {},
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      jsonrpc: string;
      id: string;
      error?: { code: number; message: string };
    };
    expect(body.error?.code).toBe(-32601);
  });

  it('rejects GET /jsonrpc with 405', async () => {
    const engine = createHoldEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/jsonrpc`, { method: 'GET' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('rejects non-JSON content-type with 415', async () => {
    const engine = createHoldEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(response.status).toBe(415);
  });

  it('authentication short-circuits /jsonrpc — invalid API key → 401 before the adapter runs', async () => {
    // The authenticator runs BEFORE the /jsonrpc claim in the fetch
    // handler. An invalid API key returns 401 with a WWW-Authenticate
    // header and NEVER reaches `handleJsonRpcHttpRequest`. If the
    // ordering flips, an unauthenticated caller could smuggle
    // JSON-RPC requests past the auth gate — this pins the invariant.
    const engine = createHoldEngine();
    server = serve({
      engine,
      port: 0,
      auth: { apiKeys: ['valid-key'] },
    });

    const response = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'totally-wrong-key',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.get',
        params: { workflowId: 'anything' },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('invalid auth key on a valid API-key config also fails /jsonrpc without throwing from serve()', async () => {
    // Smoke test for exception-safety: the serve() /jsonrpc branch
    // wraps principal construction + adapter call in a try/catch so
    // that an authenticator-contract violation maps to a 500 JSON-RPC
    // envelope rather than escaping. The authenticator itself runs
    // before this code, but we can at least confirm that an invalid
    // credential produces a tidy 401 without the server crashing.
    const engine = createHoldEngine();
    server = serve({
      engine,
      port: 0,
      auth: { apiKeys: ['valid-key'] },
    });

    // Fire a burst of invalid requests to confirm the serve() loop
    // doesn't accumulate uncaught exceptions that would kill the
    // process.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${server!.url}/jsonrpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' },
          body: '{"jsonrpc":"2.0","id":1,"method":"weft.workflows.get","params":{"workflowId":"x"}}',
        }),
      ),
    );
    for (const response of responses) {
      expect(response.status).toBe(401);
    }
  });

  it('a valid API key passes through to the JSON-RPC adapter', async () => {
    // Counterpart to the short-circuit test: the same credential that
    // would unlock REST also unlocks /jsonrpc. Proves the authenticator
    // doesn't over-block this path.
    const engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({
      engine,
      port: 0,
      auth: { apiKeys: ['valid-key'] },
    });

    const response = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'valid-key',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { id: string } };
    expect(body.result?.id).toBe(handle.id);
  });
});
