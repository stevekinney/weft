import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { WEFT_SCOPE_VOCABULARY } from '../../authorization-scopes.ts';

import {
  createAuthenticator,
  createOperationHandler,
  createOperationHandlerAuthenticator,
  defineOperation,
  type OperationHandlerAuthenticate,
  type OperationHandlerMount,
} from "../../embedded/backchannel/src/index.ts";
import { signJWT, type AuthContext } from "../../embedded/backchannel/src/internals.ts";
import {
  createTestHost,
  eventsOperation,
  jsonRpcRequest,
  readerContext,
  scopedEchoOperation,
  statusOf,
  strangerContext,
} from "../../embedded/backchannel/src/testing.ts";
import { throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import * as weft from '../../index.ts';
import type { ServerContext } from '../runtime/context.ts';
import { authenticateRequest } from '../runtime/request-gate.ts';

const echoOperation = defineOperation({
  name: 'probe.echo',
  mcpExposable: false,
  summary: 'echo',
  destructive: false,
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  access: { kind: 'public' as const },
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
  invoke: async ({ input }) => ({ message: input.message }),
});

const websocketEchoOperation = defineOperation({
  name: 'probe.websocket.echo',
  mcpExposable: false,
  summary: 'websocket echo',
  destructive: false,
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  access: { kind: 'public' as const },
  transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
  invoke: async ({ input }) => ({ message: input.message }),
});

const websocketSubscriptionOperation = defineOperation({
  name: 'probe.websocket.events',
  mcpExposable: false,
  kind: 'subscription',
  summary: 'websocket events',
  destructive: false,
  inputSchema: z.object({}),
  outputSchema: z.object({ subscriptionId: z.string(), cursor: z.string() }),
  eventSchema: z.object({ value: z.string() }),
  access: { kind: 'public' as const },
  transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
  invoke: async () => ({
    subscriptionId: 'sub_probe',
    envelope: { subscriptionId: 'sub_probe', cursor: '-1' },
    iterable: (async function* () {
      yield { value: 'event' };
    })(),
    close: async () => undefined,
  }),
});

let websocketServer: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  websocketServer?.stop(true);
  websocketServer = undefined;
});

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('createOperationHandler', () => {
  it('exposes a Bun WebSocket handler for catalog JSON-RPC operations', async () => {
    const handler = createOperationHandler({ operations: [websocketEchoOperation], host: {} });
    websocketServer = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          if (await handler.upgrade(request, websocketServer!)) return undefined;
        }
        return handler(request);
      },
      websocket: handler.websocket,
    });

    const socket = new WebSocket(`ws://localhost:${websocketServer.port}/jsonrpc`);
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))));
      socket.addEventListener('error', () => reject(new Error('WebSocket failed')));
    });
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'probe.websocket.echo',
        params: { message: 'hi' },
      }),
    );
    expect(await response).toMatchObject({ id: 1, result: { message: 'hi' } });
    socket.close();
  });

  it('refuses a WebSocket upgrade when authentication returns a response', async () => {
    let upgradeCalls = 0;
    const handler = createOperationHandler({
      operations: [websocketEchoOperation],
      host: {},
      authenticate: async () => new Response('unauthorized', { status: 401 }),
    });

    const upgraded = await handler.upgrade(new Request('http://localhost/jsonrpc'), {
      upgrade() {
        upgradeCalls += 1;
        return true;
      },
    });

    expect(upgraded).toBe(false);
    expect(upgradeCalls).toBe(0);
  });

  it('passes the authenticated principal to an accepted WebSocket upgrade', async () => {
    let upgradeCalls = 0;
    const handler = createOperationHandler({
      operations: [websocketEchoOperation],
      host: {},
      authenticate: async () => readerContext(),
    });

    const upgraded = await handler.upgrade(new Request('http://localhost/jsonrpc'), {
      upgrade(_request, options) {
        upgradeCalls += 1;
        expect(options.data.pathname).toBe('/jsonrpc');
        expect(options.data.principal?.method).toBe('api-key');
        return true;
      },
    });

    expect(upgraded).toBe(true);
    expect(upgradeCalls).toBe(1);
  });

  it('rejects disallowed WebSocket origins before authentication and upgrade', async () => {
    let authenticationCalls = 0;
    let upgradeCalls = 0;
    const handler = createOperationHandler({
      operations: [websocketEchoOperation],
      host: {},
      cors: { allowedOrigins: ['https://allowed.example'] },
      authenticate: async () => {
        authenticationCalls += 1;
        return readerContext();
      },
    });

    const rejected = await handler.upgrade(
      new Request('http://localhost/jsonrpc', { headers: { Origin: 'https://evil.example' } }),
      {
        upgrade() {
          upgradeCalls += 1;
          return true;
        },
      },
    );
    expect(rejected).toBe(false);
    expect(authenticationCalls).toBe(0);
    expect(upgradeCalls).toBe(0);

    for (const origin of ['https://allowed.example', undefined]) {
      const headers = origin === undefined ? undefined : { Origin: origin };
      const upgraded = await handler.upgrade(
        new Request('http://localhost/jsonrpc', headers === undefined ? {} : { headers }),
        {
          upgrade() {
            upgradeCalls += 1;
            return true;
          },
        },
      );
      expect(upgraded).toBe(true);
    }
    expect(authenticationCalls).toBe(2);
    expect(upgradeCalls).toBe(2);
  });

  it('starts and delivers a catalog subscription over a real WebSocket', async () => {
    const handler = createOperationHandler({
      operations: [websocketSubscriptionOperation],
      host: {},
    });
    websocketServer = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          if (await handler.upgrade(request, websocketServer!)) return undefined;
        }
        return handler(request);
      },
      websocket: handler.websocket,
    });
    const socket = new WebSocket(`ws://localhost:${websocketServer.port}/jsonrpc`);
    const frames: Array<Record<string, unknown>> = [];
    const received = new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', (event) => {
        frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
        if (frames.length === 2) resolve();
      });
      socket.addEventListener('error', () => reject(new Error('WebSocket failed')));
    });
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    socket.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'probe.websocket.events', params: {} }),
    );
    await received;
    expect(frames[0]).toMatchObject({ id: 1, result: { subscriptionId: 'sub_probe' } });
    expect(frames[1]).toMatchObject({
      method: 'weft.events.deliver',
      params: { subscriptionId: 'sub_probe', envelope: { value: 'event' } },
    });
    socket.close();
  });

  it('cancels an unbounded catalog subscription with the session primitive', async () => {
    let closed = 0;
    let release: (() => void) | undefined;
    const operation = defineOperation({
      name: 'probe.websocket.unbounded',
      mcpExposable: false,
      kind: 'subscription',
      summary: 'unbounded websocket events',
      destructive: false,
      inputSchema: z.object({}),
      outputSchema: z.object({ subscriptionId: z.string(), cursor: z.string() }),
      eventSchema: z.object({ value: z.string() }),
      access: { kind: 'public' as const },
      transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
      invoke: async () => ({
        subscriptionId: 'sub_unbounded',
        envelope: { subscriptionId: 'sub_unbounded', cursor: '-1' },
        iterable: (async function* () {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          yield { value: 'late' };
        })(),
        close: async () => {
          closed += 1;
          release?.();
        },
      }),
    });
    const handler = createOperationHandler({ operations: [operation], host: {} });
    websocketServer = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          if (await handler.upgrade(request, websocketServer!)) return undefined;
        }
        return handler(request);
      },
      websocket: handler.websocket,
    });
    const socket = new WebSocket(`ws://localhost:${websocketServer.port}/jsonrpc`);
    const frames: Array<Record<string, unknown>> = [];
    const started = new Promise<void>((resolve) => {
      socket.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data)) as { id?: number };
        if (frame.id === 1) resolve();
      });
    });
    const received = new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', (event) => {
        frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
        if (frames.length === 3) resolve();
      });
      socket.addEventListener('error', () => reject(new Error('WebSocket failed')));
    });
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    socket.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'probe.websocket.unbounded', params: {} }),
    );
    await started;
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId: 'sub_unbounded' },
      }),
    );
    await received;
    expect(frames[0]).toMatchObject({ id: 1, result: { subscriptionId: 'sub_unbounded' } });
    expect(frames[1]).toMatchObject({ id: 2, result: {} });
    expect(frames[2]).toMatchObject({
      method: 'weft.events.terminated',
      params: { subscriptionId: 'sub_unbounded', reason: 'client-unsubscribed' },
    });
    expect(closed).toBe(1);
    socket.close();
  });

  it('closes a subscription that completes setup after the socket closes', async () => {
    let resolveSetup: (() => void) | undefined;
    let setupEntered: (() => void) | undefined;
    let closed = 0;
    let pumpStarted = 0;
    let resolveCloseCompleted: (() => void) | undefined;
    const closeCompleted = new Promise<void>((resolve) => {
      resolveCloseCompleted = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      setupEntered = resolve;
    });
    let resolveCloseObserved: (() => void) | undefined;
    const closeObserved = new Promise<void>((resolve) => {
      resolveCloseObserved = resolve;
    });
    const frames: Array<Record<string, unknown>> = [];
    const operation = defineOperation({
      name: 'probe.websocket.deferred',
      mcpExposable: false,
      kind: 'subscription',
      summary: 'deferred websocket events',
      destructive: false,
      inputSchema: z.object({}),
      outputSchema: z.object({ subscriptionId: z.string(), cursor: z.string() }),
      eventSchema: z.object({ value: z.string() }),
      access: { kind: 'public' as const },
      transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
      invoke: async () => {
        setupEntered?.();
        await new Promise<void>((resolve) => {
          resolveSetup = resolve;
        });
        return {
          subscriptionId: 'sub_deferred',
          envelope: { subscriptionId: 'sub_deferred', cursor: '-1' },
          iterable: (async function* () {
            pumpStarted += 1;
            yield { value: 'late' };
          })(),
          close: async () => {
            closed += 1;
            resolveCloseCompleted?.();
          },
        };
      },
    });
    const handler = createOperationHandler({ operations: [operation], host: {} });
    websocketServer = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          if (await handler.upgrade(request, websocketServer!)) return undefined;
        }
        return handler(request);
      },
      websocket: {
        ...handler.websocket,
        close(ws) {
          handler.websocket.close(ws);
          resolveCloseObserved?.();
        },
      },
    });
    const socket = new WebSocket(`ws://localhost:${websocketServer.port}/jsonrpc`);
    socket.addEventListener('message', (event) => {
      frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    socket.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'probe.websocket.deferred', params: {} }),
    );
    await entered;
    socket.close();
    await closeObserved;
    resolveSetup?.();
    await closeCompleted;
    expect(closed).toBe(1);
    expect(pumpStarted).toBe(0);
    expect(frames).toEqual([]);
  });

  it('is exported from @lostgradient/backchannel and not from Weft', () => {
    expect(Reflect.has(weft, 'createOperationHandler')).toBe(false);
    expect(Reflect.has(weft, 'createOperationHandlerAuthenticator')).toBe(false);
    expect(createOperationHandler).toBeFunction();
    expect(createOperationHandlerAuthenticator).toBeFunction();
  });

  it('serves a caller-supplied operation over JSON-RPC HTTP with no Engine constructed', async () => {
    const handler = createOperationHandler({ operations: [echoOperation], host: {} });

    const response = await handler(jsonRpcRequest('probe.echo', { message: 'hello' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 1, result: { message: 'hello' } });
  });

  it('delivers the supplied host to invoke', async () => {
    const host = { greeting: 'from the host' };
    const hostEcho = defineOperation<
      z.ZodObject<{}>,
      z.ZodObject<{ greeting: z.ZodString }>,
      typeof host
    >({
      name: 'probe.host',
      mcpExposable: false,
      summary: 'host',
      destructive: false,
      inputSchema: z.object({}),
      outputSchema: z.object({ greeting: z.string() }),
      access: { kind: 'public' },
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async ({ host: received }) => ({ greeting: received.greeting }),
    });
    const handler = createOperationHandler({ operations: [hostEcho], host });

    const body = await jsonOf(await handler(jsonRpcRequest('probe.host', {})));

    expect(body['result']).toEqual({ greeting: 'from the host' });
  });

  it('answers an unknown path with 404', async () => {
    const handler = createOperationHandler({ operations: [echoOperation], host: {} });

    for (const path of ['/v1/workflows', '/v1/metrics', '/mcp']) {
      expect(await statusOf(handler, new Request(`http://localhost${path}`))).toBe(404);
    }
  });

  it('refuses a duplicate operation name at construction', () => {
    expect(() =>
      createOperationHandler({ operations: [echoOperation, echoOperation], host: {} }),
    ).toThrow(/duplicate operation name/);
  });

  it('refuses an invalid maxRequestBodyBytes at construction', () => {
    expect(() =>
      createOperationHandler({ operations: [], host: {}, maxRequestBodyBytes: 0 }),
    ).toThrow(/maxRequestBodyBytes/);
  });

  it('applies maxRequestBodyBytes to JSON-RPC request bodies', async () => {
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      maxRequestBodyBytes: 128,
    });

    const within = await handler(jsonRpcRequest('probe.echo', { message: 'hi' }));
    const over = await handler(jsonRpcRequest('probe.echo', { message: 'x'.repeat(512) }));

    expect(within.status).toBe(200);
    expect(over.status).toBe(413);
  });

  it('answers rpc.discover with the document it serves at /openrpc.json', async () => {
    const handler = createOperationHandler({ operations: [echoOperation], host: {} });

    const discovered = await jsonOf(await handler(jsonRpcRequest('rpc.discover', {})));
    const served = await jsonOf(await handler(new Request('http://localhost/openrpc.json')));

    expect(discovered['result']).toEqual(served);
  });

  it('answers rpc.discover over a real WebSocket with the configured HTTP and WebSocket document', async () => {
    const handler = createOperationHandler({
      operations: [websocketEchoOperation],
      host: {},
      discoveryInfo: { description: 'Configured over HTTP and WebSocket' },
    });
    websocketServer = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          if (await handler.upgrade(request, websocketServer!)) return undefined;
        }
        return handler(request);
      },
      websocket: handler.websocket,
    });

    const served = await jsonOf(await handler(new Request('http://localhost/openrpc.json')));
    const socket = new WebSocket(`ws://localhost:${websocketServer.port}/jsonrpc`);
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))));
      socket.addEventListener('error', () => reject(new Error('WebSocket failed')));
    });
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rpc.discover', params: {} }));

    const websocketResponse = await response;
    expect(websocketResponse['result']).toEqual(served);
    expect(
      (served['methods'] as Array<{ name: string }>).some(
        (method) => method.name === websocketEchoOperation.name,
      ),
    ).toBe(true);
    socket.close();
  });
});

