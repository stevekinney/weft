import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { handleRequest } from './handler.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';
import { principalFromApiKey } from './principal.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  return engine;
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

function apiKeyAuth() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: ['workflows:read'] }),
    },
  };
}

describe('handleRequest coverage regressions', () => {
  it('keeps direct meta routes reserved when a REST binding also matches', async () => {
    const engine = createEngine();
    const bindingOperation = defineOperation({
      name: 'weft.test.routeshadow',
      mcpExposable: false,
      summary: 'shadow route',
      inputSchema: z.object({ resource: z.string() }),
      outputSchema: z.object({ resource: z.string() }),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async ({ input }) => input,
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/:resource',
      pathParamNames: ['resource'],
      operationName: bindingOperation.name,
      inputSources: { resource: { kind: 'path', pathParam: 'resource' } },
      extractInput: async (_request, pathParams) => ({ resource: pathParams['resource'] ?? '' }),
      success: { kind: 'json', status: 200 },
    };

    const response = await handleRequest(request('GET', '/v1/health'), engine, {
      operationRegistry: createOperationRegistry([bindingOperation]),
      restBindings: [binding],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('returns 400 when a conflicting REST binding path parameter cannot be decoded', async () => {
    const engine = createEngine();
    const bindingOperation = defineOperation({
      name: 'weft.test.badroute',
      mcpExposable: false,
      summary: 'bad route',
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ ok: z.literal(true) }),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({ ok: true }),
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/widgets/:id',
      pathParamNames: ['id'],
      operationName: bindingOperation.name,
      inputSources: { id: { kind: 'path', pathParam: 'id' } },
      extractInput: async (_request, pathParams) => ({ id: pathParams['id'] ?? '' }),
      success: { kind: 'json', status: 200 },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/widgets/%E0%A4%A', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([bindingOperation]),
        restBindings: [binding],
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Malformed route parameter encoding' });
  });

  it('maps malformed fault-like throws to internal server errors', async () => {
    const engine = createEngine();
    const bindingOperation = defineOperation({
      name: 'weft.test.malformedfault',
      mcpExposable: false,
      summary: 'malformed fault',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.literal(true) }),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => {
        throw { code: 'NotFound', message: 'not really valid', data: null };
      },
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/malformed-fault',
      pathParamNames: [],
      operationName: bindingOperation.name,
      inputSources: {},
      extractInput: async () => ({}),
      success: { kind: 'json', status: 200 },
    };

    const response = await handleRequest(request('GET', '/v1/malformed-fault'), engine, {
      operationRegistry: createOperationRegistry([bindingOperation]),
      restBindings: [binding],
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'EngineFailure',
        message: 'internal error',
      },
    });
  });

  it('maps schedule error messages to their legacy HTTP statuses', async () => {
    const engine = createEngine();

    engine.getSchedule = async () => {
      throw new Error('Schedule "missing" not found');
    };
    let response = await handleRequest(
      request('GET', '/v1/schedules/missing'),
      engine,
      apiKeyAuth(),
    );
    expect(response.status).toBe(404);

    engine.schedule = async () => {
      throw new Error('schedule already exists');
    };
    response = await handleRequest(
      request('POST', '/v1/schedules', {
        type: 'echo',
        input: null,
        cronExpression: '* * * * *',
      }),
      engine,
    );
    expect(response.status).toBe(409);

    engine.resumeSchedule = async () => {
      throw new Error('Schedule cannot be resumed after cancellation');
    };
    response = await handleRequest(request('POST', '/v1/schedules/sched-1/resume'), engine);
    expect(response.status).toBe(409);
  });
});
