import { describe, expect, it } from 'bun:test';

import { createInMemoryEventBackend } from './in-memory-event-feed-backend.ts';
import {
  createJsonRpcWebSocketSession,
  type JsonRpcWebSocketEmitter,
} from './json-rpc-websocket.ts';
import { principalFromApiKey } from './principal.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';
import {
  createWorkflowEventFeed,
  encodeCursor,
  type EventEnvelope,
  type WorkflowEventFeed,
} from './workflow-event-feed.ts';

const fakeEngine = {} as unknown;

function makeEmitter(): JsonRpcWebSocketEmitter & {
  readonly sent: string[];
  waitForSentCount(count: number): Promise<void>;
  waitForParsedMessage(
    description: string,
    predicate: (message: Record<string, any>) => boolean,
  ): Promise<void>;
} {
  const sent: string[] = [];
  const waiters: Array<{
    readonly isSatisfied: () => boolean;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }> = [];

  function flush(): void {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter?.isSatisfied()) continue;
      clearTimeout(waiter.timeout);
      waiters.splice(index, 1);
      waiter.resolve();
    }
  }

  function waitFor(description: string, isSatisfied: () => boolean): Promise<void> {
    if (isSatisfied()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timeout === timeout);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`${description} within 500ms; saw ${sent.length} frames`));
      }, 500);
      waiters.push({ isSatisfied, resolve, reject, timeout });
    });
  }

  return {
    sent,
    send(message) {
      sent.push(message);
      flush();
    },
    waitForSentCount(count) {
      return waitFor(`expected at least ${count} frames`, () => sent.length >= count);
    },
    waitForParsedMessage(description, predicate) {
      return waitFor(description, () =>
        sent.some((frame) => predicate(JSON.parse(frame) as Record<string, any>)),
      );
    },
  };
}

function makeEnvelope(sequence: number, workflowId = 'wf-1'): EventEnvelope {
  return {
    kind: 'workflow:started',
    workflowId,
    selector: 'events',
    sequence,
    cursor: encodeCursor(sequence),
    emittedAtMs: Date.now(),
    payload: { type: 'started' },
  };
}

function createSession(feed: WorkflowEventFeed, emitter = makeEmitter()) {
  return {
    emitter,
    session: createJsonRpcWebSocketSession({
      registry: createLiveOperationRegistry(),
      engine: fakeEngine,
      principal: principalFromApiKey({ subject: 'test', scopes: ['events:read'] }),
      emitter,
      feed,
    }),
  };
}

function subscribeFrame(id: string | number, workflowId = 'wf-1'): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'weft.workflows.subscribe',
    params: { workflowId, selector: 'events' },
    id,
  });
}

describe('createJsonRpcWebSocketSession lifecycle acceptance', () => {
  it('creates a fresh subscriptionId for duplicate subscribe params', async () => {
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const { session, emitter } = createSession(feed);

    await session.handleMessage(subscribeFrame('sub-1'));
    await session.handleMessage(subscribeFrame('sub-2'));
    await emitter.waitForSentCount(2);

    const first = JSON.parse(emitter.sent[0]!);
    const second = JSON.parse(emitter.sent[1]!);
    expect(first.result.subscriptionId).toMatch(/^sub_/);
    expect(second.result.subscriptionId).toMatch(/^sub_/);
    expect(second.result.subscriptionId).not.toBe(first.result.subscriptionId);

    await session.close();
  });

  it('returns NotFound for unsubscribe of an unknown subscriptionId', async () => {
    const feed = createWorkflowEventFeed(createInMemoryEventBackend());
    const { session, emitter } = createSession(feed);

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId: 'sub_missing' },
        id: 'unsub-missing',
      }),
    );

    const response = JSON.parse(emitter.sent[0]!);
    expect(response.id).toBe('unsub-missing');
    expect(response.error.code).toBe(-32020);
    expect(response.error.data.weftCode).toBe('NotFound');

    await session.close();
  });

  it('aborts every active subscription pump on socket close', async () => {
    let abortCount = 0;
    const feed: WorkflowEventFeed = {
      replay: async function* () {},
      subscribe(options) {
        async function* subscription(): AsyncIterable<EventEnvelope> {
          try {
            await new Promise<void>((resolve) => {
              if (options.signal?.aborted) {
                resolve();
                return;
              }
              options.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          } finally {
            abortCount += 1;
          }
        }
        return subscription();
      },
      dispose() {},
    };
    const { session, emitter } = createSession(feed);

    await session.handleMessage(subscribeFrame('sub-1', 'wf-a'));
    await session.handleMessage(subscribeFrame('sub-2', 'wf-b'));
    await emitter.waitForSentCount(2);
    await session.close();

    expect(abortCount).toBe(2);
  });

  it('emits a server-closed fault when the iterable throws mid-stream', async () => {
    const feed: WorkflowEventFeed = {
      replay: async function* () {},
      subscribe() {
        async function* subscription(): AsyncIterable<EventEnvelope> {
          yield makeEnvelope(0);
          throw new Error('subscription failed');
        }
        return subscription();
      },
      dispose() {},
    };
    const { session, emitter } = createSession(feed);

    await session.handleMessage(subscribeFrame('sub-throw'));
    await emitter.waitForParsedMessage(
      'terminated notification after iterable throw',
      (message) => message['method'] === 'weft.events.terminated',
    );

    const terminated = emitter.sent
      .map((frame) => JSON.parse(frame))
      .find((message) => message.method === 'weft.events.terminated');
    expect(terminated?.params.reason).toBe('server-closed');
    expect(terminated?.params.fault).toEqual({
      code: 'EngineFailure',
      message: 'internal error',
      data: {},
    });

    await session.close();
  });

  it('emits server-closed without a fault when feed overflow closes the iterable', async () => {
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend, { liveBufferSize: 0 });
    const { session, emitter } = createSession(feed);

    await session.handleMessage(subscribeFrame('sub-overflow'));
    await emitter.waitForSentCount(1);
    await backend.append(makeEnvelope(0));
    await emitter.waitForParsedMessage(
      'terminated notification after overflow close',
      (message) => message['method'] === 'weft.events.terminated',
    );

    const terminated = emitter.sent
      .map((frame) => JSON.parse(frame))
      .find((message) => message.method === 'weft.events.terminated');
    expect(terminated?.params.reason).toBe('server-closed');
    expect(terminated?.params.fault).toBeUndefined();

    await session.close();
  });
});