describe('createOperationHandler authentication', () => {
  it('treats every request as anonymous when authenticate is omitted', async () => {
    const handler = createOperationHandler({
      operations: [scopedEchoOperation],
      host: createTestHost(),
    });

    const body = await jsonOf(await handler(jsonRpcRequest('probe.scoped', { message: 'x' })));

    expect(body['error']).toBeDefined();
    expect(body['result']).toBeUndefined();
  });

  it('runs the operation as the principal authenticate resolved', async () => {
    const handler = createOperationHandler({
      operations: [scopedEchoOperation],
      host: createTestHost(),
      authenticate: async () => readerContext(),
    });

    const body = await jsonOf(await handler(jsonRpcRequest('probe.scoped', { message: 'x' })));

    expect(body['result']).toEqual({ message: 'x' });
  });

  it('denies an admitted caller who lacks the operation scope', async () => {
    const handler = createOperationHandler({
      operations: [scopedEchoOperation],
      host: createTestHost(),
      authenticate: async () => strangerContext(),
    });

    const body = await jsonOf(await handler(jsonRpcRequest('probe.scoped', { message: 'x' })));

    expect(body['result']).toBeUndefined();
    expect(body['error']).toBeDefined();
  });

  it('returns a Response from authenticate as-is, before any route runs', async () => {
    let routed = false;
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      authenticate: async () => new Response('nope', { status: 401 }),
      mounts: [
        {
          pathPrefix: '/adapter',
          fetch: async () => {
            routed = true;
            return new Response('adapter');
          },
        },
      ],
    });

    const jsonRpc = await handler(jsonRpcRequest('probe.echo', { message: 'x' }));
    const mounted = await handler(new Request('http://localhost/adapter/run'));

    expect(jsonRpc.status).toBe(401);
    expect(await jsonRpc.text()).toBe('nope');
    expect(mounted.status).toBe(401);
    expect(routed).toBe(false);
  });

  it('skips authenticate for health and the three discovery documents', async () => {
    let calls = 0;
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      authenticate: async () => {
        calls += 1;
        return new Response('nope', { status: 401 });
      },
    });

    for (const path of ['/v1/health', '/openapi.json', '/openrpc.json', '/asyncapi.json']) {
      expect(await statusOf(handler, new Request(`http://localhost${path}`))).toBe(200);
    }
    expect(calls).toBe(0);
  });
});

