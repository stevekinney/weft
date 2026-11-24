import { describe, expect, test } from 'bun:test';

import {
  type SendMessageRequest,
  type StreamResponse,
  type SubscribeToTaskRequest,
  TaskState,
} from '@a2a-js/sdk';
import { A2A_ERROR_CODE, TaskNotFoundError } from '@a2a-js/sdk/errors';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type ServerCallContext,
} from '@a2a-js/sdk/server';

import {
  agentCardFixture,
  echoExecutor,
  PUBLIC_URL,
  rpcRequest,
  sendMessageBody,
} from './a2a.test-support.ts';
import {
  createA2AHandler,
  createA2AHandlerWithScheduler,
  DEFAULT_MAX_STREAM_DURATION_MS,
} from './handler.ts';
import type { A2AStreamTimerScheduler } from './sse-response.ts';
import { withStreamEventCursor } from './stream-cursors.ts';

type StreamSource = (context: ServerCallContext) => AsyncGenerator<StreamResponse, void, undefined>;

/** A `DefaultRequestHandler` whose streaming methods yield whatever `source` produces. */
class ScriptedStreamHandler extends DefaultRequestHandler {
  constructor(private readonly source: StreamSource) {
    super(agentCardFixture(), new InMemoryTaskStore(), echoExecutor);
  }
  override sendMessageStream(
    _params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    return this.source(context);
  }
  override resubscribe(
    _params: SubscribeToTaskRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    return this.source(context);
  }
}

function statusEvent(index: number): StreamResponse {
  return {
    payload: {
      $case: 'statusUpdate',
      value: {
        taskId: 'task-1',
        contextId: 'context-1',
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
        metadata: { index },
      },
    },
  };
}

type ServerSentEvent = { id: string | undefined; data: string[]; comments: string[] };

/** Split a complete `text/event-stream` body into its events. */
function parseEvents(text: string): ServerSentEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => {
      const event: ServerSentEvent = { id: undefined, data: [], comments: [] };
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) event.id = line.slice(4);
        else if (line.startsWith('data: ')) event.data.push(line.slice(6));
        else if (line.startsWith(':')) event.comments.push(line);
      }
      return event;
    });
}

type ManualClock = {
  readonly schedule: A2AStreamTimerScheduler;
  readonly delays: number[];
  readonly canceled: number[];
  fire(): void;
};

