/**
 * Peer task paths that need a misbehaving peer: a stream that closes before answering, a polling
 * peer that answers with a message, a `CancelTask` that leaves the task running, and a failing
 * recovery lookup. A scripted peer answers the rest as the real handler would.
 */
import { describe, expect, jest, test } from 'bun:test';

import { A2APeerError } from './peer-client-types.ts';
import { createScriptedPeer, type ScriptedPeerOptions } from './peer-client.test-support.ts';
import { createA2APeerClient } from './peer-client.ts';

// load-proof: the client's injected sleep seam replaces its real backoff delay and the client under test awaits it, so it is an input to the code, not a test-side wait for state
const immediate = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function connect(
  peerOptions: ScriptedPeerOptions = {},
  clientOptions: Partial<Parameters<typeof createA2APeerClient>[0]> = {},
) {
  const peer = createScriptedPeer(peerOptions);
  const client = createA2APeerClient({
    url: peer.url,
    fetch: peer.fetch,
    sleep: immediate,
    retryBaseDelayMs: 1,
    attempts: 1,
    ...clientOptions,
  });
  return { peer, client };
}

async function failureOf(promise: Promise<unknown>): Promise<A2APeerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof A2APeerError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

const nonStreaming: ScriptedPeerOptions['card'] = (card) => {
  if (card.capabilities !== undefined) card.capabilities.streaming = false;
  return card;
};

/** A JSON-RPC answer to `request` carrying `result`. */
async function answer(request: Request, result: unknown): Promise<Response> {
  const body = (await request.clone().json()) as { id: number };
  return Response.json({ jsonrpc: '2.0', id: body.id, result });
}

const messageOnly = {
  message: {
    messageId: 'm-1',
    role: 'ROLE_AGENT',
    parts: [{ text: 'just a message', mediaType: 'text/plain' }],
  },
};

describe('a streaming peer that closes before answering', () => {
  test('fails the send as a protocol error', async () => {
    const { client } = connect({
      intercept: (_request, method) =>
        method === 'SendStreamingMessage'
          ? new Response('', { headers: { 'content-type': 'text/event-stream' } })
          : undefined,
    });

    const failure = await failureOf(client.send({ text: 'hi' }));

    expect(failure.code).toBe('protocol');
    expect(failure.message).toBe('The peer closed the stream without a response.');
  });
});

