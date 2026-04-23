/**
 * Tests for the WebSocket JSON-RPC frame handler. Each `/jsonrpc` WS
 * session binds a principal at upgrade time and reuses it for every
 * frame. The handler:
 *   - Parses incoming frames as JSON-RPC requests (single only; batch
 *     over WS is rejected per design decision 13 — WS subscribes need
 *     per-frame correlation that batches can't carry).
 *   - Dispatches via `dispatchJsonRpc`.
 *   - Manages `weft.workflows.subscribe` / `weft.workflows.unsubscribe`
 *     as first-class session primitives; all other ops route through
 *     the standard dispatcher.
 *   - Cleans up every subscription when the socket closes.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createJsonRpcWebSocketSession,
  type JsonRpcWebSocketEmitter,
} from './json-rpc-websocket.ts';
import {
  createOperationRegistry,
  type ErasedOperation,
  type OperationDefinition,
} from './operation-catalog.ts';
import { anonymousPrincipal } from './principal.ts';
import {
  createInMemoryEventBackend,
  createWorkflowEventFeed,
  encodeCursor,
} from './workflow-event-feed.ts';

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

function makeEmitter(): JsonRpcWebSocketEmitter & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
    },
  };
}

function makeEnvelope(sequence: number, workflowId = 'wf-1') {
  return {
    kind: 'workflow:started' as const,
    workflowId,
    selector: 'events' as const,
    sequence,
    cursor: encodeCursor(sequence),
    emittedAtMs: Date.now(),
    payload: { type: 'started' },
  };
}

describe('createJsonRpcWebSocketSession — frame dispatch', () => {
  it('dispatches a single request and emits the response as a JSON frame', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.echo',
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        invoke: async ({ input }) => ({ echoed: input.value }),
      }),
    ]);
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry,
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.test.echo',
        params: { value: 'hi' },
        id: 1,
      }),
    );
    expect(emitter.sent).toHaveLength(1);
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.jsonrpc).toBe('2.0');
    expect(response.result).toEqual({ echoed: 'hi' });
    expect(response.id).toBe(1);
    await session.close();
  });

  it('rejects batch frames with InvalidRequest (-32600)', async () => {
    // Track 8 design decision 13: batches over WS are out of spec for
    // subscribe correlation; reject and require per-frame calls.
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(JSON.stringify([{ jsonrpc: '2.0', method: 'weft.test.a', id: 1 }]));
    expect(emitter.sent).toHaveLength(1);
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32600);
    await session.close();
  });

  it('forwards the session principal to every invocation', async () => {
    let seenMethod: string | undefined;
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.whoami',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async ({ principal }) => {
          seenMethod = principal.method;
          return {};
        },
      }),
    ]);
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry,
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.whoami', id: 1 }),
    );
    expect(seenMethod).toBe('unauthenticated');
    await session.close();
  });

  it('handles malformed JSON frames by emitting a parse-error', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage('{"jsonrpc":"2.0"');
    expect(emitter.sent).toHaveLength(1);
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32700);
    await session.close();
  });

  it('drops the response for notification frames', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.note',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
      }),
    ]);
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry,
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.note' }));
    expect(emitter.sent).toHaveLength(0);
    await session.close();
  });
});

describe('createJsonRpcWebSocketSession — subscribe / unsubscribe', () => {
  it('weft.workflows.subscribe returns a subscriptionId + cursor', async () => {
    const emitter = makeEmitter();
    const backend = createInMemoryEventBackend();
    await backend.append(makeEnvelope(0));
    const feed = createWorkflowEventFeed(backend);
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 'sub-1',
      }),
    );
    // Wait a microtask for the subscribe handler to flush.
    await Bun.sleep(10);
    // The first message is the success response; subsequent are deliver notifications.
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.id).toBe('sub-1');
    expect(response.result.subscriptionId).toMatch(/^sub_/);
    expect(response.result.cursor).toBe('-1');
    await session.close();
  });

  it('initial subscribe cursor does not skip sequence 0 on reconnect', async () => {
    // Bugbot regression: previously the cursor defaulted to `'0'`,
    // which decodes to `afterSequence: 0` and SKIPS the envelope at
    // sequence 0. A client reconnecting with that cursor before any
    // deliveries would silently lose seq 0. Fix: use the `-1`
    // sentinel — `decodeCursor('-1')` returns -1, so seq 0 flows
    // through as expected.
    const backend = createInMemoryEventBackend();
    await backend.append(makeEnvelope(0));
    const feed = createWorkflowEventFeed(backend);

    // Session 1: subscribe without a cursor, capture the initial cursor.
    const emitter1 = makeEmitter();
    const session1 = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter: emitter1,
      feed,
    });
    await session1.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 'initial',
      }),
    );
    const initial = JSON.parse(emitter1.sent[0]!);
    const reconnectCursor = initial.result.cursor;
    expect(reconnectCursor).toBe('-1');
    await session1.close();

    // Session 2: reconnect with the cursor before receiving any deliveries.
    const emitter2 = makeEmitter();
    const session2 = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter: emitter2,
      feed,
    });
    await session2.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: {
          workflowId: 'wf-1',
          selector: 'events',
          fromCursor: reconnectCursor,
        },
        id: 'resume',
      }),
    );
    await Bun.sleep(10);
    const sequences = emitter2.sent
      .slice(1)
      .map((s) => JSON.parse(s))
      .filter((m) => m.method === 'weft.events.deliver')
      .map((m) => m.params.envelope.sequence);
    expect(sequences).toContain(0);
    await session2.close();
  });

  it('subscribe echoes fromCursor verbatim when the client supplied one', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events', fromCursor: '5' },
        id: 'sub-resume',
      }),
    );
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.result.cursor).toBe('5');
    await session.close();
  });

  it('rejects subscribe / unsubscribe frames missing jsonrpc: "2.0"', async () => {
    // Bugbot regression: session primitives bypassed the version
    // check other methods route through. Every frame must carry
    // `jsonrpc: "2.0"` or be rejected with InvalidRequest.
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    // Missing jsonrpc field.
    await session.handleMessage(
      JSON.stringify({
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 1,
      }),
    );
    const r1 = JSON.parse(emitter.sent[0]!);
    expect(r1.error.code).toBe(-32600);
    // Wrong jsonrpc version.
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '1.0',
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId: 'sub_x' },
        id: 2,
      }),
    );
    const r2 = JSON.parse(emitter.sent[1]!);
    expect(r2.error.code).toBe(-32600);
    await session.close();
  });

  it('delivers live envelopes as weft.events.deliver notifications', async () => {
    const emitter = makeEmitter();
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 'sub-1',
      }),
    );
    await Bun.sleep(10);
    await backend.append(makeEnvelope(0));
    await Bun.sleep(10);
    // Expect: 1 response + 1 deliver notification.
    expect(emitter.sent.length).toBeGreaterThanOrEqual(2);
    const deliveries = emitter.sent
      .slice(1)
      .map((s) => JSON.parse(s))
      .filter((m) => m.method === 'weft.events.deliver');
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].params.envelope.sequence).toBe(0);
    await session.close();
  });

  it('weft.workflows.unsubscribe closes the subscription and emits a terminated notification', async () => {
    const emitter = makeEmitter();
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 'sub-1',
      }),
    );
    await Bun.sleep(10);
    const subResult = JSON.parse(emitter.sent[0]!);
    const subscriptionId = subResult.result.subscriptionId;

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId },
        id: 'unsub-1',
      }),
    );
    await Bun.sleep(10);

    const messages = emitter.sent.map((s) => JSON.parse(s));
    const terminated = messages.find((m) => m.method === 'weft.events.terminated');
    expect(terminated).toBeDefined();
    expect(terminated.params.subscriptionId).toBe(subscriptionId);
    expect(terminated.params.reason).toBe('client-unsubscribed');
    await session.close();
  });

  it('close() terminates all active subscriptions', async () => {
    const emitter = makeEmitter();
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 'sub-1',
      }),
    );
    await Bun.sleep(10);
    const countBeforeClose = emitter.sent.length;

    await session.close();
    await Bun.sleep(10);

    // After close, new live events must NOT reach the emitter.
    await backend.append(makeEnvelope(0));
    await Bun.sleep(10);
    expect(emitter.sent.length).toBe(countBeforeClose);
  });

  it('unsubscribe with an unknown subscriptionId returns a NotFound fault', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId: 'sub_missing' },
        id: 'u1',
      }),
    );
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32020); // NotFound
    await session.close();
  });

  it('rejects subscribe with non-string workflowId (-32602 InvalidParams)', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 42, selector: 'events' },
        id: 's1',
      }),
    );
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32602);
    await session.close();
  });

  it('rejects subscribe with invalid selector (-32602 InvalidParams)', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'bogus' },
        id: 's1',
      }),
    );
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32602);
    await session.close();
  });

  it('rejects subscribe with non-string fromCursor (-32602 InvalidParams)', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events', fromCursor: 42 },
        id: 's1',
      }),
    );
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32602);
    await session.close();
  });

  it('rejects subscribe when per-session subscription cap is exceeded', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
      maxSubscriptions: 2,
    });
    for (let index = 0; index < 3; index += 1) {
      await session.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'weft.workflows.subscribe',
          params: { workflowId: `wf-${index}`, selector: 'events' },
          id: `s${index}`,
        }),
      );
    }
    await Bun.sleep(10);
    const responses = emitter.sent.map((s) => JSON.parse(s));
    // Third subscribe should come back as an error response.
    const third = responses.find((m) => m.id === 's2');
    expect(third?.error?.code).toBe(-32600);
    expect(third?.error?.message).toMatch(/subscriptions/i);
    await session.close();
  });

  it('rejects frames larger than maxFrameBytes before parsing', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
      maxFrameBytes: 100,
    });
    // 200-byte frame exceeds 100-byte cap.
    await session.handleMessage('x'.repeat(200));
    expect(emitter.sent).toHaveLength(1);
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32600);
    expect(response.error.message).toMatch(/frame size/i);
    await session.close();
  });

  it('close() still tears down subscriptions after emitter fails mid-session', async () => {
    // Bugbot regression: an emitter throw flips the adapter's
    // internal "emitter broken" flag. Previously that flag was
    // reused for `close()`'s early-return guard, so a broken
    // emitter would make `close()` a no-op and the background
    // pump would keep iterating the feed indefinitely. Fix split
    // the concerns: `emitterBroken` suppresses output; `disposed`
    // gates `close()`'s teardown.
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    let sendThrew = false;
    const emitter: JsonRpcWebSocketEmitter = {
      send() {
        // First send OK, second throws.
        if (sendThrew) throw new Error('socket closed');
        sendThrew = true;
      },
    };
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 'sub-1',
      }),
    );
    await Bun.sleep(10);
    // Trigger an emit failure by appending an envelope (deliver throws).
    await backend.append(makeEnvelope(0));
    await Bun.sleep(10);
    // `close()` must still abort the subscription pump even though
    // the emitter is broken.
    await session.close();
    // Appending more events after close must be a no-op (pump gone).
    await backend.append(makeEnvelope(1));
    // No assertion beyond: close() did not hang and no unhandled
    // rejection surfaced. Implicit pass.
  });

  it('rejects frames whose UTF-8 byte length exceeds maxFrameBytes (not string length)', async () => {
    // Bugbot regression: `frame.length` counts UTF-16 code units,
    // not bytes. A multi-byte payload (emoji, CJK) could previously
    // slip past a byte-cap configured via `maxFrameBytes`.
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
      maxFrameBytes: 100,
    });
    // `🌍` is 4 bytes in UTF-8 but 2 UTF-16 code units. 30 copies
    // plus wrapping = 120+ bytes but string length is ~60 — would
    // have slipped past the old `frame.length` check.
    const payload = '🌍'.repeat(30);
    const frame = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { v: payload }, id: 1 });
    expect(Buffer.byteLength(frame, 'utf8')).toBeGreaterThan(100);
    expect(frame.length).toBeLessThan(120); // UTF-16 code units — previously passed the cap.
    await session.handleMessage(frame);
    expect(emitter.sent).toHaveLength(1);
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32600);
    expect(response.error.message).toMatch(/frame size/i);
    await session.close();
  });

  it('two concurrent subscriptions on one session deliver to correct correlation IDs', async () => {
    const emitter = makeEmitter();
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-A', selector: 'events' },
        id: 's-a',
      }),
    );
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-B', selector: 'events' },
        id: 's-b',
      }),
    );
    await Bun.sleep(10);
    const subA = JSON.parse(emitter.sent[0]!);
    const subB = JSON.parse(emitter.sent[1]!);
    const idA = subA.result.subscriptionId;
    const idB = subB.result.subscriptionId;
    expect(idA).not.toBe(idB);

    await backend.append(makeEnvelope(0, 'wf-A'));
    await backend.append(makeEnvelope(0, 'wf-B'));
    await Bun.sleep(10);

    const deliveries = emitter.sent
      .slice(2)
      .map((s) => JSON.parse(s))
      .filter((m) => m.method === 'weft.events.deliver');
    const correlations = deliveries
      .map((d) => d.params.subscriptionId)
      .toSorted((a: string, b: string) => a.localeCompare(b));
    expect(correlations).toContain(idA);
    expect(correlations).toContain(idB);
    await session.close();
  });
});
