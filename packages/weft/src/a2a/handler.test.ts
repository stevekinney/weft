import { describe, expect, test } from 'bun:test';

import { A2A_ERROR_CODE } from '@a2a-js/sdk/errors';
import {
  type AgentExecutor,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type RequestContext,
  type ServerCallContext,
  STATE_HEADERS_KEY,
  type User,
} from '@a2a-js/sdk/server';

import {
  agentCardFixture,
  echoExecutor,
  PUBLIC_URL,
  RPC_URL,
  rpcRequest,
  sendMessageBody,
} from './a2a.test-support.ts';
import { type A2AHandlerOptions, createA2AHandler } from './handler.ts';

class NamedUser implements User {
  constructor(private readonly name: string) {}
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return this.name;
  }
}

/** A handler whose executor records the `ServerCallContext` of the last `SendMessage`. */
function capturingHandler(
  options: Partial<A2AHandlerOptions> = {},
  onExecute: (requestContext: RequestContext) => void = () => {},
  agentCard = agentCardFixture(),
): { handler: (request: Request) => Promise<Response>; contexts: ServerCallContext[] } {
  const contexts: ServerCallContext[] = [];
  const executor: AgentExecutor = {
    async execute(requestContext, eventBus) {
      contexts.push(requestContext.context);
      onExecute(requestContext);
      await echoExecutor.execute(requestContext, eventBus);
    },
    cancelTask: echoExecutor.cancelTask,
  };
  const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor);
  const handler = createA2AHandler({
    requestHandler,
    agentCard: agentCardFixture(),
    publicUrl: PUBLIC_URL,
    ...options,
  });
  return { handler, contexts };
}

type RpcBody = { jsonrpc: string; id: unknown; result?: unknown; error?: { code: number } };

async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending;
  return response.status;
}

async function rpcJson(response: Response): Promise<RpcBody> {
  return (await response.json()) as RpcBody;
}

describe('createA2AHandler: unary JSON-RPC', () => {
  test('dispatches through the SDK transport with the authenticated user and the request headers', async () => {
    const user = new NamedUser('alice');
    const { handler, contexts } = capturingHandler({ authenticate: () => user });

    const response = await handler(
      rpcRequest(sendMessageBody(), {
        'last-event-id': 'cursor-7',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('application/json');
    const body = await rpcJson(response);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { task: { status: { state: 'TASK_STATE_COMPLETED' } } },
    });
    const context = contexts[0];
    expect(context?.user).toBe(user);
    expect(context?.state.get(STATE_HEADERS_KEY)).toMatchObject({
      'last-event-id': 'cursor-7',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
  });

  test('treats every request as anonymous without authenticate', async () => {
    const { handler, contexts } = capturingHandler();

    expect(await statusOf(handler(rpcRequest(sendMessageBody())))).toBe(200);
    expect(contexts[0]?.user?.isAuthenticated).toBe(false);
  });

  test('returns the Response authenticate produces unchanged', async () => {
    const rejection = new Response('Unauthorized', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
    });
    const { handler, contexts } = capturingHandler({ authenticate: async () => rejection });

    const response = await handler(rpcRequest(sendMessageBody()));

    expect(response).toBe(rejection);
    expect(response.status).toBe(401);
    expect(contexts).toEqual([]);
  });

  test('answers an unparseable body with the JSON-RPC parse error and a null id', async () => {
    const { handler, contexts } = capturingHandler();

    const body = await rpcJson(await handler(rpcRequest('{not json')));

    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: A2A_ERROR_CODE.PARSE_ERROR },
    });
    expect(contexts).toEqual([]);
  });

  test('rejects an explicitly non-JSON Content-Type with ContentTypeNotSupportedError', async () => {
    const { handler, contexts } = capturingHandler();

    const response = await handler(
      rpcRequest(sendMessageBody({ id: 'ct' }), { 'content-type': 'text/plain' }),
    );

    expect(response.status).toBe(200);
    expect(await rpcJson(response)).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: A2A_ERROR_CODE.CONTENT_TYPE_NOT_SUPPORTED },
    });
    expect(contexts).toEqual([]);
  });

  test('serves application/json with parameters, and a request with no Content-Type', async () => {
    const { handler, contexts } = capturingHandler();
    const withCharset = rpcRequest(sendMessageBody(), {
      'content-type': 'Application/JSON; charset=utf-8',
    });
    const withoutContentType = new Request(RPC_URL, {
      method: 'POST',
      headers: { 'a2a-version': '1.0' },
      body: new TextEncoder().encode(JSON.stringify(sendMessageBody())),
    });

    expect(withoutContentType.headers.get('content-type')).toBeNull();
    const charsetBody = await rpcJson(await handler(withCharset));
    const bareBody = await rpcJson(await handler(withoutContentType));
    expect(charsetBody.error).toBeUndefined();
    expect(bareBody.error).toBeUndefined();
    expect(contexts).toHaveLength(2);
  });
});

