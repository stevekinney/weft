/**
 * Tests for the runtime stdio JSON-RPC session.
 *
 * Parallels the WebSocket session (Phase 12) but consumes newline-
 * delimited JSON frames from a `ReadableStream<Uint8Array>` and
 * writes responses to a `WritableStream<Uint8Array>`. The admission
 * gate is mandatory: either `--startup-token <hex>` or
 * `--allow-unauthenticated-local-admin`; neither → exit 2.
 *
 * Tests cover the pure session logic (admission, dispatch,
 * subscribe/unsubscribe, graceful shutdown) without spawning a real
 * subprocess — the `runStdioSession` function is parameterized over
 * I/O streams for testability.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { makeOperation as makeOp } from './json-rpc-operation.test-support.ts';
import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import { runStdioSession, type StdioAdmission, type StdioSessionResult } from './stdio-session.ts';
import { collectingWritable, readableFromLines } from './stdio-stream.test-support.ts';
import { createInMemoryEventBackend, createWorkflowEventFeed } from './workflow-event-feed.ts';

const fakeEngine = {} as unknown;

type CollectingWritable = ReturnType<typeof collectingWritable>;

/** Registry exposing the `weft.test.echo` operation reused across dispatch tests. */
function echoRegistry(): OperationRegistry {
  return createOperationRegistry([
    makeOp({
      name: 'weft.test.echo',
      inputSchema: z.object({ v: z.string() }),
      outputSchema: z.object({ v: z.string() }),
      invoke: async ({ input: i }) => ({ v: i.v }),
    }),
  ]);
}

/** Registry exposing the `weft.test.ping` operation reused across auth tests. */
function pingRegistry(): OperationRegistry {
  return createOperationRegistry([
    makeOp({
      name: 'weft.test.ping',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => ({ ok: true }),
    }),
  ]);
}

/**
 * Run a stdio session against the shared fake engine and a fresh in-memory
 * event feed, filling in the constant `engine`/`feed`/`output.stream` wiring
 * the dispatch and framing tests all repeat. Each test supplies its own input
 * stream, admission, registry, and optional `maxFrameBytes`.
 */
function runStdioTestSession({
  input,
  output,
  admission = { kind: 'allow-unauthenticated-local-admin' },
  registry,
  maxFrameBytes,
}: {
  input: ReadableStream<Uint8Array>;
  output: CollectingWritable;
  admission?: StdioAdmission;
  registry: OperationRegistry;
  maxFrameBytes?: number;
}): Promise<StdioSessionResult> {
  return runStdioSession({
    input,
    output: output.stream,
    admission,
    registry,
    engine: fakeEngine,
    feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
  });
}