const quietAudit = (): void => undefined;

describe('createOperationHandlerAuthenticator', () => {
  const SECRET = 'operation-handler-secret-at-least-32-chars!';

  it('retains a package scope from a JWT so a scoped operation admits the caller', async () => {
    const packageScoped = defineOperation<z.ZodObject<{}>, z.ZodObject<{ ok: z.ZodLiteral<true> }>>(
      {
        name: 'bureau.tasks.list',
        mcpExposable: false,
        summary: 'List tasks',
        destructive: false,
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.literal(true) }),
        access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['bureau.tasks:read'] } },
        transports: {
          http: false,
          jsonRpcHttp: true,
          jsonRpcWebSocket: false,
          jsonRpcStdio: false,
        },
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
        invoke: async () => ({ ok: true as const }),
      },
    );
    const token = await signJWT({ sub: 'user-1', scope: 'bureau.tasks:read' }, SECRET);
    const call = (handler: ReturnType<typeof createOperationHandler>) =>
      handler(jsonRpcRequest('bureau.tasks.list', {}, { Authorization: `Bearer ${token}` })).then(
        jsonOf,
      );

    const withScope = createOperationHandler({
      operations: [packageScoped],
      host: {},
      authenticate: createOperationHandlerAuthenticator(
        { jwt: { secret: SECRET }, auditSink: quietAudit },
        { scopeVocabulary: WEFT_SCOPE_VOCABULARY, additionalScopes: ['bureau.tasks:read'] },
      ),
    });
    const withoutScope = createOperationHandler({
      operations: [packageScoped],
      host: {},
      authenticate: createOperationHandlerAuthenticator(
        {
          jwt: { secret: SECRET },
          auditSink: quietAudit,
        },
        { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
      ),
    });

    const admitted = await call(withScope);
    const refused = await call(withoutScope);

    expect(admitted['result']).toEqual({ ok: true });
    expect(refused['error']).toBeDefined();
  });

  it('rejects with the same 401 serve() returns', async () => {
    const config = {
      apiKeys: ['the-right-key'],
      defaultApiKeyScopes: ['workflows:read' as const],
      auditSink: quietAudit,
    };
    const request = new Request('http://localhost/jsonrpc', {
      headers: { Authorization: 'Bearer the-wrong-key' },
    });
    const authenticate: OperationHandlerAuthenticate = createOperationHandlerAuthenticator(config, {
      scopeVocabulary: WEFT_SCOPE_VOCABULARY,
    });
    const serveOutcome = await authenticateRequest(
      {
        authenticatorPromise: createAuthenticator(config, {
          scopeVocabulary: WEFT_SCOPE_VOCABULARY,
        }),
      } as unknown as ServerContext,
      request,
    );

    const response = await authenticate(request);

    expect(response).toBeInstanceOf(Response);
    const rejected = response as Response;
    expect(serveOutcome.response).not.toBeNull();
    expect(rejected.status).toBe(401);
    expect(rejected.status).toBe(serveOutcome.response?.status ?? 0);
    expect(rejected.headers.get('WWW-Authenticate')).toBe(
      serveOutcome.response?.headers.get('WWW-Authenticate') ?? null,
    );
    expect(rejected.headers.get('Content-Type')).toBe(
      serveOutcome.response?.headers.get('Content-Type') ?? null,
    );
    expect(await rejected.text()).toBe((await serveOutcome.response?.text()) ?? '');
  });

  it('admits a valid credential with the context serve() forwards', async () => {
    const config = {
      apiKeys: ['the-right-key'],
      defaultApiKeyScopes: ['events:read' as const],
      auditSink: quietAudit,
    };
    const authenticate = createOperationHandlerAuthenticator(config, {
      scopeVocabulary: WEFT_SCOPE_VOCABULARY,
    });

    const admitted = await authenticate(
      new Request('http://localhost/jsonrpc', {
        headers: { Authorization: 'Bearer the-right-key' },
      }),
    );

    expect(admitted).not.toBeInstanceOf(Response);
    expect((admitted as { method: string }).method).toBe('api-key');
  });

  it('admits a static API key on a request made before it has awaited ready', async () => {
    // The static keys are digested asynchronously inside the readiness the
    // request path awaits, so the first request needs no wait of its own.
    const authenticate = createOperationHandlerAuthenticator(
      {
        apiKeys: ['the-right-key'],
        defaultApiKeyScopes: ['events:read' as const],
        auditSink: quietAudit,
      },
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
    );

    const admitted = await authenticate(
      new Request('http://localhost/jsonrpc', {
        headers: { Authorization: 'Bearer the-right-key' },
      }),
    );

    expect(admitted).not.toBeInstanceOf(Response);
    expect((admitted as { method: string }).method).toBe('api-key');
    await authenticate.ready;
  });

  it('has no public paths of its own, so a mount sees only what it declared', async () => {
    let reached = false;
    const handler = createOperationHandler({
      operations: [],
      host: {},
      authenticate: createOperationHandlerAuthenticator(
        {
          apiKeys: ['right-key'],
          defaultApiKeyScopes: ['workflows:read'],
          auditSink: quietAudit,
        },
        { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
      ),
      mounts: [
        {
          pathPrefix: '/.well-known',
          fetch: async () => {
            reached = true;
            return new Response('mounted');
          },
        },
      ],
    });

    const mcp = await handler(new Request('http://localhost/.well-known/mcp.json'));
    const catalog = await handler(new Request('http://localhost/.well-known/api-catalog'));

    expect(mcp.status).toBe(401);
    expect(catalog.status).toBe(401);
    expect(reached).toBe(false);
  });

  it('does not answer /v1/metrics as public either', async () => {
    const handler = createOperationHandler({
      operations: [],
      host: {},
      authenticate: createOperationHandlerAuthenticator(
        {
          apiKeys: ['right-key'],
          defaultApiKeyScopes: ['workflows:read'],
          auditSink: quietAudit,
        },
        { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
      ),
      mounts: [{ pathPrefix: '/v1/metrics', fetch: async () => new Response('mounted') }],
    });

    expect(await statusOf(handler, new Request('http://localhost/v1/metrics'))).toBe(401);
  });

  it('refuses config.publicPaths, which would be a second place to decide them', () => {
    expect(() =>
      createOperationHandlerAuthenticator(
        {
          apiKeys: ['k'],
          defaultApiKeyScopes: ['workflows:read'],
          publicPaths: ['/v1/health'],
        },
        { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
      ),
    ).toThrow(/publicPaths is not accepted/);
  });

  it('exposes a readiness promise that settles for a usable key', async () => {
    const authenticate = createOperationHandlerAuthenticator(
      {
        jwt: { secret: SECRET },
        auditSink: quietAudit,
      },
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
    );

    expect(await authenticate.ready).toBeUndefined();
  });

  it('rejects the readiness promise when a key cannot be imported', async () => {
    const authenticate = createOperationHandlerAuthenticator(
      {
        jwt: { algorithm: 'RS256', publicKey: 'not a public key' },
        auditSink: quietAudit,
      },
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
    );

    expect(await throwingRejectionOf(authenticate.ready)).toThrow();
  });

  it('surfaces a key that cannot be imported on the first request, not at construction', async () => {
    const authenticate = createOperationHandlerAuthenticator(
      {
        jwt: { algorithm: 'RS256', publicKey: 'not a public key' },
        auditSink: quietAudit,
      },
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
    );

    const attempt = authenticate(
      new Request('http://localhost/jsonrpc', { headers: { Authorization: 'Bearer x.y.z' } }),
    );

    expect(await throwingRejectionOf(attempt)).toThrow();
  });

  it('refuses an invalid configuration or scope at construction', () => {
    expect(() =>
      createOperationHandlerAuthenticator({}, { scopeVocabulary: WEFT_SCOPE_VOCABULARY }),
    ).toThrow(/at least one authentication/);
    expect(() =>
      createOperationHandlerAuthenticator(
        { apiKeys: ['k'], defaultApiKeyScopes: ['workflows:read'] },
        { scopeVocabulary: WEFT_SCOPE_VOCABULARY, additionalScopes: ['weft.system:read'] },
      ),
    ).toThrow(/additionalScopes/);
  });

  it('accepts static apiKeys that hold no scope, which an authenticated-only catalog admits', async () => {
    // Only `serve()` refuses an unscoped key; this handler's catalog is the
    // caller's own and may hold operations that need no scope.
    const authenticate = createOperationHandlerAuthenticator(
      {
        apiKeys: ['k'],
        auditSink: quietAudit,
      },
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
    );
    await authenticate.ready;

    const outcome = await authenticate(
      new Request('http://localhost/jsonrpc', { headers: { Authorization: 'Bearer k' } }),
    );
    expect(outcome).not.toBeInstanceOf(Response);
    const context = outcome as AuthContext;
    expect(context.method).toBe('api-key');
    expect(context.principal?.scopes.size).toBe(0);
  });
});

describe('createOperationHandler publicPaths', () => {
  const rejecting: OperationHandlerAuthenticate = async () => new Response('nope', { status: 401 });

  it('authenticates health and the documents when publicPaths is empty', async () => {
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      authenticate: rejecting,
      publicPaths: [],
    });

    for (const path of ['/v1/health', '/openapi.json', '/openrpc.json', '/asyncapi.json']) {
      expect(await statusOf(handler, new Request(`http://localhost${path}`))).toBe(401);
    }
  });

  it('serves only the listed paths without authentication', async () => {
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      authenticate: rejecting,
      publicPaths: ['/v1/health'],
    });

    expect(await statusOf(handler, new Request('http://localhost/v1/health'))).toBe(200);
    expect(await statusOf(handler, new Request('http://localhost/openapi.json'))).toBe(401);
  });

  it('documents no credentials in OpenAPI only for the paths it leaves public', async () => {
    const openApi = async (publicPaths: string[]) => {
      const handler = createOperationHandler({
        operations: [echoOperation],
        host: {},
        authenticate: async () => readerContext(),
        publicPaths,
      });
      const response = await handler(
        new Request('http://localhost/openapi.json', {
          headers: { Authorization: 'Bearer x' },
        }),
      );
      return (await response.json()) as {
        security: unknown[];
        paths: Record<string, { get: { security?: unknown[] } }>;
      };
    };

    const none = await openApi([]);
    const one = await openApi(['/v1/health']);

    expect(none.security.length).toBeGreaterThan(0);
    for (const entry of Object.values(none.paths)) expect(entry.get.security).toBeUndefined();
    expect(one.paths['/v1/health']?.get.security).toEqual([]);
    expect(one.paths['/openapi.json']?.get.security).toBeUndefined();
  });

  it('refuses a typo, and accepts a registered subscription route', () => {
    const host = createTestHost();
    const build = (publicPaths: string[]) => () =>
      createOperationHandler({
        operations: [eventsOperation, scopedEchoOperation],
        host,
        publicPaths,
      });

    expect(build(['/v1/helth'])).toThrow(/is not a route the handler serves/);
    expect(build(['/v1/health/extra'])).toThrow(/is not a route the handler serves/);
    expect(build(['/v1/subscriptions'])).toThrow(/is not a route the handler serves/);
    expect(build(['/v1/subscriptions/probe.missing'])).toThrow(/registered subscription/);
    expect(build(['/v1/subscriptions/probe.scoped'])).toThrow(/registered subscription/);
    expect(build(['/v1/subscriptions/probe.events'])).not.toThrow();
    expect(build(['/jsonrpc'])).not.toThrow();
  });

  it('refuses an entry the handler does not serve, and accepts one beside a mount’s own', () => {
    const build =
      (publicPaths: string[], mountPrefix = '/a2a') =>
      () =>
        createOperationHandler({
          operations: [],
          host: {},
          publicPaths,
          mounts: [{ pathPrefix: mountPrefix, fetch: async () => new Response('mounted') }],
        });

    expect(build(['/nothing-here'])).toThrow(/is not a route the handler serves/);
    expect(build(['health'])).toThrow(/absolute path/);
    expect(
      createOperationHandler.bind(null, {
        operations: [],
        host: {},
        publicPaths: ['/v1/health'],
        mounts: [
          {
            pathPrefix: '/a2a',
            publicPaths: ['/.well-known/agent-card.json'],
            fetch: async () => new Response('mounted'),
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe('createOperationHandler CORS', () => {
  const cors = { allowedOrigins: ['https://dashboard.example.com'] };

  it('answers a preflight before authentication runs', async () => {
    let calls = 0;
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      cors,
      authenticate: async () => {
        calls += 1;
        return new Response('nope', { status: 401 });
      },
    });

    const response = await handler(
      new Request('http://localhost/jsonrpc', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://dashboard.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://dashboard.example.com',
    );
    expect(calls).toBe(0);
  });

  it('decorates actual responses, including a 401, for an allowed origin only', async () => {
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      cors,
      authenticate: async () => new Response('nope', { status: 401 }),
    });
    const withOrigin = (origin: string) =>
      new Request('http://localhost/jsonrpc', { method: 'POST', headers: { Origin: origin } });

    const allowed = await handler(withOrigin('https://dashboard.example.com'));
    const denied = await handler(withOrigin('https://evil.example.com'));

    expect(allowed.status).toBe(401);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://dashboard.example.com',
    );
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('decorates a response whose headers are immutable', async () => {
    // Bun's own responses have mutable headers, but the Fetch spec guards
    // them on a `fetch()` result and on other runtimes, so build one the way
    // those runtimes do: headers that refuse a write.
    const immutable = (): Response => {
      const response = new Response(null, { status: 302, headers: { location: '/elsewhere' } });
      const guarded = new Headers(response.headers);
      for (const method of ['set', 'append', 'delete'] as const) {
        Object.defineProperty(guarded, method, {
          value: () => {
            throw new TypeError('immutable headers');
          },
        });
      }
      Object.defineProperty(response, 'headers', { value: guarded });
      return response;
    };
    expect(() => immutable().headers.set('X-Probe', '1')).toThrow();
    const handler = createOperationHandler({
      operations: [],
      host: {},
      cors,
      authenticate: async () => immutable(),
      mounts: [{ pathPrefix: '/adapter', fetch: async () => immutable() }],
      publicPaths: [],
    });
    const origin = { Origin: 'https://dashboard.example.com' };

    const fromAuthenticate = await handler(
      new Request('http://localhost/v1/health', { headers: origin }),
    );
    const fromMount = await handler(new Request('http://localhost/adapter/x', { headers: origin }));

    for (const response of [fromAuthenticate, fromMount]) {
      expect(response.status).toBe(302);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://dashboard.example.com',
      );
    }
  });

  it('returns a response that cannot be copied undecorated instead of failing', async () => {
    const handler = createOperationHandler({
      operations: [],
      host: {},
      cors,
      mounts: [{ pathPrefix: '/adapter', fetch: async () => Response.error() }],
    });

    const response = await handler(
      new Request('http://localhost/adapter/x', {
        headers: { Origin: 'https://dashboard.example.com' },
      }),
    );

    expect(response.type).toBe('error');
  });

  it('emits no CORS headers when cors is omitted', async () => {
    const handler = createOperationHandler({ operations: [echoOperation], host: {} });

    const response = await handler(
      new Request('http://localhost/v1/health', { headers: { Origin: 'https://a.example.com' } }),
    );

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('refuses a wildcard origin with credentials at construction', () => {
    expect(() =>
      createOperationHandler({
        operations: [],
        host: {},
        cors: { allowedOrigins: ['*'], credentials: true },
      }),
    ).toThrow(/credentials/);
  });

  it('refuses a wildcard origin under authentication at construction', () => {
    expect(() =>
      createOperationHandler({
        operations: [],
        host: {},
        cors: { allowedOrigins: ['*'] },
        authenticate: async () => readerContext(),
      }),
    ).toThrow(/Authorization/);
  });
});

describe('createOperationHandler mounts', () => {
  function mount(
    pathPrefix: string,
    extra: Partial<OperationHandlerMount> = {},
  ): OperationHandlerMount {
    return { pathPrefix, fetch: async () => new Response('mounted'), ...extra };
  }
  const build = (mounts: ReadonlyArray<OperationHandlerMount>) => () =>
    createOperationHandler({ operations: [echoOperation], host: {}, mounts });

  it('throws when a prefix equals or overlaps another mount at a segment boundary', () => {
    expect(build([mount('/a2a'), mount('/a2a')])).toThrow(/overlaps the mount/);
    expect(build([mount('/a2a'), mount('/a2a/v1')])).toThrow(/overlaps the mount/);
    expect(build([mount('/a2a/v1'), mount('/a2a')])).toThrow(/overlaps the mount/);
    expect(build([mount('/a2a/')])).not.toThrow();
  });

  it('does not treat a longer sibling name as an overlap', async () => {
    expect(build([mount('/a2a'), mount('/a2a-extra')])).not.toThrow();
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      mounts: [mount('/a2a')],
    });

    const mounted = await handler(new Request('http://localhost/a2a/run'));

    expect(await mounted.text()).toBe('mounted');
    expect(await statusOf(handler, new Request('http://localhost/a2a-extra'))).toBe(404);
  });

  it('throws when a prefix overlaps a catalog route', () => {
    for (const prefix of [
      '/jsonrpc',
      '/v1/subscriptions',
      '/v1/subscriptions/x',
      '/v1',
      '/openapi.json',
    ]) {
      expect(build([mount(prefix)])).toThrow(/overlaps the catalog route/);
    }
  });

  it('throws on a malformed prefix', () => {
    for (const prefix of ['a2a', '/', '', '/a2a?x=1']) {
      expect(build([mount(prefix)])).toThrow(/absolute path/);
    }
  });

  it('throws when a public path is a catalog route, another mount public path, or under another mount', () => {
    expect(build([mount('/a2a', { publicPaths: ['/jsonrpc'] })])).toThrow(/catalog route/);
    expect(build([mount('/a2a', { publicPaths: ['/v1/subscriptions/probe.events'] })])).toThrow(
      /catalog route/,
    );
    expect(
      build([
        mount('/a2a', { publicPaths: ['/.well-known/agent-card.json'] }),
        mount('/ag-ui', { publicPaths: ['/.well-known/agent-card.json'] }),
      ]),
    ).toThrow(/belongs to the mount/);
    expect(build([mount('/a2a'), mount('/ag-ui', { publicPaths: ['/a2a/card.json'] })])).toThrow(
      /belongs to the mount/,
    );
  });

  it('accepts mounts whose public paths belong to no one else', () => {
    expect(
      build([
        mount('/a2a', { publicPaths: ['/.well-known/agent-card.json'] }),
        mount('/ag-ui', { publicPaths: ['/.well-known/ag-ui.json'] }),
      ]),
    ).not.toThrow();
  });

  it('hands the resolved principal to the mount', async () => {
    let seen: unknown;
    const handler = createOperationHandler({
      operations: [scopedEchoOperation],
      host: createTestHost(),
      authenticate: async () => readerContext(),
      mounts: [
        mount('/a2a', {
          fetch: async (_request, context) => {
            seen = context.principal;
            return new Response('ok');
          },
        }),
      ],
    });

    await handler(new Request('http://localhost/a2a/run'));

    expect(seen).toMatchObject({ method: 'api-key', subject: 'reader' });
  });

  it('runs dispatch and subscribe through the full pipeline, so a missing scope is denied', async () => {
    const host = createTestHost();
    const outcomes: Record<string, unknown> = {};
    const adapter = mount('/adapter', {
      fetch: async (_request, context) => {
        outcomes['dispatch'] = await context.dispatch('probe.scoped', { message: 'hi' });
        outcomes['subscribe'] = await context.subscribe('probe.events', {});
        return new Response('ok');
      },
    });
    const build = (authContext: ReturnType<typeof readerContext>) =>
      createOperationHandler({
        operations: [scopedEchoOperation, eventsOperation],
        host,
        authenticate: async () => authContext,
        mounts: [adapter],
      });

    await build(readerContext())(new Request('http://localhost/adapter/x'));
    expect(outcomes['dispatch']).toEqual({ ok: true, value: { message: 'hi' } });
    expect(outcomes['subscribe']).toMatchObject({ ok: true });

    await build(strangerContext())(new Request('http://localhost/adapter/x'));
    expect(outcomes['dispatch']).toMatchObject({ ok: false, fault: { code: 'Forbidden' } });
    expect(outcomes['subscribe']).toMatchObject({ ok: false, fault: { code: 'Forbidden' } });
  });

  it('skips authenticate for a mount public path and for no other mount path', async () => {
    let calls = 0;
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      authenticate: async () => {
        calls += 1;
        return new Response('nope', { status: 401 });
      },
      mounts: [mount('/a2a', { publicPaths: ['/.well-known/agent-card.json'] })],
    });

    const card = await handler(new Request('http://localhost/.well-known/agent-card.json'));
    expect(await card.text()).toBe('mounted');
    expect(calls).toBe(0);

    const rpc = await handler(new Request('http://localhost/a2a/rpc'));
    expect(rpc.status).toBe(401);
    expect(calls).toBe(1);
  });

  it('skips authenticate for a path its own mount’s predicate passes, and never for another mount’s', async () => {
    let calls = 0;
    const isCard = (pathname: string) => pathname.endsWith('/.well-known/agent-card.json');
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      authenticate: async () => {
        calls += 1;
        return new Response('nope', { status: 401 });
      },
      mounts: [mount('/a2a', { isPublicPath: isCard }), mount('/ag-ui')],
    });

    const card = await handler(
      new Request('http://localhost/a2a/published-later/.well-known/agent-card.json'),
    );
    expect(await card.text()).toBe('mounted');
    expect(calls).toBe(0);

    const rpc = await handler(new Request('http://localhost/a2a/published-later'));
    const elsewhere = await handler(
      new Request('http://localhost/ag-ui/x/.well-known/agent-card.json'),
    );
    const catalog = await handler(
      new Request('http://localhost/jsonrpc/.well-known/agent-card.json'),
    );
    expect([rpc.status, elsewhere.status, catalog.status]).toEqual([401, 401, 401]);
    expect(calls).toBe(3);
  });

  it('receives the agent card at /.well-known/agent-card.json unauthenticated', async () => {
    let principal: unknown;
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      authenticate: async () => new Response('nope', { status: 401 }),
      mounts: [
        mount('/a2a', {
          publicPaths: ['/.well-known/agent-card.json'],
          fetch: async (request, context) => {
            principal = context.principal;
            return new Response(new URL(request.url).pathname);
          },
        }),
      ],
    });

    const response = await handler(new Request('http://localhost/.well-known/agent-card.json'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('/.well-known/agent-card.json');
    expect(principal).toEqual({ method: 'unauthenticated' });
  });

  it('handles a request in the order preflight, authentication, mounts, catalog, CORS decoration', async () => {
    const order: string[] = [];
    const handler = createOperationHandler({
      operations: [echoOperation],
      host: {},
      cors: { allowedOrigins: ['https://app.example.com'] },
      authenticate: async () => {
        order.push('authenticate');
        return readerContext();
      },
      mounts: [
        mount('/a2a', {
          fetch: async () => {
            order.push('mount');
            return new Response('mounted');
          },
        }),
      ],
    });
    const origin = { Origin: 'https://app.example.com' };

    const preflight = await handler(
      new Request('http://localhost/a2a/run', {
        method: 'OPTIONS',
        headers: { ...origin, 'Access-Control-Request-Method': 'POST' },
      }),
    );
    expect(order).toEqual([]);
    expect(preflight.status).toBe(204);

    const mounted = await handler(new Request('http://localhost/a2a/run', { headers: origin }));
    expect(order).toEqual(['authenticate', 'mount']);
    expect(mounted.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');

    order.length = 0;
    const catalog = await handler(jsonRpcRequest('probe.echo', { message: 'x' }, origin));
    expect(order).toEqual(['authenticate']);
    expect(catalog.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
  });

  it('turns a mount that throws into a 500', async () => {
    const errors = console.error;
    console.error = () => undefined;
    try {
      const handler = createOperationHandler({
        operations: [echoOperation],
        host: {},
        mounts: [
          mount('/a2a', {
            fetch: async () => {
              throw new Error('boom');
            },
          }),
        ],
      });

      expect(await statusOf(handler, new Request('http://localhost/a2a/run'))).toBe(500);
    } finally {
      console.error = errors;
    }
  });
});
