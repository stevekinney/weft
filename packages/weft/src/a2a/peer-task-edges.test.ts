/**
 * Peer task paths that need a misbehaving peer: a stream that closes before answering, a polling
 * peer that answers with a message, a `CancelTask` that leaves the task running, and a failing
 * recovery lookup. A scripted peer answers the rest as the real handler would.
 */
import { describe, expect, test } from 'bun:test';

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
