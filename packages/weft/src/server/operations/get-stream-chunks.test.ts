import { describe, expect, it } from 'bun:test';

import { principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import {
  createOperationRegistry,
  handleJsonRpcHttpRequest,
} from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import { getStreamChunksOperation, getStreamChunksRestBinding } from './get-stream-chunks.ts';

function createEngineWithChunks(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  // Monkey-patch getStreamChunks per-test rather than spinning up a real
  // workflow that emits chunks; the operation just delegates to the engine.
  return engine;
}

const registry = createOperationRegistry([getStreamChunksOperation]);
const bindings = [getStreamChunksRestBinding];

async function callOverJsonRpc(
  engine: Engine,
  method: string,
  params: unknown,
  operation: Parameters<typeof createOperationRegistry>[0][number],
): Promise<Response> {
  return handleJsonRpcHttpRequest(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    }),
    {
      registry: createOperationRegistry([operation]),
      host: engine,
      principal: principalFromApiKey({ subject: 'streams-reader', scopes: ['streams:read'] }),
    },
  );
}

function request(method: string, path: string, accept?: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: accept !== undefined ? { Accept: accept } : {},
  });
}

describe('weft.workflows.streams.chunks', () => {
  it('returns stored chunks as JSON on the happy path', async () => {
    await using engine = createEngineWithChunks();
    const original = engine.getStreamChunks.bind(engine);
    engine.getStreamChunks = async () => [
      { sequence: 1, value: 'hello' },
      { sequence: 2, value: 'world' },
    ];

    try {
      const response = await handleRequest(
        request('GET', '/v1/workflows/wf-1/streams/tokens'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({
        chunks: [
          { sequence: 1, value: 'hello' },
          { sequence: 2, value: 'world' },
        ],
      });
    } finally {
      engine.getStreamChunks = original;
    }
  });

  it('forwards the `after` query parameter to engine.getStreamChunks', async () => {
    await using engine = createEngineWithChunks();
    const original = engine.getStreamChunks.bind(engine);
    let capturedAfter: number | undefined;
    engine.getStreamChunks = async (_workflowId, _key, options) => {
      capturedAfter = options?.after;
      return [];
    };

    try {
      await handleRequest(request('GET', '/v1/workflows/wf-1/streams/tokens?after=42'), engine, {
        operationRegistry: registry,
        restBindings: bindings,
      });
      expect(capturedAfter).toBe(42);
    } finally {
      engine.getStreamChunks = original;
    }
  });

  it.each(['not-a-number', '0x10', '1e3'])(
    'returns 400 with a precise message for an invalid `after` (%s)',
    async (badValue) => {
      // `parseOptionalSequenceCursor` rejects hex (0x10),
      // scientific notation (1e3), and obviously non-numeric strings via the
      // same DECIMAL_INTEGER_PATTERN regex. Cover all three classes here so
      // a future change to the regex doesn't silently widen acceptance.
      await using engine = createEngineWithChunks();

      const response = await handleRequest(
        request('GET', `/v1/workflows/wf-1/streams/tokens?after=${badValue}`),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: `Invalid after query parameter: ${badValue}`,
        retryable: false,
      });
    },
  );

  it.each(['-2', '-3'])('returns 400 for an out-of-range `after` value (%s)', async (badValue) => {
    // `parseOptionalSequenceCursor` rejects values < -1. Cover this
    // explicitly so JSON-RPC callers can't bypass the rule by passing a
    // raw integer that the prior `z.number().int()` schema would have
    // accepted; the validator now lives in invoke().
    await using engine = createEngineWithChunks();

    const response = await handleRequest(
      request('GET', `/v1/workflows/wf-1/streams/tokens?after=${badValue}`),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: `Invalid after query parameter: ${badValue}`,
      retryable: false,
    });
  });

  it('returns 400 for an empty `after` query parameter', async () => {
    await using engine = createEngineWithChunks();

    const response = await handleRequest(
      request('GET', '/v1/workflows/wf-1/streams/tokens?after='),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid after query parameter: ',
      retryable: false,
    });
  });

  it('rejects an `after` that is neither a string nor a number over JSON-RPC', async () => {
    await using engine = createEngineWithChunks();
    engine.getStreamChunks = async () => {
      throw new Error('must not read chunks for an invalid cursor');
    };

    const response = await callOverJsonRpc(
      engine,
      'weft.workflows.streams.chunks',
      { workflowId: 'wf-1', key: 'tokens', after: true },
      getStreamChunksOperation,
    );

    const envelope = await response.json();
    expect(envelope.error.code).toBe(-32602);
    expect(envelope.error.message).toBe('Invalid after query parameter: ');
  });

  it('returns SSE when the Accept header requests text/event-stream', async () => {
    // when SSE is negotiated, the response body is the SSE
    // wire format and content-type is text/event-stream.
    await using engine = createEngineWithChunks();
    const original = engine.getStreamChunks.bind(engine);
    engine.getStreamChunks = async () => [
      { sequence: 7, value: 'alpha' },
      { sequence: 8, value: { token: 'beta' } },
    ];

    try {
      const response = await handleRequest(
        request('GET', '/v1/workflows/wf-1/streams/tokens', 'text/event-stream'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(response.headers.get('connection')).toBe('keep-alive');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
      const body = await response.text();
      // getStreamChunks SSE encodes the full chunk as a JSON `value` payload.
      expect(body).toContain('id: 7');
      expect(body).toContain('event: token');
      expect(body).toContain('"sequence":7');
      expect(body).toContain('"value":"alpha"');
      expect(body).toContain('id: 8');
      expect(body).toContain('"value":{"token":"beta"}');
      expect(body).toContain('event: done');
    } finally {
      engine.getStreamChunks = original;
    }
  });

  it('sanitizes engine errors to 500 "Internal server error"', async () => {
    // Engine errors are masked before returning to the client. Pin that —
    // raw engine messages can contain SQL fragments, file paths, etc., and
    // must never reach a caller.
    await using engine = createEngineWithChunks();
    const original = engine.getStreamChunks.bind(engine);
    engine.getStreamChunks = async () => {
      throw new Error('storage offline: secret-credential-leak');
    };

    try {
      const response = await handleRequest(
        request('GET', '/v1/workflows/wf-1/streams/tokens'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
    } finally {
      engine.getStreamChunks = original;
    }
  });
});
