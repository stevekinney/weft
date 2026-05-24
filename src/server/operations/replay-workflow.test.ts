import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { signJWT } from '../authentication.ts';
import { handleRequest } from '../handler.ts';
import { serve, type WeftServer } from '../index.ts';
import { openWebSocket, waitForMessage } from '../json-rpc-websocket-client.test-support.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { anonymousPrincipal, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { replayWorkflowOperation, replayWorkflowRestBinding } from './replay-workflow.ts';

const TEST_SECRET = 'track-8-replay-auth-secret-1234567890';

function createReplayEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    checkpointHistory: 10,
  });

  async function firstStep() {
    return { phase: 'first' as const };
  }

  async function secondStep() {
    return { phase: 'second' as const };
  }

  async function thirdStep() {
    return { phase: 'third' as const };
  }

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
    const noScopeToken = await issueJwt(['quota:read']);
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

    const anonymousJsonRpc = await postJsonRpc(anonymousServer, 'weft.workflows.replay', {
      workflowId,
      step: 2,
    });
    expect(anonymousJsonRpc.status).toBe(200);
    const anonymousJsonRpcBody = (await anonymousJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(anonymousJsonRpcBody.error?.data?.weftCode).toBe('Unauthorized');
    expect(anonymousJsonRpcBody.error?.data?.httpStatus).toBe(401);

    const forbiddenJsonRpc = await postJsonRpc(
      authenticatedServer,
      'weft.workflows.replay',
      { workflowId, step: 2 },
      noScopeToken,
    );
    expect(forbiddenJsonRpc.status).toBe(200);
    const forbiddenJsonRpcBody = (await forbiddenJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(forbiddenJsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(forbiddenJsonRpcBody.error?.data?.httpStatus).toBe(403);

    const successJsonRpc = await postJsonRpc(
      authenticatedServer,
      'weft.workflows.replay',
      { workflowId, step: 2 },
      readToken,
    );
    expect(successJsonRpc.status).toBe(200);
    const successJsonRpcBody = (await successJsonRpc.json()) as {
      result?: { checkpoint?: { step?: number } };
      error?: unknown;
    };
    expect(successJsonRpcBody.error).toBeUndefined();
    expect(successJsonRpcBody.result?.checkpoint?.step).toBe(2);
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
    const anonymousResponsePromise = waitForMessage(anonymousSocket, (parsed) => {
      return (
        typeof parsed === 'object' && parsed !== null && (parsed as { id?: string }).id === 'anon'
      );
    });
    anonymousSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'anon',
        method: 'weft.workflows.replay',
        params: { workflowId: anonymousWorkflowId, step: 2 },
      }),
    );
    const anonymousResponse = (await anonymousResponsePromise) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(anonymousResponse.error?.data?.weftCode).toBe('Unauthorized');
    expect(anonymousResponse.error?.data?.httpStatus).toBe(401);
    anonymousSocket.close();

    const authenticatedEngine = createReplayEngine();
    engines.push(authenticatedEngine);
    const authenticatedWorkflowId = await createReplayWorkflow(
      authenticatedEngine,
      'wf-replay-ws-authenticated',
    );
    const noScopeToken = await issueJwt(['quota:read']);
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
    const authenticatedResponsePromise = waitForMessage(authenticatedSocket, (parsed) => {
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { id?: string }).id === 'authenticated'
      );
    });
    authenticatedSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'authenticated',
        method: 'weft.workflows.replay',
        params: { workflowId: authenticatedWorkflowId, step: 2 },
      }),
    );
    const authenticatedResponse = (await authenticatedResponsePromise) as {
      result?: { checkpoint?: { step?: number } };
      error?: unknown;
    };
    expect(authenticatedResponse.error).toBeUndefined();
    expect(authenticatedResponse.result?.checkpoint?.step).toBe(2);
    authenticatedSocket.close();

    const forbiddenSocket = await openWebSocket(
      `${authenticatedServer.url.replace('http://', 'ws://')}/jsonrpc`,
      noScopeToken,
    );
    const forbiddenResponsePromise = waitForMessage(forbiddenSocket, (parsed) => {
      return (
        typeof parsed === 'object' && parsed !== null && (parsed as { id?: string }).id === 'forbid'
      );
    });
    forbiddenSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'forbid',
        method: 'weft.workflows.replay',
        params: { workflowId: authenticatedWorkflowId, step: 2 },
      }),
    );
    const forbiddenResponse = (await forbiddenResponsePromise) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(forbiddenResponse.error?.data?.weftCode).toBe('Forbidden');
    expect(forbiddenResponse.error?.data?.httpStatus).toBe(403);
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
    const replay = scopedResult.value as { checkpoint: { step: number } };
    expect(replay.checkpoint.step).toBe(2);
  });
});

describe('weft.workflows.replay REST shaping', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns msgpack when the Accept header requests it', async () => {
    engine = createReplayEngine();
    const workflowId = await createReplayWorkflow(engine, 'wf-replay-msgpack');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${workflowId}/replay/2`, {
        method: 'GET',
        headers: { Accept: 'application/msgpack' },
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([replayWorkflowOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/msgpack');
  });

  it('returns 400 for an invalid replay step', async () => {
    engine = createReplayEngine();
    const workflowId = await createReplayWorkflow(engine, 'wf-replay-invalid-step');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${workflowId}/replay/not-a-number`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([replayWorkflowOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid step: not-a-number' });
  });

  it('returns 404 when the replay step does not exist', async () => {
    engine = createReplayEngine();
    const workflowId = await createReplayWorkflow(engine, 'wf-replay-missing-step');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${workflowId}/replay/99`, { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([replayWorkflowOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: `Replay not found at step 99 for workflow ${workflowId}`,
    });
  });

  it('maps EngineFailure faults to 500 with a sanitized body', async () => {
    engine = createReplayEngine();

    const failingOperation = {
      ...replayWorkflowOperation,
      invoke: async () => {
        throw {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        } satisfies OperationFault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-replay-engine-failure/replay/2', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('uses the fallback HTTP mapper for non-special-cased faults', async () => {
    engine = createReplayEngine();

    const conflictOperation = {
      ...replayWorkflowOperation,
      invoke: async () => {
        throw {
          code: 'Conflict',
          message: 'replay conflict',
          data: { reason: 'replay conflict' },
        } satisfies OperationFault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-replay-conflict/replay/2', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([conflictOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'replay conflict' });
  });
});