describe('runStdioSession — admission', () => {
  it('rejects when neither token nor admin flag supplied', async () => {
    const input = readableFromLines([]);
    const output = collectingWritable();
    const admission: StdioAdmission = { kind: 'require-one' };
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission,
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toMatch(/admission/i);
  });

  it('accepts --allow-unauthenticated-local-admin with a stdio-local principal', async () => {
    const input = readableFromLines([
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.echo', params: { v: 'ok' }, id: 1 }) +
        '\n',
    ]);
    const output = collectingWritable();
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.echo',
        inputSchema: z.object({ v: z.string() }),
        outputSchema: z.object({ out: z.string() }),
        invoke: async ({ input: i, principal }) => ({ out: `${principal.method}:${i.v}` }),
      }),
    ]);
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    const response = JSON.parse(lines[0]!);
    expect(response.result.out).toBe('stdio-local:ok');
  });

  it('startup-token gate: accepts when first frame carries the matching token', async () => {
    const token = 'abc123';
    const input = readableFromLines([
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.authenticate',
        params: { token },
        id: 'auth',
      }) + '\n',
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.ping', id: 1 }) + '\n',
    ]);
    const output = collectingWritable();
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.ping',
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        invoke: async ({ principal }) => ({ ok: principal.method === 'stdio-local' }),
      }),
    ]);
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token },
      registry,
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    // First response is the auth success; second is the ping result.
    const auth = JSON.parse(lines[0]!);
    expect(auth.id).toBe('auth');
    expect(auth.result).toBeDefined();
    const ping = JSON.parse(lines[1]!);
    expect(ping.result.ok).toBe(true);
  });

  it('startup-token gate: rejects when the first frame has the wrong token', async () => {
    // Same-length candidate so the constant-time comparison's XOR loop
    // runs end-to-end rather than short-circuiting on the length
    // mismatch guard.
    const input = readableFromLines([
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.authenticate',
        params: { token: 'wrongXX' },
        id: 'auth',
      }) + '\n',
    ]);
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token: 'correct' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toMatch(/token/i);
  });

  it('startup-token gate: rejects when the first frame is not an authenticate call', async () => {
    const input = readableFromLines([
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.ping', id: 1 }) + '\n',
    ]);
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token: 'correct' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toMatch(/authenticate/i);
    const response = JSON.parse(output.lines()[0]!);
    expect(response.error.code).toBe(-32010);
    expect(response.error.data.weftCode).toBe('Unauthorized');
  });

  it('startup-token gate: rejects when the first frame is not valid JSON', async () => {
    const input = readableFromLines(['not json at all\n']);
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token: 'correct' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toMatch(/json/i);
    const response = JSON.parse(output.lines()[0]!);
    expect(response.error.code).toBe(-32700);
  });

  it('startup-token gate: rejects when stdin closes before any frame arrives', async () => {
    const input = readableFromLines([]);
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token: 'correct' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toMatch(/closed before/i);
  });

  it('startup-token gate: rejects when params.token is missing', async () => {
    const input = readableFromLines([
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.authenticate',
        params: {},
        id: 'auth',
      }) + '\n',
    ]);
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token: 'correct' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toMatch(/token/i);
  });

  it('startup-token gate: rejects when params.token is not a string', async () => {
    const input = readableFromLines([
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.authenticate',
        params: { token: 42 },
        id: 'auth',
      }) + '\n',
    ]);
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token: 'correct' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toMatch(/token/i);
  });

  it('startup-token gate: skips blank lines before the authenticate frame', async () => {
    const token = 'correct';
    const input = readableFromLines([
      '\n',
      '\n',
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.authenticate',
        params: { token },
        id: 'auth',
      }) + '\n',
    ]);
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(0);
    const response = JSON.parse(output.lines()[0]!);
    expect(response.id).toBe('auth');
    expect(response.result).toEqual({});
  });

  it('startup-token gate: reads an authenticate frame split across chunks', async () => {
    const encoder = new TextEncoder();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('{"jsonrpc":"2.0","method":"weft.authenticate","params":{"token":"cor'),
        );
        controller.enqueue(encoder.encode('rect"},"id":"auth"}\n'));
        controller.close();
      },
    });
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token: 'correct' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(0);
    const response = JSON.parse(output.lines()[0]!);
    expect(response.id).toBe('auth');
  });

  it('startup-token gate: normalizes invalid request ids to null on auth failure', async () => {
    const input = readableFromLines([
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.authenticate',
        params: { token: 'wrongXX' },
        id: { bad: true },
      }) + '\n',
    ]);
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token: 'correct' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(2);
    const response = JSON.parse(output.lines()[0]!);
    expect(response.id).toBeNull();
    expect(response.error.code).toBe(-32010);
  });

  it('startup-token gate: rejects an oversize authenticate frame before admission', async () => {
    const huge = 'x'.repeat(2000);
    const input = readableFromLines([
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.authenticate',
        params: { token: 'correct', padding: huge },
        id: 'auth',
      }) + '\n',
    ]);
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'startup-token', token: 'correct' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
      maxFrameBytes: 500,
    });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toMatch(/maxFrameBytes/i);
    const response = JSON.parse(output.lines()[0]!);
    expect(response.error.code).toBe(-32600);
  });

  it('startup-token gate: skips blank framing artifacts and accepts a chunked authenticate frame', async () => {
    const token = 'abc123';
    const encoder = new TextEncoder();
    const pingLine = JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.ping', id: 1 }) + '\n';
    const authenticateLine =
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.authenticate',
        params: { token },
        id: 'auth',
      }) + '\n';
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('\n'));
        controller.enqueue(encoder.encode(authenticateLine.slice(0, 18)));
        controller.enqueue(encoder.encode(authenticateLine.slice(18)));
        controller.enqueue(encoder.encode(pingLine));
        controller.close();
      },
    });
    const output = collectingWritable();
    const result = await runStdioTestSession({
      input,
      output,
      admission: { kind: 'startup-token', token },
      registry: pingRegistry(),
    });

    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    expect(JSON.parse(lines[0]!).id).toBe('auth');
    expect(JSON.parse(lines[1]!).result.ok).toBe(true);
  });
});