describe('createA2AHandler: A2A-Version', () => {
  test('serves A2A-Version 1.0', async () => {
    const { handler } = capturingHandler();

    const body = await rpcJson(
      await handler(rpcRequest(sendMessageBody(), { 'a2a-version': '1.0' })),
    );

    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });

  test('serves a patch version of 1.0 as 1.0, since patch versions are equivalent', async () => {
    const { handler, contexts } = capturingHandler();

    const body = await rpcJson(
      await handler(rpcRequest(sendMessageBody(), { 'a2a-version': '1.0.1' })),
    );

    expect(body.error).toBeUndefined();
    expect(contexts[0]?.requestedVersion).toBe('1.0');
  });

  test.each([
    ['0.3', { 'a2a-version': '0.3' }],
    ['1.1', { 'a2a-version': '1.1' }],
    ['1.0.x', { 'a2a-version': '1.0.x' }],
    ['empty', { 'a2a-version': '' }],
  ])('rejects A2A-Version %s with VersionNotSupportedError', async (_label, headers) => {
    const { handler, contexts } = capturingHandler();

    const response = await handler(rpcRequest(sendMessageBody({ id: 'v' }), headers));

    expect(response.status).toBe(200);
    const body = await rpcJson(response);
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 'v', error: { code: -32009 } });
    expect(contexts).toEqual([]);
  });

  test('rejects an absent A2A-Version with VersionNotSupportedError', async () => {
    const { handler } = capturingHandler();
    const request = new Request(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sendMessageBody({ id: 3 })),
    });

    expect(await rpcJson(await handler(request))).toMatchObject({ id: 3, error: { code: -32009 } });
  });
});

function cardWithExtensions(): ReturnType<typeof agentCardFixture> {
  const card = agentCardFixture();
  card.capabilities = {
    streaming: true,
    extensions: ['urn:example:one', 'urn:example:two'].map((uri) => ({
      uri,
      description: '',
      required: false,
      params: undefined,
    })),
  };
  return card;
}

describe('createA2AHandler: A2A-Extensions', () => {
  test('populates the context’s requested extensions from the request header', async () => {
    const { handler, contexts } = capturingHandler({}, () => {}, cardWithExtensions());

    await handler(
      rpcRequest(sendMessageBody(), { 'a2a-extensions': 'urn:example:one, urn:example:two' }),
    );

    expect(contexts[0]?.requestedExtensions).toEqual(['urn:example:one', 'urn:example:two']);
  });

  test('lists the extensions the request handler activated in the response header', async () => {
    const { handler } = capturingHandler({}, (requestContext) => {
      requestContext.context.addActivatedExtension('urn:example:one');
      requestContext.context.addActivatedExtension('urn:example:two');
    });

    const response = await handler(rpcRequest(sendMessageBody()));

    expect(response.headers.get('a2a-extensions')).toBe('urn:example:one,urn:example:two');
  });

  test('omits the response header when no extension was activated', async () => {
    const { handler } = capturingHandler();

    const response = await handler(rpcRequest(sendMessageBody()));

    expect(response.headers.has('a2a-extensions')).toBe(false);
  });
});

describe('createA2AHandler: tenant', () => {
  test('serves a request without a tenant under the configured tenant', async () => {
    const { handler, contexts } = capturingHandler({ tenant: 'acme' });

    const body = await rpcJson(await handler(rpcRequest(sendMessageBody())));

    expect(body.error).toBeUndefined();
    expect(contexts[0]?.tenant).toBe('acme');
  });

  test('serves a request naming the configured tenant', async () => {
    const { handler, contexts } = capturingHandler({ tenant: 'acme' });

    const body = await rpcJson(await handler(rpcRequest(sendMessageBody({ tenant: 'acme' }))));

    expect(body.error).toBeUndefined();
    expect(contexts[0]?.tenant).toBe('acme');
  });

  test('treats an empty tenant, the protobuf default, as absent', async () => {
    const { handler, contexts } = capturingHandler({ tenant: 'acme' });

    const body = await rpcJson(await handler(rpcRequest(sendMessageBody({ tenant: '' }))));

    expect(body.error).toBeUndefined();
    expect(contexts[0]?.tenant).toBe('acme');
  });

  test('rejects a request naming a different tenant with RequestMalformedError', async () => {
    const { handler, contexts } = capturingHandler({ tenant: 'acme' });

    const body = await rpcJson(
      await handler(rpcRequest(sendMessageBody({ id: 9, tenant: 'globex' }))),
    );

    expect(body).toMatchObject({ id: 9, error: { code: A2A_ERROR_CODE.INVALID_PARAMS } });
    expect(contexts).toEqual([]);
  });

  test('rejects any request-supplied tenant when no tenant is configured', async () => {
    const { handler, contexts } = capturingHandler();

    const body = await rpcJson(await handler(rpcRequest(sendMessageBody({ tenant: 'acme' }))));

    expect(body.error?.code).toBe(A2A_ERROR_CODE.INVALID_PARAMS);
    expect(contexts).toEqual([]);
  });

  test('never sets a context tenant when none is configured', async () => {
    const { handler, contexts } = capturingHandler();

    await handler(rpcRequest(sendMessageBody()));

    expect(contexts[0]?.tenant).toBeUndefined();
  });
});