test('aborts an opening stream when its first task fails validation', async () => {
  let openingSignal: AbortSignal | undefined;
  const { client } = connect({
    intercept: async (request, method) => {
      if (method !== 'SendStreamingMessage') return undefined;
      openingSignal = request.signal;
      const body = (await request.clone().json()) as { id: number };
      const result = {
        task: {
          id: 'x'.repeat(1025),
          contextId: 'context-1',
          status: { state: 'TASK_STATE_WORKING' },
        },
      };
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`,
              ),
            );
            request.signal.addEventListener(
              'abort',
              () => controller.error(request.signal.reason),
              { once: true },
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });

  const failure = await failureOf(client.send({ text: 'hi' }));
  expect(failure.code).toBe('protocol');
  expect(openingSignal?.aborted).toBe(true);
});

test('accepts a continuation whose first response already contains its next question', async () => {
  const task = { id: 'task-1', contextId: 'context-1' };
  function question(text: string) {
    return {
      ...task,
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: { messageId: text, role: 'ROLE_AGENT', parts: [{ text }] },
      },
    };
  }
  let receivedContinuation = false;
  const { client, peer } = connect(
    {
      card: nonStreaming,
      intercept: (request, method) => {
        if (method === 'GetTask') {
          return answer(request, { task: question(receivedContinuation ? 'second' : 'first') });
        }
        if (method !== 'SendMessage') return undefined;
        receivedContinuation = true;
        return answer(request, { task: question('second') });
      },
    },
    { taskTimeoutMs: 100 },
  );

  const continuation = await client.send({ text: 'answer', taskId: task.id });
  expect(await continuation.result()).toMatchObject({
    state: 'input-required',
    taskId: task.id,
    message: 'second',
  });
  expect(peer.methods().filter((method) => method === 'GetTask')).toHaveLength(1);
});

describe('a polling peer that answers with a message instead of a task', () => {
  test('settles with the message, which leaves nothing to cancel', async () => {
    const { peer, client } = connect({
      card: nonStreaming,
      intercept: (request, method) =>
        method === 'SendMessage' ? answer(request, messageOnly) : undefined,
    });

    const task = await client.send({ text: 'hi' });
    const outcome = await task.cancel();

    expect(task.taskId).toBe('');
    expect(outcome).toMatchObject({ state: 'completed', message: 'just a message' });
    expect(peer.methods()).not.toContain('CancelTask');
  });
});

describe('a task the peer stops on without naming it', () => {
  test('is canceled locally, because there is no task id to send a CancelTask for', async () => {
    const { peer, client } = connect({
      card: nonStreaming,
      intercept: (request, method) =>
        method === 'SendMessage'
          ? answer(request, {
              task: {
                id: '',
                contextId: 'context-1',
                status: { state: 'TASK_STATE_INPUT_REQUIRED' },
              },
            })
          : undefined,
    });

    const task = await client.send({ text: 'hi' });
    const outcome = await task.cancel();

    expect(outcome).toMatchObject({ state: 'canceled', cancelConfirmed: false });
    expect(outcome.cancelError).toBe('the peer has not named the task');
    expect(peer.methods()).not.toContain('CancelTask');
  });
});

describe('a CancelTask the peer answers without canceling', () => {
  test('keeps the task locally canceled and reports the state the peer left it in', async () => {
    const { client } = connect({
      intercept: async (_request, method, real) => {
        if (method !== 'CancelTask') return undefined;
        const answered = await real();
        const body = (await answered.json()) as {
          result: { status: { state: string } };
        };
        body.result.status.state = 'TASK_STATE_WORKING';
        return Response.json(body);
      },
    });
    const task = await client.send({ text: 'hang' });

    const outcome = await task.cancel();

    expect(outcome).toMatchObject({ state: 'canceled', cancelConfirmed: false });
    expect(outcome.cancelError).toContain('the peer left the task working');
  });
});

describe('a cancellation response that stalls after headers', () => {
  test.each(['CancelTask', 'GetTask'] as const)(
    'bounds the %s response body',
    async (stalledMethod) => {
      const opened = Promise.withResolvers<AbortSignal>();
      let stalledBody: ReadableStreamDefaultController | undefined;
      const { client } = connect(
        {
          intercept: async (request, method) => {
            if (method === stalledMethod) {
              return new Response(
                new ReadableStream({
                  start(controller) {
                    stalledBody = controller;
                    request.signal.addEventListener(
                      'abort',
                      () => controller.error(request.signal.reason),
                      { once: true },
                    );
                    opened.resolve(request.signal);
                  },
                }),
                { headers: { 'content-type': 'application/json' } },
              );
            }
            if (method !== 'CancelTask') return undefined;
            const body = (await request.clone().json()) as { id: number };
            return Response.json({
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32002, message: 'Task not cancelable' },
            });
          },
        },
        { taskTimeoutMs: 100 },
      );
      const task = await client.send({ text: 'hang' });
      jest.useFakeTimers();
      try {
        const cancellation = task.cancel();
        const signal = await opened.promise;
        jest.advanceTimersByTime(100);
        if (!signal.aborted) stalledBody?.close();
        expect(signal.aborted).toBe(true);
        expect(await cancellation).toMatchObject({ state: 'canceled', cancelConfirmed: false });
      } finally {
        jest.useRealTimers();
      }
    },
  );
});

describe('a cancel the peer refuses as not cancelable', () => {
  test('keeps the local cancellation when the follow-up lookup also fails', async () => {
    const { peer, client } = connect({
      intercept: async (request, method) => {
        if (method === 'GetTask') return new Response('', { status: 500 });
        if (method !== 'CancelTask') return undefined;
        const body = (await request.clone().json()) as { id: number };
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32002, message: 'Task not cancelable' },
        });
      },
    });
    const task = await client.send({ text: 'hang' });

    const outcome = await task.cancel();

    expect(peer.methods()).toContain('GetTask');
    expect(outcome).toMatchObject({ state: 'canceled', cancelConfirmed: false });
  });
});

describe('a peer that cannot be reached', () => {
  test('reports the network failure rather than a timeout', async () => {
    const client = createA2APeerClient({
      url: 'https://peer.example',
      fetch: (async () => {
        throw new TypeError('network down');
      }) as unknown as typeof fetch,
      sleep: immediate,
      attempts: 1,
    });

    const failure = await failureOf(client.card());

    expect(failure.code).toBe('unreachable');
    expect(failure.message).toBe('The peer could not be reached: network down');
  });
});
