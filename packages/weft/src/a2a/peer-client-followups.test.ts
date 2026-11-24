/**
 * COR-1670: review findings of the peer client (COR-905) that needed a misbehaving peer: a card
 * that answers in no text mode, an opening `SendMessage` whose body stalls, and a stream whose first
 * frame names no task.
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
    ...clientOptions,
  });
  return { peer, client };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof A2APeerError) return error.code;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

const outputModes =
  (modes: readonly string[]): ScriptedPeerOptions['card'] =>
  (card) => {
    card.defaultOutputModes = [...modes];
    return card;
  };

const nonStreaming: ScriptedPeerOptions['card'] = (card) => {
  if (card.capabilities !== undefined) card.capabilities.streaming = false;
  return card;
};

/** Headers arrive and the body never does; aborting the request errors the body, as fetch's does. */
function stalledBody(request: Request): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        request.signal.addEventListener('abort', () => controller.error(request.signal.reason));
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

describe('a peer card that lists output modes', () => {
  test('is refused when none is text, since the client accepts back only text/plain', async () => {
    const { peer, client } = connect({ card: outputModes(['application/json', 'image/png']) });

    expect(await codeOf(client.send({ text: 'hi' }))).toBe('content-type-not-supported');
    expect(peer.methods()).not.toContain('SendStreamingMessage');
  });

  test.each([
    { modes: ['application/json', 'text/plain'] },
    { modes: ['text/plain; charset=utf-8'] },
    { modes: ['text/*'] },
    { modes: ['*/*'] },
    { modes: [] },
  ])('is accepted when it lists $modes', async ({ modes }) => {
    const { client } = connect({ card: outputModes(modes) });

    const task = await client.send({ text: 'hi' });
    const outcome = await task.result();

    expect(outcome.state).toBe('completed');
  });
});

describe('the opening non-streaming send', () => {
  test('is bounded by the task timeout when the response body never completes', async () => {
    const { client } = connect(
      {
        card: nonStreaming,
        intercept: (request, method) =>
          method === 'SendMessage' ? stalledBody(request) : undefined,
      },
      { taskTimeoutMs: 30, attempts: 1 },
    );

    expect(await codeOf(client.send({ text: 'hi' }))).toBe('timeout');
  });

  test('ends when the caller aborts while the response body is stalled', async () => {
    const { client } = connect(
      {
        card: nonStreaming,
        intercept: (request, method) =>
          method === 'SendMessage' ? stalledBody(request) : undefined,
      },
      { taskTimeoutMs: 10_000, attempts: 1 },
    );
    const controller = new AbortController();

    const sending = client.send({ text: 'hi', signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller gave up')), 20);

    expect(String(await sending.catch((error: unknown) => error))).toContain('caller gave up');
  });
});

describe('a stream whose first frame names no task', () => {
  test('fails the send as a protocol error rather than returning a task that cannot be canceled', async () => {
    const { peer, client } = connect(
      {
        intercept: (_request, method) =>
          method === 'SendStreamingMessage'
            ? new Response('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', {
                headers: { 'content-type': 'text/event-stream' },
              })
            : undefined,
      },
      { attempts: 1 },
    );

    expect(await codeOf(client.send({ text: 'hi' }))).toBe('protocol');
    expect(peer.methods()).not.toContain('CancelTask');
  });
});

describe('a caller that aborts while a request is backing off', () => {
  test('sends nothing more to the peer, whichever request was retried', async () => {
    let sends = 0;
    const controller = new AbortController();
    const { peer, client } = connect(
      {
        card: nonStreaming,
        intercept: (_request, method) => {
          if (method !== 'SendMessage') return undefined;
          sends += 1;
          return sends === 1 ? new Response('unavailable', { status: 503 }) : undefined;
        },
      },
      {
        attempts: 3,
        // The caller gives up during the backoff; like the real sleep, this resolves on abort.
        sleep: async (_ms, signal) => {
          controller.abort(new Error('caller gave up'));
          if (signal?.aborted !== true) await immediate();
        },
      },
    );

    const outcome = await client.send({ text: 'hi', signal: controller.signal }).then(
      () => 'resolved',
      (error: unknown) => String(error),
    );

    expect(outcome).not.toBe('resolved');
    expect(sends).toBe(1);
    expect(peer.methods().filter((method) => method === 'SendMessage')).toHaveLength(1);
    expect(peer.methods()).not.toContain('CancelTask');
  });
});