describe('createA2AHandler: transport guards', () => {
  test('authenticates every route other than the discovery documents', async () => {
    const seen: string[] = [];
    const { handler } = capturingHandler({
      authenticate: (request) => {
        seen.push(new URL(request.url).pathname);
        return new Response(null, { status: 401 });
      },
    });

    expect(await statusOf(handler(new Request(`${PUBLIC_URL}/anything`)))).toBe(401);
    expect(await statusOf(handler(new Request(`${PUBLIC_URL}/.well-known/jwks.json`)))).toBe(401);
    expect(seen).toEqual(['/a2a/anything', '/a2a/.well-known/jwks.json']);
  });

  test('answers a JSON-RPC request with a method other than POST with 405', async () => {
    const { handler } = capturingHandler();

    const response = await handler(new Request(RPC_URL, { method: 'PUT', body: '{}' }));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  test('answers a declared body larger than maxRequestBodyBytes with 413', async () => {
    const { handler, contexts } = capturingHandler({ maxRequestBodyBytes: 64 });
    const body = JSON.stringify(sendMessageBody({ text: 'x'.repeat(128) }));

    const response = await handler(rpcRequest(body, { 'content-length': String(body.length) }));

    expect(response.status).toBe(413);
    expect(contexts).toEqual([]);
  });

  test('answers a streamed body that outgrows maxRequestBodyBytes with 413', async () => {
    const { handler } = capturingHandler({ maxRequestBodyBytes: 4 });
    const chunk = new TextEncoder().encode('{"jsonrpc":"2.0"}');
    const request = new Request(RPC_URL, {
      method: 'POST',
      headers: { 'a2a-version': '1.0' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    });

    expect(await statusOf(handler(request))).toBe(413);
  });

  test('defaults maxRequestBodyBytes to 1 MiB', async () => {
    const { handler } = capturingHandler();
    const within = JSON.stringify(sendMessageBody({ text: 'x'.repeat(1024 * 1024 - 512) }));
    const beyond = JSON.stringify(sendMessageBody({ text: 'x'.repeat(1024 * 1024) }));

    expect(await statusOf(handler(rpcRequest(within)))).toBe(200);
    expect(await statusOf(handler(rpcRequest(beyond)))).toBe(413);
  });

  test('answers a body stream that fails with 400', async () => {
    const { handler } = capturingHandler();
    const request = new Request(RPC_URL, {
      method: 'POST',
      headers: { 'a2a-version': '1.0' },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('connection reset'));
        },
      }),
    });

    expect(await statusOf(handler(request))).toBe(400);
  });
});

describe('createA2AHandler: numeric limits', () => {
  const invalidValues: ReadonlyArray<readonly [string, number]> = [
    ['negative', -1],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['non-integer', 1.5],
  ];

  for (const [label, value] of invalidValues) {
    test(`rejects a ${label} maxStreamDurationMs`, () => {
      expect(() => capturingHandler({ maxStreamDurationMs: value })).toThrow(RangeError);
    });
    test(`rejects a ${label} maxRequestBodyBytes`, () => {
      expect(() => capturingHandler({ maxRequestBodyBytes: value })).toThrow(RangeError);
    });
  }

  test('rejects a maxStreamDurationMs above the timer maximum', () => {
    expect(() => capturingHandler({ maxStreamDurationMs: 2_147_483_648 })).toThrow(RangeError);
  });

  test('rejects a maxRequestBodyBytes above the safe integer range', () => {
    expect(() => capturingHandler({ maxRequestBodyBytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      RangeError,
    );
  });

  test('accepts the boundary values', () => {
    expect(() =>
      capturingHandler({ maxStreamDurationMs: 1, maxRequestBodyBytes: 1 }),
    ).not.toThrow();
    expect(() =>
      capturingHandler({
        maxStreamDurationMs: 2_147_483_647,
        maxRequestBodyBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).not.toThrow();
  });
});
