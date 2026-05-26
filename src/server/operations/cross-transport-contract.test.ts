/**
 * Cross-transport contract for the data-driven runtime operations.
 *
 * These tests assert system-level properties that hold across the whole
 * cataloged operation surface rather than the behavior of a single operation:
 * - every data-driven operation is registered and addressable, and REST and
 *   JSON-RPC return the same result;
 * - scope-based authorization produces the same outcome over REST, JSON-RPC
 *   HTTP, JSON-RPC WebSocket, and JSON-RPC stdio.
 *
 * `weft.system.metrics` is the representative scoped operation exercised here;
 * per-operation contracts live in each operation's own test.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { signJWT } from '../authentication.ts';
import { serve, type WeftServer } from '../index.ts';
import { openWebSocket, waitForMessage } from '../json-rpc-websocket-client.test-support.ts';
import { executeOperation } from '../operation-catalog.ts';
import { principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';

/** Shape of the JSON-RPC error payload these tests assert against. */
type JsonRpcErrorResponse = { error?: { data?: { weftCode?: string; httpStatus?: number } } };

const TEST_SECRET = 'cross-transport-contract-test-secret-1234567890';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createTestEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
  });
  engine.register(echoWorkflow);
  return engine;
}

async function issueJwt(scopes: string[], claims: Record<string, unknown> = {}): Promise<string> {
  return signJWT(
    {
      sub: 'cross-transport-test-user',
      scope: scopes.join(' '),
      ...claims,
    },
    TEST_SECRET,
  );
}

async function postJsonRpc(
  server: WeftServer,
  body: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  return fetch(`${server.url}/jsonrpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      ...body,
    }),
  });
}

describe('runtime operation cross-transport contract', () => {
  const servers: WeftServer[] = [];
  const engines: Engine[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
    while (engines.length > 0) {
      engines.pop()?.[Symbol.dispose]();
    }
  });

  it('registers all data-driven runtime operations and serves them identically over REST and JSON-RPC', async () => {
    // The data-driven runtime operations are all present in the live registry.
    const liveRegistry = createLiveOperationRegistry();
    const expected = [
      'weft.schedules.list',
      'weft.schedules.get',
      'weft.workflows.replay',
      'weft.system.metrics',
    ];
    for (const name of expected) {
      expect(liveRegistry.get(name)).toBeDefined();
    }

    // `weft.system.metrics` is addressable over both REST and JSON-RPC HTTP
    // and both transports reach the same engine result with the same shape.
    const engine = createTestEngine();
    engines.push(engine);
    const server = serve({ engine, port: 0, auth: { jwt: { secret: TEST_SECRET } } });
    servers.push(server);

    const token = await issueJwt(['system:read']);

    const restResponse = await fetch(`${server.url}/v1/metrics/json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(restResponse.status).toBe(200);
    const restBody = (await restResponse.json()) as Record<string, unknown>;

    const jsonRpcResponse = await postJsonRpc(server, { method: 'weft.system.metrics' }, token);
    expect(jsonRpcResponse.status).toBe(200);
    const jsonRpcBody = (await jsonRpcResponse.json()) as { result: Record<string, unknown> };

    expect(jsonRpcBody.result).toEqual(restBody);
  });

  it('enforces scope-based authorization identically over REST, JSON-RPC HTTP, WebSocket, and stdio', async () => {
    // The scoped runtime operations declare scoped access in the live registry.
    const liveRegistry = createLiveOperationRegistry();
    expect(liveRegistry.get('weft.workflows.replay')?.access.kind).toBe('scoped');
    expect(liveRegistry.get('weft.system.metrics')?.access.kind).toBe('scoped');

    const engine = createTestEngine();
    engines.push(engine);
    const server = serve({ engine, port: 0, auth: { jwt: { secret: TEST_SECRET } } });
    servers.push(server);

    // A principal authenticated with the wrong scope is rejected Forbidden on
    // every transport.
    const wrongScopeToken = await issueJwt(['workflows:read']);

    // REST — Forbidden
    const restResponse = await fetch(`${server.url}/v1/metrics/json`, {
      headers: { Authorization: `Bearer ${wrongScopeToken}` },
    });
    expect(restResponse.status).toBe(403);

    // JSON-RPC HTTP — Forbidden surfaced in the JSON-RPC error payload
    const jsonRpcResponse = await postJsonRpc(
      server,
      { method: 'weft.system.metrics' },
      wrongScopeToken,
    );
    expect(jsonRpcResponse.status).toBe(200);
    const jsonRpcBody = (await jsonRpcResponse.json()) as JsonRpcErrorResponse;
    expect(jsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(jsonRpcBody.error?.data?.httpStatus).toBe(403);

    // JSON-RPC WebSocket — Forbidden, principal bound at upgrade
    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await openWebSocket(wsUrl, wrongScopeToken);
    try {
      const wsId = crypto.randomUUID();
      const wsResponsePromise = waitForMessage(
        ws,
        (parsed) =>
          typeof parsed === 'object' &&
          parsed !== null &&
          'id' in parsed &&
          (parsed as { id: unknown }).id === wsId,
      );
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: wsId,
          method: 'weft.system.metrics',
        }),
      );
      const wsResponse = (await wsResponsePromise) as JsonRpcErrorResponse;
      expect(wsResponse.error?.data?.weftCode).toBe('Forbidden');
    } finally {
      ws.close();
    }

    // stdio — Forbidden via the same operation policy hook
    const stdioPrincipal = principalFromJwtClaims({
      sub: 'cross-transport-test-user',
      scope: 'workflows:read',
    });
    const stdioResult = await executeOperation(
      'weft.system.metrics',
      {},
      { engine, registry: liveRegistry, principal: stdioPrincipal, transport: 'jsonRpcStdio' },
    );
    expect(stdioResult.ok).toBe(false);
    if (!stdioResult.ok) {
      expect(stdioResult.fault.code).toBe('Forbidden');
    }
  });
});