describe('runStdioSession — dispatch', () => {
  it('reads newline-delimited JSON frames and writes responses line-by-line', async () => {
    const input = readableFromLines([
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.echo', params: { v: 'a' }, id: 1 }) +
        '\n',
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.echo', params: { v: 'b' }, id: 2 }) +
        '\n',
    ]);
    const output = collectingWritable();
    const result = await runStdioTestSession({ input, output, registry: echoRegistry() });
    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe(1);
    expect(JSON.parse(lines[1]!).id).toBe(2);
  });

  it('rejects oversize frames with a parse-error', async () => {
    const huge = 'x'.repeat(2000);
    const input = readableFromLines([JSON.stringify({ huge }) + '\n']);
    const output = collectingWritable();
    const result = await runStdioTestSession({
      input,
      output,
      registry: createOperationRegistry([]),
      maxFrameBytes: 500,
    });
    expect(result.exitCode).toBe(0);
    const response = JSON.parse(output.lines()[0]!);
    expect(response.error.code).toBe(-32600);
  });

  it('exits cleanly when stdin closes', async () => {
    const input = readableFromLines([]);
    const output = collectingWritable();
    const result = await runStdioTestSession({
      input,
      output,
      registry: createOperationRegistry([]),
    });
    expect(result.exitCode).toBe(0);
  });

  it('handles two frames delivered in a single chunk', async () => {
    const combined =
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.echo', params: { v: 'a' }, id: 1 }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.echo', params: { v: 'b' }, id: 2 }) +
      '\n';
    const input = readableFromLines([combined]);
    const output = collectingWritable();
    const result = await runStdioTestSession({ input, output, registry: echoRegistry() });
    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe(1);
    expect(JSON.parse(lines[1]!).id).toBe(2);
  });

  it('main loop: on oversize frame, discards attacker-chosen framing and resyncs on next newline', async () => {
    // The first chunk is a 700-byte unterminated blob — overflow
    // fires, buffer is cleared, the loop enters discard-until-newline
    // mode. The attacker then sends a chunk that starts with a
    // continuation of the oversized frame plus a valid-looking
    // injected JSON, THEN a real newline, THEN a legit call. Only the
    // legit call after the real newline is allowed to produce a
    // response; the attacker-injected id=99 must be swallowed.
    const encoder = new TextEncoder();
    const oversizedPart1 = 'x'.repeat(700);
    const attackerContinuation =
      'yyy' +
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.test.echo',
        params: { v: 'attacker-injected' },
        id: 99,
      }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.echo', params: { v: 'legit' }, id: 2 }) +
      '\n';
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(oversizedPart1));
        controller.enqueue(encoder.encode(attackerContinuation));
        controller.close();
      },
    });
    const output = collectingWritable();
    const result = await runStdioTestSession({
      input,
      output,
      registry: echoRegistry(),
      maxFrameBytes: 500,
    });
    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    // Exactly two responses: the -32600 for the oversize, and the
    // legit follow-up echo. The attacker-injected frame must NOT
    // produce a response — its JSON payload was swallowed in the
    // resync window before the next real newline.
    expect(lines).toHaveLength(2);
    const overflowResponse = JSON.parse(lines[0]!);
    expect(overflowResponse.error.code).toBe(-32600);
    expect(overflowResponse.error.message).toMatch(/maxFrameBytes/i);
    const echoResponse = JSON.parse(lines[1]!);
    expect(echoResponse.id).toBe(2);
    expect(echoResponse.result.v).toBe('legit');
    for (const line of lines) {
      const payload = JSON.parse(line);
      expect(payload.id).not.toBe(99);
    }
  });

  it('main loop: keeps discarding oversize continuation chunks until a newline arrives', async () => {
    const encoder = new TextEncoder();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('x'.repeat(700)));
        controller.enqueue(encoder.encode('still-the-same-oversized-frame'));
        controller.enqueue(
          encoder.encode(
            '\n' +
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'weft.test.echo',
                params: { v: 'after-resync' },
                id: 7,
              }) +
              '\n',
          ),
        );
        controller.close();
      },
    });
    const output = collectingWritable();
    const result = await runStdioTestSession({
      input,
      output,
      registry: echoRegistry(),
      maxFrameBytes: 500,
    });
    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).error.message).toMatch(/maxFrameBytes/i);
    expect(JSON.parse(lines[1]!).result.v).toBe('after-resync');
  });

  it('main loop: emits ParseError when stream closes with an unterminated partial frame', async () => {
    const partial = JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.ping', id: 1 }); // no trailing \n
    const input = readableFromLines([partial]);
    const output = collectingWritable();
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    // Exactly one response: a parse error explaining the unterminated
    // frame. The session exits cleanly (exitCode 0) — the violation
    // was at the protocol layer, not an admission failure.
    expect(lines).toHaveLength(1);
    const response = JSON.parse(lines[0]!);
    expect(response.error.code).toBe(-32700);
    expect(response.error.message).toMatch(/unterminated/i);
  });

  it('dispatches with transport identity jsonRpcStdio (Bugbot regression)', async () => {
    // Regression for Bugbot finding on PR #127: the stdio session
    // reuses `createJsonRpcWebSocketSession`, which previously
    // hard-coded `transport: 'jsonRpcWebSocket'` inside
    // `dispatchJsonRpc`. An operation with `jsonRpcStdio: true` but
    // `jsonRpcWebSocket: false` would be incorrectly rejected as
    // `UnsupportedTransport` over stdio. This test pins the fix —
    // the session now passes `transport: 'jsonRpcStdio'` through.
    const input = readableFromLines([
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.stdio.only', id: 1 }) + '\n',
    ]);
    const output = collectingWritable();
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.stdio.only',
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        transports: {
          http: false,
          jsonRpcHttp: false,
          jsonRpcWebSocket: false,
          jsonRpcStdio: true,
        },
        invoke: async () => ({ ok: true }),
      }),
    ]);
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(0);
    const response = JSON.parse(output.lines()[0]!);
    expect(response.error).toBeUndefined();
    expect(response.result.ok).toBe(true);
  });

  it('rejects WS-only operations over stdio with UnsupportedTransport', async () => {
    // Complementary regression: a ws-only operation must be rejected
    // over stdio, proving the transport identity is consulted.
    const input = readableFromLines([
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.ws.only', id: 1 }) + '\n',
    ]);
    const output = collectingWritable();
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.ws.only',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        transports: {
          http: false,
          jsonRpcHttp: false,
          jsonRpcWebSocket: true,
          jsonRpcStdio: false,
        },
        invoke: async () => ({}),
      }),
    ]);
    const result = await runStdioSession({
      input,
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(0);
    const response = JSON.parse(output.lines()[0]!);
    expect(response.error.code).toBe(-32030);
    expect(response.error.data.weftCode).toBe('UnsupportedTransport');
  });

  it('processes a pipelined auth+call chunk without waiting for more input', async () => {
    const token = 'abc123';
    const combined =
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.authenticate',
        params: { token },
        id: 'auth',
      }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.ping', id: 1 }) +
      '\n';
    const input = readableFromLines([combined]);
    const output = collectingWritable();
    const result = await runStdioTestSession({
      input,
      output,
      admission: { kind: 'startup-token', token },
      registry: pingRegistry(),
    });
    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    // Auth ack, then the ping response. Both must land even though the
    // stream closes immediately after the single chunk.
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe('auth');
    expect(JSON.parse(lines[1]!).result.ok).toBe(true);
  });

  it('swallows writer.close failures during shutdown', async () => {
    let closeCalls = 0;
    const output = new WritableStream<Uint8Array>({
      write() {},
      close() {
        closeCalls += 1;
        throw new Error('close failed');
      },
    });

    const result = await runStdioSession({
      input: readableFromLines([]),
      output,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });

    expect(result.exitCode).toBe(0);
    expect(closeCalls).toBe(1);
  });
});
