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

import { MemoryStorage } from '../storage/memory.ts';
import { createFleetEventFeed } from './fleet-event-feed.ts';
import { createInMemoryEventBackend } from './in-memory-event-feed-backend.ts';
import {
  createJsonRpcWebSocketSession,
  type JsonRpcWebSocketEmitter,
} from './json-rpc-websocket.ts';
import {
  createOperationRegistry,
  type ErasedOperation,
  type OperationDefinition,
} from './operation-catalog.ts';
import { fleetEventsSubscriptionOperation } from './operations/fleet-events-subscription.ts';
import { workflowEventsSubscriptionOperation } from './operations/workflow-events-subscription.ts';
import { anonymousPrincipal, principalFromApiKey } from './principal.ts';
import {
  createWorkflowEventFeed,
  encodeCursor,
  type WorkflowEventFeed,
} from './workflow-event-feed.ts';

const fakeEngine = {} as unknown;

/**
 * Subscribe-tests need an authenticated principal carrying `events:read`
 * because event-selector subscriptions require the event feed scope.
 */
function subscribePrincipal() {
  return principalFromApiKey({ subject: 'subscribe-test', scopes: ['events:read'] });
}

function streamOnlyPrincipal() {
  return principalFromApiKey({ subject: 'stream-only-test', scopes: ['streams:read'] });
}

function createWebSocketOperationRegistry() {
  return createOperationRegistry([
    workflowEventsSubscriptionOperation,
    fleetEventsSubscriptionOperation,
  ]);
}

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
    destructive: false,
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    ...overrides,
  } as unknown as ErasedOperation;
}

function makeEmitter(): JsonRpcWebSocketEmitter & {
  sent: string[];
  waitForSentCount(count: number): Promise<void>;
  waitForParsedMessage(
    description: string,
    predicate: (message: Record<string, unknown>) => boolean,
  ): Promise<void>;
} {
  const sent: string[] = [];
  type PendingWaiter = {
    readonly description: string;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly isSatisfied: () => boolean;
    readonly timeout: ReturnType<typeof setTimeout>;
  };
  const pendingWaiters: PendingWaiter[] = [];

  function flushPendingWaiters(): void {
    for (let index = pendingWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = pendingWaiters[index];
      if (!waiter?.isSatisfied()) continue;
      clearTimeout(waiter.timeout);
      pendingWaiters.splice(index, 1);
      waiter.resolve();
    }
  }

  function waitFor(description: string, isSatisfied: () => boolean): Promise<void> {
    if (isSatisfied()) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiterIndex = pendingWaiters.findIndex((waiter) => waiter.timeout === timeout);
        if (waiterIndex >= 0) pendingWaiters.splice(waiterIndex, 1);
        reject(
          new Error(
            `${description} within 500ms; saw ${sent.length} frame${sent.length === 1 ? '' : 's'}`,
          ),
        );
      }, 500);

      pendingWaiters.push({ description, resolve, reject, isSatisfied, timeout });
    });
  }

  return {
    sent,
    send(message) {
      sent.push(message);
      flushPendingWaiters();
    },
    waitForSentCount(count: number) {
      return waitFor(`expected at least ${count} emitted frames`, () => sent.length >= count);
    },
    waitForParsedMessage(
      description: string,
      predicate: (message: Record<string, unknown>) => boolean,
    ) {
      return waitFor(description, () =>
        sent.some((frame) => predicate(JSON.parse(frame) as Record<string, unknown>)),
      );
    },
  };
}

function deliveredEnvelopes(sent: readonly string[]): Array<Record<string, unknown>> {
  return sent
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((message) => message['method'] === 'weft.events.deliver')
    .map((message) => {
      const params = message['params'] as { envelope?: Record<string, unknown> };
      return params.envelope ?? {};
    });
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

async function createSubscribedWorkflowSession(feed: WorkflowEventFeed): Promise<{
  readonly emitter: ReturnType<typeof makeEmitter>;
  readonly session: ReturnType<typeof createJsonRpcWebSocketSession>;
  readonly subscriptionId: string;
  readonly unsubscribe: () => Promise<void>;
}> {
  const emitter = makeEmitter();
  const session = createJsonRpcWebSocketSession({
    registry: createWebSocketOperationRegistry(),
    engine: fakeEngine,
    principal: subscribePrincipal(),
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
  await emitter.waitForSentCount(1);
  const subscribeResponse = JSON.parse(emitter.sent[0]!) as {
    readonly result: { readonly subscriptionId: string };
  };
  const subscriptionId = subscribeResponse.result.subscriptionId;

  return {
    emitter,
    session,
    subscriptionId,
    unsubscribe: () =>
      session.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'weft.workflows.unsubscribe',
          params: { subscriptionId },
          id: 'unsub-1',
        }),
      ),
  };
}

