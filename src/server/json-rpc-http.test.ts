/**
 * Tests for the POST `/jsonrpc` HTTP adapter. The adapter reads the
 * request body (bounded), extracts the authenticated principal,
 * delegates dispatch to `dispatchJsonRpc`, and maps the result to an
 * HTTP response.
 *
 * Wire shape under test:
 *   - Single request → HTTP 200 with JSON-RPC response body.
 *   - Single notification → HTTP 204 No Content.
 *   - Batch with responses → HTTP 200 with JSON array body.
 *   - All-notification batch → HTTP 204 No Content.
 *   - Body-level parse error → HTTP 200 with JSON-RPC error envelope
 *     (HTTP 400 is WRONG per spec — errors have id:null and 200
 *     status; only transport-level errors use 4xx/5xx).
 *   - Body size over limit → HTTP 413 (transport-level rejection,
 *     never reaches the parser).
 *   - Wrong content-type → HTTP 415.
 *   - Wrong method → HTTP 405.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { handleJsonRpcHttpRequest } from './json-rpc-http.ts';
import {
  createOperationRegistry,
  type ErasedOperation,
  type OperationDefinition,
} from './operation-catalog.ts';
import { anonymousPrincipal, principalFromApiKey } from './principal.ts';

const fakeEngine = {} as unknown;

function makeOp<I, O>(
  overrides: Partial<OperationDefinition<I, O>> & {
    name: string;
    inputSchema: z.ZodType<I>;
    outputSchema: z.ZodType<O>;
    invoke: OperationDefinition<I, O>['invoke'];
  },
): ErasedOperation {
  return {
    summary: 'test op',
    tags: [],
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    ...overrides,
  } as unknown as ErasedOperation;
}

function baseContext() {
  const registry = createOperationRegistry([
    makeOp({
      name: 'weft.test.echo',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      invoke: async ({ input }) => ({ echoed: input.value }),
    }),
    makeOp({
      name: 'weft.test.note',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    }),
  ]);
  return {
    registry,
    engine: fakeEngine,
    principal: anonymousPrincipal(),
  };
}

describe('handleJsonRpcHttpRequest — method + content-type gates', () => {
  it('returns 405 Method Not Allowed for GET', async () => {
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', { method: 'GET' }),
      baseContext(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('returns 415 Unsupported Media Type for non-JSON content-type', async () => {
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'not json',
      }),
      baseContext(),
    );
    expect(response.status).toBe(415);
  });

  it('accepts application/json', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'weft.test.echo',
      params: { value: 'hi' },
      id: 1,
    });
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      baseContext(),
    );
    expect(response.status).toBe(200);
  });

  it('accepts application/json with a charset parameter', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'weft.test.echo',
      params: { value: 'hi' },
      id: 1,
    });
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
      }),
      baseContext(),
    );
    expect(response.status).toBe(200);
  });
});

describe('handleJsonRpcHttpRequest — body-size limit', () => {
  it('returns 413 Payload Too Large when body exceeds limit', async () => {
    const bigString = 'x'.repeat(2 * 1024 * 1024);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'weft.test.echo',
      params: { value: bigString },
      id: 1,
    });
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      { ...baseContext(), maxBodyBytes: 1024 * 1024 },
    );
    expect(response.status).toBe(413);
  });

  it('returns 413 when content-length header exceeds limit (rejects before reading body)', async () => {
    // Tests the cheap pre-read guard: if content-length says the body
    // is too big, reject without allocating a 2 MB buffer.
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(10 * 1024 * 1024),
        },
        body: '{}',
      }),
      { ...baseContext(), maxBodyBytes: 1024 * 1024 },
    );
    expect(response.status).toBe(413);
  });

  it('returns 400 for a malformed content-length header (non-canonical integer)', async () => {
    // Negative, fractional, non-numeric, scientific-notation, or
    // leading-zero content-length values are all malformed per
    // RFC 7230 § 3.3.3. The adapter rejects them with 400 rather
    // than silently coercing to `Number()` and potentially
    // bypassing the pre-read size guard.
    // Note: Fetch's Request constructor normalizes whitespace and
    // strips empty-string headers, so those two variants can't be
    // tested through the Request API. The adapter still rejects them
    // per the regex — regression-tested here via representative
    // non-canonical values that the Request constructor preserves.
    for (const bad of ['-1', '1.5', 'abc', '1e3']) {
      const response = await handleJsonRpcHttpRequest(
        new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': bad,
          },
          body: '{}',
        }),
        baseContext(),
      );
      expect(response.status).toBe(400);
    }
  });

  it('rejects oversize bodies that omit content-length (streaming upload)', async () => {
    // The pre-read guard only fires when `content-length` is
    // present. For clients that use chunked encoding (no
    // content-length), the bounded stream reader must enforce the
    // cap during the read itself, aborting as soon as the limit is
    // exceeded. This prevents a lying or absent content-length from
    // forcing an unbounded allocation.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 2 MB of 'x' against a 1 MB limit.
        controller.enqueue(new TextEncoder().encode('x'.repeat(2 * 1024 * 1024)));
        controller.close();
      },
    });
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
      }),
      { ...baseContext(), maxBodyBytes: 1024 * 1024 },
    );
    expect(response.status).toBe(413);
  });
});

describe('handleJsonRpcHttpRequest — single request dispatch', () => {
  it('returns 200 with a JSON-RPC success response', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'weft.test.echo',
      params: { value: 'hi' },
      id: 1,
    });
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      baseContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const json = (await response.json()) as { jsonrpc: string; result: unknown; id: number };
    expect(json.jsonrpc).toBe('2.0');
    expect(json.result).toEqual({ echoed: 'hi' });
    expect(json.id).toBe(1);
  });

  it('returns 204 No Content for a notification', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.note' });
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      baseContext(),
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('returns 200 with error envelope for unknown method (id:null in error)', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'weft.unknown.op', id: 7 });
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      baseContext(),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { error: { code: number }; id: number };
    expect(json.error.code).toBe(-32601);
    expect(json.id).toBe(7);
  });

  it('returns 200 with parse-error envelope for malformed JSON', async () => {
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0"',
      }),
      baseContext(),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { error: { code: number }; id: null };
    expect(json.error.code).toBe(-32700);
    expect(json.id).toBeNull();
  });

  it('returns 200 with parse-error envelope for an empty body (POST with no data)', async () => {
    // Common real-world mistake (`curl` without `-d`, SDK bug). The
    // JSON-RPC spec-mandated response is HTTP 200 with the error
    // envelope + `id: null` — NOT 400. Test pins that convention.
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '',
      }),
      baseContext(),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { error: { code: number }; id: null };
    expect(json.error.code).toBe(-32700);
    expect(json.id).toBeNull();
  });

  it('sets Cache-Control: no-store on all responses', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'weft.test.echo',
      params: { value: 'hi' },
      id: 1,
    });
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      baseContext(),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('handleJsonRpcHttpRequest — batch dispatch', () => {
  it('returns 200 with response-array for a mixed batch', async () => {
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'weft.test.echo', params: { value: 'a' }, id: 1 },
      { jsonrpc: '2.0', method: 'weft.test.echo', params: { value: 'b' }, id: 2 },
    ]);
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      baseContext(),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as Array<{ result: unknown; id: number }>;
    expect(json).toHaveLength(2);
    expect(json[0]?.id).toBe(1);
    expect(json[1]?.id).toBe(2);
  });

  it('returns 204 for an all-notifications batch', async () => {
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'weft.test.note' },
      { jsonrpc: '2.0', method: 'weft.test.note' },
    ]);
    const response = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      baseContext(),
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

describe('handleJsonRpcHttpRequest — principal pass-through', () => {
  it('passes the principal from the handler context into the dispatcher', async () => {
    let seenPrincipalMethod: string | undefined;
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.whoami',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async ({ principal }) => {
          seenPrincipalMethod = principal.method;
          return {};
        },
      }),
    ]);
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.whoami', id: 1 });
    await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      {
        registry,
        engine: fakeEngine,
        principal: principalFromApiKey({ subject: 'k', scopes: [] }),
      },
    );
    expect(seenPrincipalMethod).toBe('api-key');
  });
});