function manualClock(): ManualClock {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const canceled: number[] = [];
  return {
    delays,
    canceled,
    schedule(callback, delayMs) {
      const index = callbacks.push(callback) - 1;
      delays.push(delayMs);
      return () => {
        canceled.push(index);
      };
    },
    fire() {
      for (const callback of callbacks) callback();
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

describe('createA2AHandler: streaming', () => {
  test('writes one JSON-RPC response per event and each tagged event’s cursor as its SSE id', async () => {
    const cursors = [
      'c-0',
      undefined,
      'c-2',
      'c-3',
      undefined,
      undefined,
      'c-6',
      undefined,
      'c-8',
      'c-9',
    ];
    const handler = createA2AHandler({
      requestHandler: new ScriptedStreamHandler(async function* () {
        for (const [index, cursor] of cursors.entries()) {
          const event = statusEvent(index);
          yield cursor === undefined ? event : withStreamEventCursor(event, cursor);
        }
      }),
      agentCard: agentCardFixture(),
      publicUrl: PUBLIC_URL,
    });

    const response = await handler(
      rpcRequest(sendMessageBody({ method: 'SendStreamingMessage', id: 'stream-1' })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const events = parseEvents(await response.text());
    expect(events.map((event) => event.id)).toEqual(cursors);
    for (const [index, event] of events.entries()) {
      expect(event.data).toHaveLength(1);
      expect(JSON.parse(event.data[0] ?? '')).toEqual({
        jsonrpc: '2.0',
        id: 'stream-1',
        result: {
          statusUpdate: {
            taskId: 'task-1',
            contextId: 'context-1',
            status: { state: 'TASK_STATE_WORKING' },
            metadata: { index },
          },
        },
      });
    }
  });

  test('records cursors for SubscribeToTask as well', async () => {
    const handler = createA2AHandler({
      requestHandler: new ScriptedStreamHandler(async function* () {
        yield withStreamEventCursor(statusEvent(0), 'resume-1');
        yield statusEvent(1);
      }),
      agentCard: agentCardFixture(),
      publicUrl: PUBLIC_URL,
    });

    const response = await handler(
      rpcRequest({ jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: 'task-1' } }),
    );

    expect(parseEvents(await response.text()).map((event) => event.id)).toEqual([
      'resume-1',
      undefined,
    ]);
  });

  test('lists extensions activated by the stream’s first event in the response header', async () => {
    const handler = createA2AHandler({
      requestHandler: new ScriptedStreamHandler(async function* (context) {
        context.addActivatedExtension('urn:example:streamed');
        yield statusEvent(0);
      }),
      agentCard: agentCardFixture(),
      publicUrl: PUBLIC_URL,
    });

    const response = await handler(rpcRequest(sendMessageBody({ method: 'SendStreamingMessage' })));

    expect(response.headers.get('a2a-extensions')).toBe('urn:example:streamed');
    await response.text();
  });

  test('answers an error raised before the first event as a JSON-RPC response, not a stream', async () => {
    const card = agentCardFixture();
    card.capabilities = { streaming: false, extensions: [] };
    const handler = createA2AHandler({
      requestHandler: new DefaultRequestHandler(card, new InMemoryTaskStore(), echoExecutor),
      agentCard: card,
      publicUrl: PUBLIC_URL,
    });

    const response = await handler(
      rpcRequest(sendMessageBody({ method: 'SendStreamingMessage', id: 4 })),
    );

    expect(response.headers.get('content-type')).toStartWith('application/json');
    expect(await response.json()).toMatchObject({
      id: 4,
      error: { code: A2A_ERROR_CODE.UNSUPPORTED_OPERATION },
    });
  });

  test('ends the stream with one error response when the handler fails mid-stream', async () => {
    const handler = createA2AHandler({
      requestHandler: new ScriptedStreamHandler(async function* () {
        yield withStreamEventCursor(statusEvent(0), 'c-0');
        throw new TaskNotFoundError('task-1 vanished');
      }),
      agentCard: agentCardFixture(),
      publicUrl: PUBLIC_URL,
    });

    const response = await handler(
      rpcRequest(sendMessageBody({ method: 'SendStreamingMessage', id: 5 })),
    );
    const events = parseEvents(await response.text());

    expect(events).toHaveLength(2);
    expect(events[1]?.id).toBeUndefined();
    expect(JSON.parse(events[1]?.data[0] ?? '')).toMatchObject({
      jsonrpc: '2.0',
      id: 5,
      error: { code: A2A_ERROR_CODE.TASK_NOT_FOUND },
    });
  });

  test('closes an empty stream without events', async () => {
    const handler = createA2AHandler({
      requestHandler: new ScriptedStreamHandler(async function* () {}),
      agentCard: agentCardFixture(),
      publicUrl: PUBLIC_URL,
    });

    const response = await handler(rpcRequest(sendMessageBody({ method: 'SendStreamingMessage' })));

    expect(await response.text()).toBe('');
  });

  test.each([
    ['a line feed', 'c-1\ndata: forged'],
    ['a carriage return', 'c-1\rid: other'],
    ['a NUL', 'c-1\u0000'],
  ])('refuses a cursor containing %s, which would break SSE framing', (_label, cursor) => {
    expect(() => withStreamEventCursor(statusEvent(0), cursor)).toThrow(
      'A2A stream cursor must not contain a carriage return, line feed, or NUL',
    );
  });
});

describe('createA2AHandler: stream duration', () => {
  test('defaults maxStreamDurationMs to fifteen minutes and cancels the timer when the stream ends', async () => {
    const clock = manualClock();
    const handler = createA2AHandlerWithScheduler(
      {
        requestHandler: new ScriptedStreamHandler(async function* () {
          yield statusEvent(0);
        }),
        agentCard: agentCardFixture(),
        publicUrl: PUBLIC_URL,
      },
      clock.schedule,
    );

    const response = await handler(rpcRequest(sendMessageBody({ method: 'SendStreamingMessage' })));
    await response.text();

    expect(DEFAULT_MAX_STREAM_DURATION_MS).toBe(900_000);
    expect(clock.delays).toEqual([900_000]);
    expect(clock.canceled).toEqual([0]);
  });

  test('closes a stream after maxStreamDurationMs with a final comment line', async () => {
    const clock = manualClock();
    const released = deferred();
    const upstreamFinished = deferred();
    const handler = createA2AHandlerWithScheduler(
      {
        requestHandler: new ScriptedStreamHandler(async function* () {
          try {
            yield withStreamEventCursor(statusEvent(0), 'c-0');
            await released.promise;
            yield statusEvent(1);
          } finally {
            upstreamFinished.resolve();
          }
        }),
        agentCard: agentCardFixture(),
        publicUrl: PUBLIC_URL,
        maxStreamDurationMs: 1_000,
      },
      clock.schedule,
    );

    const response = await handler(rpcRequest(sendMessageBody({ method: 'SendStreamingMessage' })));
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    const first = await reader?.read();
    expect(parseEvents(decoder.decode(first?.value))[0]?.id).toBe('c-0');

    expect(clock.delays).toEqual([1_000]);
    clock.fire();
    let rest = '';
    for (let chunk = await reader?.read(); chunk?.done === false; chunk = await reader?.read()) {
      rest += decoder.decode(chunk.value);
    }

    expect(rest).toBe(': stream closed after 1000 ms; reconnect to continue\n\n');
    released.resolve();
    await upstreamFinished.promise;
  });

  test('stops the upstream stream and the timer when the client disconnects', async () => {
    const clock = manualClock();
    const released = deferred();
    const upstreamFinished = deferred();
    const handler = createA2AHandlerWithScheduler(
      {
        requestHandler: new ScriptedStreamHandler(async function* () {
          try {
            yield statusEvent(0);
            await released.promise;
            yield statusEvent(1);
          } finally {
            upstreamFinished.resolve();
          }
        }),
        agentCard: agentCardFixture(),
        publicUrl: PUBLIC_URL,
      },
      clock.schedule,
    );

    const response = await handler(rpcRequest(sendMessageBody({ method: 'SendStreamingMessage' })));
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    expect(clock.canceled).toEqual([0]);
    released.resolve();
    await upstreamFinished.promise;
    clock.fire();
  });

  test('absorbs a failure in the upstream stream’s cleanup after the client disconnects', async () => {
    // An unabsorbed rejection here would surface as an unhandled error and fail the run.
    const released = deferred();
    const cleanupStarted = deferred();
    const failCleanup = (): never => {
      throw new Error('cleanup failed');
    };
    const handler = createA2AHandlerWithScheduler(
      {
        requestHandler: new ScriptedStreamHandler(async function* () {
          try {
            yield statusEvent(0);
            await released.promise;
            yield statusEvent(1);
          } finally {
            cleanupStarted.resolve();
            failCleanup();
          }
        }),
        agentCard: agentCardFixture(),
        publicUrl: PUBLIC_URL,
      },
      manualClock().schedule,
    );

    const response = await handler(rpcRequest(sendMessageBody({ method: 'SendStreamingMessage' })));
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    released.resolve();
    await cleanupStarted.promise;

    expect(await reader?.closed).toBeUndefined();
  });
});
