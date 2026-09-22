import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { signJWT } from '../authentication.ts';
import { serve, type WeftServer } from '../index.ts';
import { openWebSocket, waitForMessage } from '../json-rpc-websocket-client.test-support.ts';
import { executeOperation } from '../operation-catalog.ts';
import { anonymousPrincipal, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';

const TEST_SECRET = 'track-8-replay-auth-secret-1234567890';

async function firstStep() {
  return { phase: 'first' as const };
}

async function secondStep() {
  return { phase: 'second' as const };
}

async function thirdStep() {
  return { phase: 'third' as const };
}

function hasMessageId(parsed: unknown, id: string): boolean {
  return typeof parsed === 'object' && parsed !== null && 'id' in parsed && parsed.id === id;
}

function createReplayEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    checkpointHistory: 10,
  });

  engine.register(
    workflow({ name: 'three-steps', version: '1.0.0' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(firstStep);
      yield* ctx.run(secondStep);
      return yield* ctx.run(thirdStep);
    }),
  );

  return engine;
}

async function createReplayWorkflow(
  engine: Engine,
  workflowId = 'wf-replay-auth',
): Promise<string> {
  const handle = await engine.start('three-steps', null, { id: workflowId });
  await handle.result();
  return handle.id;
}

async function issueJwt(scopes: string[]): Promise<string> {
  return signJWT(
    {
      sub: 'track-8-user',
      scope: scopes.join(' '),
    },
    TEST_SECRET,
  );
}

async function postJsonRpc(
  server: WeftServer,
  method: string,
  params: Record<string, unknown>,
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
      method,
      params,
    }),
  });
}