describe('createJsonRpcWebSocketSession — frame dispatch', () => {
  it('does not synthesize missing subscription operations into a custom registry', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([]),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 'missing-subscription-operation',
      }),
    );

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32601);
    expect(response.error.data.weftCode).toBe('MethodNotFound');
    await session.close();
  });

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
    // Stable contract: batches over WS are out of spec for
    // subscribe correlation; reject and require per-frame calls.
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
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
      registry: createWebSocketOperationRegistry(),
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
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    await emitter.waitForSentCount(1);
    // The first message is the success response; subsequent are deliver notifications.
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.id).toBe('sub-1');
    expect(response.result.subscriptionId).toMatch(/^sub_/);
    expect(response.result.cursor).toBe('-1');
    await session.close();
  });

  it('weft.workflows.events routes through the session lifecycle and defaults to event envelopes', async () => {
    const emitter = makeEmitter();
    const backend = createInMemoryEventBackend();
    await backend.append(makeEnvelope(0));
    const feed = createWorkflowEventFeed(backend);
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.events',
        params: { workflowId: 'wf-1' },
        id: 'catalog-sub-1',
      }),
    );

    await emitter.waitForParsedMessage(
      'workflow event delivered for catalog subscription',
      (message) => {
        const params = message['params'] as { envelope?: { selector?: string } } | undefined;
        return params?.envelope?.selector === 'events';
      },
    );
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.id).toBe('catalog-sub-1');
    expect(response.result.subscriptionId).toMatch(/^sub_/);
    expect(response.result.cursor).toBe('-1');
    await session.close();
  });

  it('weft.events.subscribe delivers fleet events across workflows', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    await fleetFeed.append({
      kind: 'workflow:started',
      workflowId: 'wf-a',
      emittedAtMs: Date.now(),
      payload: { workflowId: 'wf-a' },
    });
    await fleetFeed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-b',
      emittedAtMs: Date.now(),
      payload: { workflowId: 'wf-b' },
    });
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
      fleetFeed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.events.subscribe',
        params: {},
        id: 'fleet-sub',
      }),
    );

    await emitter.waitForParsedMessage('fleet event for wf-a', (message) => {
      const params = message['params'] as { envelope?: { workflowId?: string } } | undefined;
      return params?.envelope?.workflowId === 'wf-a';
    });
    await emitter.waitForParsedMessage('fleet event for wf-b', (message) => {
      const params = message['params'] as { envelope?: { workflowId?: string } } | undefined;
      return params?.envelope?.workflowId === 'wf-b';
    });

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.id).toBe('fleet-sub');
    expect(response.result.subscriptionId).toMatch(/^sub_/);
    expect(response.result.cursor).toBe('-1');
    await session.close();
  });

  it('weft.events.subscribe rejects unauthenticated and wrong-scope principals', async () => {
    const cases = [
      {
        name: 'anonymous',
        principal: anonymousPrincipal(),
        expectedWeftCode: 'Unauthorized',
      },
      {
        name: 'stream-only',
        principal: streamOnlyPrincipal(),
        expectedWeftCode: 'Forbidden',
      },
    ] as const;

    for (const testCase of cases) {
      const emitter = makeEmitter();
      const feed = createWorkflowEventFeed(createInMemoryEventBackend());
      const fleetFeed = createFleetEventFeed(new MemoryStorage());
      const session = createJsonRpcWebSocketSession({
        registry: createWebSocketOperationRegistry(),
        engine: fakeEngine,
        principal: testCase.principal,
        emitter,
        feed,
        fleetFeed,
      });

      await session.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'weft.events.subscribe',
          params: {},
          id: `fleet-auth-${testCase.name}`,
        }),
      );

      const response = JSON.parse(emitter.sent[0]!);
      expect(response.error.data.weftCode).toBe(testCase.expectedWeftCode);
      await session.close();
    }
  });

  it('weft.events.subscribe delivers live fleet events after subscription setup', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
      fleetFeed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.events.subscribe',
        params: {},
        id: 'fleet-live-sub',
      }),
    );
    await emitter.waitForSentCount(1);

    await fleetFeed.append({
      kind: 'workflow:started',
      workflowId: 'wf-live',
      emittedAtMs: Date.now(),
      payload: { workflowId: 'wf-live' },
    });

    await emitter.waitForParsedMessage('live fleet event for wf-live', (message) => {
      const params = message['params'] as { envelope?: { workflowId?: string } } | undefined;
      return params?.envelope?.workflowId === 'wf-live';
    });

    expect(deliveredEnvelopes(emitter.sent)).toContainEqual(
      expect.objectContaining({ workflowId: 'wf-live', kind: 'workflow:started' }),
    );
    await session.close();
  });

  it('weft.events.subscribe filters fleet events by workflowId and kind', async () => {
    const cases = [
      { name: 'workflowId', params: { workflowId: 'wf-match' } },
      { name: 'kind', params: { kind: 'workflow:completed' } },
      {
        name: 'workflowId and kind',
        params: { workflowId: 'wf-match', kind: 'workflow:completed' },
      },
    ] as const;

    for (const testCase of cases) {
      const emitter = makeEmitter();
      const feed = createWorkflowEventFeed(createInMemoryEventBackend());
      const fleetFeed = createFleetEventFeed(new MemoryStorage());
      await fleetFeed.append({
        kind: 'workflow:started',
        workflowId: 'wf-other',
        emittedAtMs: 1,
        payload: { workflowId: 'wf-other' },
      });
      await fleetFeed.append({
        kind: 'workflow:completed',
        workflowId: 'wf-match',
        emittedAtMs: 2,
        payload: { workflowId: 'wf-match' },
      });
      await fleetFeed.append({
        kind: 'workflow:failed',
        workflowId: 'wf-other',
        emittedAtMs: 3,
        payload: { workflowId: 'wf-other' },
      });
      const session = createJsonRpcWebSocketSession({
        registry: createWebSocketOperationRegistry(),
        engine: fakeEngine,
        principal: subscribePrincipal(),
        emitter,
        feed,
        fleetFeed,
      });

      await session.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'weft.events.subscribe',
          params: testCase.params,
          id: `fleet-filter-${testCase.name}`,
        }),
      );

      await emitter.waitForParsedMessage(`matching fleet event for ${testCase.name}`, (message) => {
        const params = message['params'] as { envelope?: { workflowId?: string } } | undefined;
        return params?.envelope?.workflowId === 'wf-match';
      });

      expect(deliveredEnvelopes(emitter.sent)).toEqual([
        expect.objectContaining({
          workflowId: 'wf-match',
          kind: 'workflow:completed',
        }),
      ]);
      await session.close();
    }
  });

  it('rejects fleet subscriptions with malformed cursors and unsupported kinds', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
      fleetFeed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.events.subscribe',
        params: { fromCursor: 'not-a-cursor' },
        id: 'bad-cursor',
      }),
    );
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.events.subscribe',
        params: { kind: 'stream:token' },
        id: 'bad-kind',
      }),
    );

    const badCursorResponse = JSON.parse(emitter.sent[0]!);
    const badKindResponse = JSON.parse(emitter.sent[1]!);
    expect(badCursorResponse.error.data.weftCode).toBe('InvalidParams');
    expect(badKindResponse.error.data.weftCode).toBe('InvalidParams');
    await session.close();
  });

  it('accepts worker lifecycle fleet event kinds', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
      fleetFeed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.events.subscribe',
        params: { kind: 'worker:connected' },
        id: 'worker-kind',
      }),
    );

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.result.subscriptionId).toBeString();
    await session.close();
  });

  it('rejects explicit non-object fleet subscription params', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
      fleetFeed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.events.subscribe',
        params: [],
        id: 'bad-fleet-params',
      }),
    );

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.data.weftCode).toBe('InvalidParams');
    expect(response.error.message).toBe('params must be an object when present');
    await session.close();
  });

  it('rejects fleet subscriptions when the replay window is too large', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    for (let sequence = 0; sequence <= 1000; sequence += 1) {
      await fleetFeed.append({
        kind: 'workflow:completed',
        workflowId: `wf-${sequence}`,
        emittedAtMs: sequence,
        payload: { workflowId: `wf-${sequence}` },
      });
    }
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
      fleetFeed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.events.subscribe',
        params: {},
        id: 'fleet-too-far-behind',
      }),
    );

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.result.subscriptionId).toMatch(/^sub_/);
    await emitter.waitForParsedMessage('fleet replay limit termination', (message) => {
      const params = message['params'] as
        | { fault?: { code?: string; message?: string } }
        | undefined;
      return (
        message['method'] === 'weft.events.terminated' &&
        params?.fault?.code === 'InvalidParams' &&
        params.fault.message?.includes('maximum is 1000') === true
      );
    });
    await session.close();
  });

  it('terminates workflow subscriptions when the replay window is too large', async () => {
    const emitter = makeEmitter();
    const backend = createInMemoryEventBackend();
    for (let sequence = 0; sequence <= 1000; sequence += 1) {
      await backend.append(makeEnvelope(sequence, 'wf-replay-cap'));
    }
    const feed = createWorkflowEventFeed(backend);
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-replay-cap', selector: 'events' },
        id: 'workflow-too-far-behind',
      }),
    );

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.result.subscriptionId).toMatch(/^sub_/);
    await emitter.waitForParsedMessage('workflow replay limit termination', (message) => {
      const params = message['params'] as
        | { fault?: { code?: string; message?: string } }
        | undefined;
      return (
        message['method'] === 'weft.events.terminated' &&
        params?.fault?.code === 'InvalidParams' &&
        params.fault.message?.includes('maximum is 1000') === true
      );
    });
    await session.close();
  });

  it('rejects fleet subscriptions when no fleet feed is available', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.events.subscribe',
        params: {},
        id: 'missing-fleet-feed',
      }),
    );

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.data.weftCode).toBe('UnsupportedTransport');
    await session.close();
  });

  it('rejects fleet subscribe when the per-session subscription cap is exceeded', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const fleetFeed = createFleetEventFeed(new MemoryStorage());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
      fleetFeed,
      maxSubscriptions: 1,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.events.subscribe',
        params: {},
        id: 'fleet-first',
      }),
    );
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.events.subscribe',
        params: {},
        id: 'fleet-second',
      }),
    );

    await emitter.waitForSentCount(2);
    const second = emitter.sent
      .map((frame) => JSON.parse(frame))
      .find((message) => {
        return message.id === 'fleet-second';
      });
    expect(second?.error?.code).toBe(-32600);
    expect(second?.error?.message).toMatch(/subscriptions/i);
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
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    await emitter2.waitForParsedMessage('replayed sequence 0 delivery', (message) => {
      return (
        message['method'] === 'weft.events.deliver' &&
        (message['params'] as { envelope?: { sequence?: number } } | undefined)?.envelope
          ?.sequence === 0
      );
    });
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
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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

  it('rejects workflow subscriptions with malformed cursors', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events', fromCursor: 'not-a-cursor' },
        id: 'bad-workflow-cursor',
      }),
    );

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.data.weftCode).toBe('InvalidParams');
    await session.close();
  });

  it('rejects subscribe when the shared session is reused for stdio transport', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
      transport: 'jsonRpcStdio',
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 'sub-stdio',
      }),
    );

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32030);
    expect(response.error.data.weftCode).toBe('UnsupportedTransport');
    await session.close();
  });

  it('rejects subscribe / unsubscribe frames missing jsonrpc: "2.0"', async () => {
    // Bugbot regression: session primitives bypassed the version
    // check other methods route through. Every frame must carry
    // `jsonrpc: "2.0"` or be rejected with InvalidRequest.
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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

  it('does not send direct responses for subscribe / unsubscribe notifications', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
      }),
    );
    expect(emitter.sent).toHaveLength(0);

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 'sub-1',
      }),
    );
    await emitter.waitForSentCount(1);
    const subscribeResponse = JSON.parse(emitter.sent[0]!);
    const subscriptionId = subscribeResponse.result.subscriptionId;

    const messageCountBeforeNotification = emitter.sent.length;
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId },
      }),
    );
    await emitter.waitForParsedMessage('unsubscribe termination notification', (message) => {
      return message['method'] === 'weft.events.terminated';
    });
    const notificationMessages = emitter.sent
      .slice(messageCountBeforeNotification)
      .map((message) => JSON.parse(message));
    expect(notificationMessages.some((message) => Object.hasOwn(message, 'id'))).toBe(false);
    expect(notificationMessages.map((message) => message.method)).toContain(
      'weft.events.terminated',
    );
    await session.close();
  });

  it('delivers live envelopes as weft.events.deliver notifications', async () => {
    const emitter = makeEmitter();
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    await emitter.waitForSentCount(1);
    await backend.append(makeEnvelope(0));
    await emitter.waitForParsedMessage('live delivery notification', (message) => {
      return (
        message['method'] === 'weft.events.deliver' &&
        (message['params'] as { envelope?: { sequence?: number } } | undefined)?.envelope
          ?.sequence === 0
      );
    });
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
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    await emitter.waitForSentCount(1);
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
    await emitter.waitForParsedMessage('client-unsubscribed termination', (message) => {
      return message['method'] === 'weft.events.terminated';
    });

    const messages = emitter.sent.map((s) => JSON.parse(s));
    const terminated = messages.find((m) => m.method === 'weft.events.terminated');
    expect(terminated).toBeDefined();
    expect(terminated.params.subscriptionId).toBe(subscriptionId);
    expect(terminated.params.reason).toBe('client-unsubscribed');
    await session.close();
  });

  it('close() awaits pump cleanup after unsubscribe starts termination', async () => {
    let releaseCleanup: () => void = () => {};
    const cleanupCanFinish = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupStarted: () => void = () => {};
    const cleanupDidStart = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let cleanupFinished = false;

    const feed: WorkflowEventFeed = {
      replay: createWorkflowEventFeed(createInMemoryEventBackend()).replay,
      subscribe(options) {
        async function* subscription(): AsyncIterable<ReturnType<typeof makeEnvelope>> {
          try {
            await new Promise<void>((resolve) => {
              if (options.signal?.aborted) {
                resolve();
                return;
              }
              options.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          } finally {
            cleanupStarted();
            await cleanupCanFinish;
            cleanupFinished = true;
          }
        }
        return subscription();
      },
      dispose() {},
    };

    const { session, unsubscribe } = await createSubscribedWorkflowSession(feed);

    await unsubscribe();
    await cleanupDidStart;

    let closeSettled = false;
    const closePromise = session.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseCleanup();
    await closePromise;
    expect(cleanupFinished).toBe(true);
  });

  it('emits exactly one terminated frame when the iterable throws during unsubscribe teardown', async () => {
    // Regression for the case where `handleUnsubscribe` aborts the
    // controller and emits `client-unsubscribed`, and the iterable then
    // throws during teardown (a real possibility once `closeOnce()`
    // explicitly aborts the internal subscription controller). The pump's
    // catch block must NOT emit a second `terminated` notification — the
    // client already received the authoritative `client-unsubscribed`
    // frame, and a follow-up `server-closed` would be a wire-protocol
    // duplicate for the same `subscriptionId`.
    const feed: WorkflowEventFeed = {
      replay: createWorkflowEventFeed(createInMemoryEventBackend()).replay,
      subscribe(options) {
        async function* subscription(): AsyncIterable<ReturnType<typeof makeEnvelope>> {
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) {
              resolve();
              return;
            }
            options.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          // Simulate the underlying feed raising during teardown — for
          // example, a real feed whose internal cursor closes while the
          // pump's `closeOnce()` is still draining. The thrown value
          // surfaces in the pump's catch block.
          throw new Error('teardown raced');
        }
        return subscription();
      },
      dispose() {},
    };

    const { emitter, session, subscriptionId, unsubscribe } =
      await createSubscribedWorkflowSession(feed);

    await unsubscribe();

    // Wait for `client-unsubscribed` AND give the pump a chance to land
    // its catch block — otherwise we'd assert before the (incorrect)
    // second emission could fire.
    await emitter.waitForParsedMessage('client-unsubscribed termination', (message) => {
      return (
        message['method'] === 'weft.events.terminated' &&
        (message['params'] as { reason?: unknown }).reason === 'client-unsubscribed'
      );
    });

    // Drain microtasks so the pump's try/catch settles BEFORE we close
    // the session (which would set `disposed=true` and suppress any
    // erroneous duplicate). Looping `await Promise.resolve()` a handful
    // of times lets every queued microtask run.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const terminatedFrames = emitter.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter(
        (m) =>
          m['method'] === 'weft.events.terminated' &&
          (m['params'] as { subscriptionId?: unknown }).subscriptionId === subscriptionId,
      );
    expect(terminatedFrames).toHaveLength(1);
    expect((terminatedFrames[0]!['params'] as { reason: string }).reason).toBe(
      'client-unsubscribed',
    );
    await session.close();
  });

  it('close() terminates all active subscriptions', async () => {
    const emitter = makeEmitter();
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    await emitter.waitForSentCount(1);
    const countBeforeClose = emitter.sent.length;

    await session.close();

    // After close, new live events must NOT reach the emitter.
    await backend.append(makeEnvelope(0));
    expect(emitter.sent.length).toBe(countBeforeClose);
  });

  it('unsubscribe with an unknown subscriptionId returns a NotFound fault', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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

  it('rejects unsubscribe with a non-string subscriptionId', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId: 42 },
        id: 'u-bad',
      }),
    );
    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toMatch(/subscriptionId/);
    await session.close();
  });

  it('rejects subscribe with non-string workflowId (-32602 InvalidParams)', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    await emitter.waitForSentCount(3);
    const responses = emitter.sent.map((s) => JSON.parse(s));
    // Third subscribe should come back as an error response.
    const third = responses.find((m) => m.id === 's2');
    expect(third?.error?.code).toBe(-32600);
    expect(third?.error?.message).toMatch(/subscriptions/i);
    await session.close();
  });

  it('emits server-closed when a subscription finishes naturally', async () => {
    const emitter = makeEmitter();
    const feed: WorkflowEventFeed = {
      replay: async function* () {},
      subscribe() {
        async function* subscription(): AsyncIterable<ReturnType<typeof makeEnvelope>> {
          yield makeEnvelope(0);
        }

        return subscription();
      },
      dispose() {},
    };
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    await emitter.waitForParsedMessage('natural deliver notification', (message) => {
      return message['method'] === 'weft.events.deliver';
    });
    await emitter.waitForParsedMessage(
      'server-closed termination after natural completion',
      (message) => {
        return message['method'] === 'weft.events.terminated';
      },
    );

    const messages = emitter.sent.map((message) => JSON.parse(message));
    expect(messages.some((message) => message.method === 'weft.events.deliver')).toBe(true);
    const terminated = messages.find((message) => message.method === 'weft.events.terminated');
    expect(terminated?.params.reason).toBe('server-closed');

    await session.close();
  });

  it('emits a generic server-closed fault when the subscription pump throws', async () => {
    const emitter = makeEmitter();
    const feed: WorkflowEventFeed = {
      replay: async function* () {},
      subscribe() {
        async function* subscription(): AsyncIterable<ReturnType<typeof makeEnvelope>> {
          throw new Error('boom');
        }

        return subscription();
      },
      dispose() {},
    };
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    await emitter.waitForParsedMessage(
      'server-closed termination after pump failure',
      (message) => {
        return message['method'] === 'weft.events.terminated';
      },
    );

    const terminated = emitter.sent
      .map((message) => JSON.parse(message))
      .find((message) => message.method === 'weft.events.terminated');
    expect(terminated?.params.reason).toBe('server-closed');
    expect(terminated?.params.fault).toEqual({
      code: 'EngineFailure',
      message: 'internal error',
      data: {},
    });

    await session.close();
  });

  it('rejects frames larger than maxFrameBytes before parsing', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    //
    // The semantic check is "the subscription's abort signal fired" —
    // that's what `subscriptionAborted` captures. The generator's
    // post-await body may not run after `close()` aborts the pump (the
    // for-await `break`s on the abort, calling `iterator.return()`),
    // so this test does not assume the generator runs to completion.
    let subscriptionAborted = false;
    const feed: WorkflowEventFeed = {
      replay: async function* () {},
      subscribe(options) {
        // Mirror the real `WorkflowEventFeed`: register the abort
        // listener UPFRONT so the feed observes session teardown even
        // if the pump never pulls another iteration after abort. The
        // pump is allowed to break immediately on abort — the feed's
        // teardown path lives behind the abort signal, not behind a
        // post-yield body that might never run.
        options.signal?.addEventListener(
          'abort',
          () => {
            subscriptionAborted = true;
          },
          { once: true },
        );
        if (options.signal?.aborted) subscriptionAborted = true;
        async function* subscription(): AsyncIterable<ReturnType<typeof makeEnvelope>> {
          yield makeEnvelope(0);
          // Park forever — exit semantics are owned by the abort signal.
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => resolve(), { once: true });
            if (options.signal?.aborted) resolve();
          });
        }

        return subscription();
      },
      dispose() {},
    };
    let sendThrew = false;
    const emitter: JsonRpcWebSocketEmitter = {
      send() {
        // First send OK, second throws.
        if (sendThrew) throw new Error('socket closed');
        sendThrew = true;
      },
    };
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    await Promise.resolve();
    // `close()` must still abort the subscription pump even though
    // the emitter is broken. Awaiting `close()` to settle proves the
    // pump promise resolves (no leaked feed listener).
    await session.close();
    expect(subscriptionAborted).toBe(true);
  });

  it('rejects frames whose UTF-8 byte length exceeds maxFrameBytes (not string length)', async () => {
    // Bugbot regression: `frame.length` counts UTF-16 code units,
    // not bytes. A multi-byte payload (emoji, CJK) could previously
    // slip past a byte-cap configured via `maxFrameBytes`.
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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

  it('emits server-closed when a subscription pump ends naturally', async () => {
    const emitter = makeEmitter();
    const feed: WorkflowEventFeed = {
      replay: createWorkflowEventFeed(createInMemoryEventBackend()).replay,
      subscribe() {
        async function* subscription() {
          return;
        }
        return subscription();
      },
      dispose() {},
    };
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
    });
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: 'sub-natural',
      }),
    );
    await emitter.waitForParsedMessage(
      'server-closed termination after empty subscription',
      (message) => {
        return message['method'] === 'weft.events.terminated';
      },
    );
    const terminated = emitter.sent
      .map((message) => JSON.parse(message))
      .find((message) => message.method === 'weft.events.terminated');
    expect(terminated?.params.reason).toBe('server-closed');
    await session.close();
  });

  it('two concurrent subscriptions on one session deliver to correct correlation IDs', async () => {
    const emitter = makeEmitter();
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
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
    await emitter.waitForSentCount(2);
    const subA = JSON.parse(emitter.sent[0]!);
    const subB = JSON.parse(emitter.sent[1]!);
    const idA = subA.result.subscriptionId;
    const idB = subB.result.subscriptionId;
    expect(idA).not.toBe(idB);

    await backend.append(makeEnvelope(0, 'wf-A'));
    await backend.append(makeEnvelope(0, 'wf-B'));
    await emitter.waitForParsedMessage('delivery for subscription A', (message) => {
      return (
        message['method'] === 'weft.events.deliver' &&
        message['params'] !== null &&
        typeof message['params'] === 'object' &&
        Object.hasOwn(message['params'], 'subscriptionId')
      );
    });
    await emitter.waitForSentCount(4);

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

  it('rejects frames whose parsed JSON value is not an object', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
    });

    await session.handleMessage('true');

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32600);
    expect(response.error.message).toMatch(/JSON object/);

    await session.close();
  });

  it('rejects session-primitive frames with an invalid request id type', async () => {
    const emitter = makeEmitter();
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const session = createJsonRpcWebSocketSession({
      registry: createWebSocketOperationRegistry(),
      engine: fakeEngine,
      principal: subscribePrincipal(),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
        id: { bad: true },
      }),
    );

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.error.code).toBe(-32600);
    expect(response.error.message).toMatch(/id must be a string, number, null, or absent/i);
    expect(response.id).toBeNull();

    await session.close();
  });
});