describe('weft.workflows.replay authorization parity', () => {
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

  it('REST uses the same scoped access policy as JSON-RPC HTTP', async () => {
    const engine = createReplayEngine();
    engines.push(engine);
    const workflowId = await createReplayWorkflow(engine);
    const noScopeToken = await issueJwt(['schedules:read']);
    const readToken = await issueJwt(['workflows:read']);

    const anonymousServer = serve({ engine, port: 0 });
    const authenticatedServer = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(anonymousServer, authenticatedServer);

    const anonymousRest = await fetch(`${anonymousServer.url}/v1/workflows/${workflowId}/replay/2`);
    expect(anonymousRest.status).toBe(401);

    const forbiddenRest = await fetch(
      `${authenticatedServer.url}/v1/workflows/${workflowId}/replay/2`,
      {
        headers: { Authorization: `Bearer ${noScopeToken}` },
      },
    );
    expect(forbiddenRest.status).toBe(403);

    const successRest = await fetch(
      `${authenticatedServer.url}/v1/workflows/${workflowId}/replay/2`,
      {
        headers: { Authorization: `Bearer ${readToken}` },
      },
    );
    expect(successRest.status).toBe(200);
    expect(successRest.headers.get('content-type')).toBe('application/json');
    const expectedRevisionSummary = await engine.get(workflowId);
    const expectedRevision = expectedRevisionSummary?.revision;
    expect(expectedRevision).toBeDefined();
    const successRestBody = await successRest.json();
    expect(successRestBody.revision).toBe(expectedRevision);

    const anonymousJsonRpc = await postJsonRpc(anonymousServer, 'weft.workflows.replay', {
      workflowId,
      step: 2,
    });
    expect(anonymousJsonRpc.status).toBe(200);
    const anonymousJsonRpcBody = await anonymousJsonRpc.json();
    expect(anonymousJsonRpcBody).toMatchObject({ error: { data: { weftCode: 'Unauthorized' } } });
    expect(anonymousJsonRpcBody).toMatchObject({ error: { data: { httpStatus: 401 } } });

    const forbiddenJsonRpc = await postJsonRpc(
      authenticatedServer,
      'weft.workflows.replay',
      { workflowId, step: 2 },
      noScopeToken,
    );
    expect(forbiddenJsonRpc.status).toBe(200);
    const forbiddenJsonRpcBody = await forbiddenJsonRpc.json();
    expect(forbiddenJsonRpcBody).toMatchObject({ error: { data: { weftCode: 'Forbidden' } } });
    expect(forbiddenJsonRpcBody).toMatchObject({ error: { data: { httpStatus: 403 } } });

    const successJsonRpc = await postJsonRpc(
      authenticatedServer,
      'weft.workflows.replay',
      { workflowId, step: 2 },
      readToken,
    );
    expect(successJsonRpc.status).toBe(200);
    const successJsonRpcBody = await successJsonRpc.json();
    expect(successJsonRpcBody).not.toHaveProperty('error');
    expect(successJsonRpcBody).toMatchObject({ result: { checkpoint: { step: 2 } } });
    // WFT-21: JSON-RPC passes `revision` through unchanged, same as REST.
    expect(successJsonRpcBody).toMatchObject({ result: { revision: expectedRevision } });
  });

  it('WebSocket sessions bind authenticated identity at upgrade time', async () => {
    const anonymousEngine = createReplayEngine();
    engines.push(anonymousEngine);
    const anonymousWorkflowId = await createReplayWorkflow(anonymousEngine, 'wf-replay-ws-anon');
    const anonymousServer = serve({ engine: anonymousEngine, port: 0 });
    servers.push(anonymousServer);

    const anonymousSocket = await openWebSocket(
      `${anonymousServer.url.replace('http://', 'ws://')}/jsonrpc`,
    );
    const anonymousResponsePromise = waitForMessage(anonymousSocket, (parsed) =>
      hasMessageId(parsed, 'anon'),
    );
    anonymousSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'anon',
        method: 'weft.workflows.replay',
        params: { workflowId: anonymousWorkflowId, step: 2 },
      }),
    );
    const anonymousResponse = await anonymousResponsePromise;
    expect(anonymousResponse).toMatchObject({ error: { data: { weftCode: 'Unauthorized' } } });
    expect(anonymousResponse).toMatchObject({ error: { data: { httpStatus: 401 } } });
    anonymousSocket.close();

    const authenticatedEngine = createReplayEngine();
    engines.push(authenticatedEngine);
    const authenticatedWorkflowId = await createReplayWorkflow(
      authenticatedEngine,
      'wf-replay-ws-authenticated',
    );
    const noScopeToken = await issueJwt(['schedules:read']);
    const readToken = await issueJwt(['workflows:read']);
    const authenticatedServer = serve({
      engine: authenticatedEngine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(authenticatedServer);

    const authenticatedSocket = await openWebSocket(
      `${authenticatedServer.url.replace('http://', 'ws://')}/jsonrpc`,
      readToken,
    );
    const authenticatedResponsePromise = waitForMessage(authenticatedSocket, (parsed) =>
      hasMessageId(parsed, 'authenticated'),
    );
    authenticatedSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'authenticated',
        method: 'weft.workflows.replay',
        params: { workflowId: authenticatedWorkflowId, step: 2 },
      }),
    );
    const authenticatedResponse = await authenticatedResponsePromise;
    expect(authenticatedResponse).not.toHaveProperty('error');
    expect(authenticatedResponse).toMatchObject({ result: { checkpoint: { step: 2 } } });
    authenticatedSocket.close();

    const forbiddenSocket = await openWebSocket(
      `${authenticatedServer.url.replace('http://', 'ws://')}/jsonrpc`,
      noScopeToken,
    );
    const forbiddenResponsePromise = waitForMessage(forbiddenSocket, (parsed) =>
      hasMessageId(parsed, 'forbid'),
    );
    forbiddenSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'forbid',
        method: 'weft.workflows.replay',
        params: { workflowId: authenticatedWorkflowId, step: 2 },
      }),
    );
    const forbiddenResponse = await forbiddenResponsePromise;
    expect(forbiddenResponse).toMatchObject({ error: { data: { weftCode: 'Forbidden' } } });
    expect(forbiddenResponse).toMatchObject({ error: { data: { httpStatus: 403 } } });
    forbiddenSocket.close();
  });

  it('stdio authorization uses the same operation-level policy hook once a session exists', async () => {
    const engine = createReplayEngine();
    engines.push(engine);
    const workflowId = await createReplayWorkflow(engine);
    const registry = createLiveOperationRegistry();

    const anonymousResult = await executeOperation(
      'weft.workflows.replay',
      { workflowId, step: 2 },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );
    expect(anonymousResult.ok).toBe(false);
    if (anonymousResult.ok) {
      throw new Error('expected anonymous stdio replay to be denied');
    }
    expect(anonymousResult.fault.code).toBe('Unauthorized');

    const scopedResult = await executeOperation(
      'weft.workflows.replay',
      { workflowId, step: 2 },
      {
        principal: principalFromJwtClaims({ sub: 'track-8-user', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );
    expect(scopedResult.ok).toBe(true);
    if (!scopedResult.ok) {
      throw new Error('expected scoped stdio replay to succeed');
    }
    expect(scopedResult.value).toMatchObject({ checkpoint: { step: 2 } });
  });
});
